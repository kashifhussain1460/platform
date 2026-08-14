import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RESILIENCE_REDIS } from '../../common/resilience/redis.provider';
import { Observable, Subject, concat, filter, from, map, mergeMap } from 'rxjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  RunEventEnvelope,
  RunEventSink,
} from '../workflow-runtime/outbox-relay.service';

/**
 * One channel for every run event.
 *
 * Not per-run: a channel per run would mean a SUBSCRIBE/UNSUBSCRIBE round trip
 * on every stream open and close, and Redis pattern-matching across thousands of
 * short-lived channels. Volume here is low (one message per step transition) and
 * each instance drops what it has no subscriber for, which is one map lookup.
 */
const RUN_EVENT_CHANNEL = 'orlixa:run-events';

/**
 * WAVE 5 §5.5 — fan run events out to connected clients.
 *
 * Implements the `RunEventSink` seam the outbox relay already exposed but that
 * nothing ever filled, so the relay drained straight to `/dev/null` and the UI
 * had no option but to poll once a second.
 *
 * **Multi-instance via Redis pub/sub.** An HTTP subscriber is only reachable
 * from the process holding its connection, so a purely in-process fan-out means
 * a client connected to instance A never sees an event relayed by instance B.
 * Every instance therefore publishes to one Redis channel and subscribes to it,
 * and delivery happens ONLY from the subscription — including for the instance
 * that published, so there is exactly one delivery path rather than two that
 * can disagree.
 *
 * Local delivery is UNCONDITIONAL and Redis is purely additive: a locally
 * connected subscriber is served whether or not Redis is reachable, and the
 * publish only exists to reach subscribers on OTHER instances. Correctness never
 * rested on the live path anyway — `history()` plus the client's `seq` is what
 * makes a missed event recoverable.
 */
@Injectable()
export class RunEventStreamService
  implements RunEventSink, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RunEventStreamService.name);
  /** runId → live subscribers in THIS process. */
  private readonly channels = new Map<string, Subject<RunEventEnvelope>>();
  /** A DEDICATED connection: ioredis forbids normal commands while subscribed. */
  private subscriber: Redis | null = null;
  /** Identifies this process, so it can ignore the echo of its own publish. */
  private readonly instanceId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(RESILIENCE_REDIS)
    private readonly redis: Redis | null = null,
  ) {}

  onModuleInit(): void {
    if (!this.redis) {
      this.logger.log('realtime: no Redis — single-instance fan-out only');
      return;
    }
    // `duplicate()` inherits the configured connection without re-reading env.
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (err) =>
      this.logger.debug(`realtime subscriber error: ${err.message}`),
    );
    this.subscriber.on('message', (_channel, payload) => {
      try {
        const message = JSON.parse(payload) as {
          from?: string;
          event: RunEventEnvelope;
        };
        // Skip our OWN publication: this instance already delivered it locally.
        // Tagging by instance is exact, where relying on the stream's `seq`
        // de-duplication would only work by accident.
        if (message.from === this.instanceId) return;
        this.channels.get(message.event.runId)?.next(message.event);
      } catch {
        // A malformed message must never take the stream down.
      }
    });
    // NOT awaited. `onModuleInit` blocks application boot, and the resilience
    // client is configured to fail fast rather than queue while disconnected —
    // so awaiting a SUBSCRIBE against an unreachable Redis would hang startup.
    // Realtime is an optimisation layered on the `history()` catch-up read; it
    // must never be able to stop the API coming up.
    void this.subscriber.subscribe(RUN_EVENT_CHANNEL).catch((err: Error) => {
      this.logger.warn(
        `realtime: could not subscribe, falling back to local fan-out — ${err.message}`,
      );
      this.subscriber = null;
    });
  }

  async onModuleDestroy(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = null;
    if (!subscriber) return;

    // UNSUBSCRIBE before QUIT. A connection in subscriber mode will not process
    // `quit()` while it still holds a subscription, so the socket stays open —
    // which showed up as Jest refusing to exit after the suite passed, and would
    // equally have held a worker open on a rolling deploy instead of draining.
    // `disconnect()` is the backstop: shutdown must not be able to hang.
    // `disconnect()`, not `quit()`. A subscriber holds no in-flight writes to
    // flush, so there is nothing a graceful QUIT protects — and a connection in
    // subscriber mode will not process QUIT while subscribed, leaving the socket
    // open. That showed up as Jest refusing to exit after a passing suite, and
    // would equally have held a worker open on a rolling deploy instead of
    // draining. Closing outright is both correct and unable to hang.
    subscriber.removeAllListeners();
    subscriber.disconnect();
  }

  /**
   * Called by the relay for every batch it publishes.
   *
   * Publishes to Redis and lets the SUBSCRIPTION deliver, including back to this
   * process — one delivery path, so a client cannot receive an event twice from
   * two mechanisms that disagree about ordering. Falls back to local fan-out
   * when Redis is absent or the publish fails.
   */
  async publish(events: RunEventEnvelope[]): Promise<void> {
    for (const event of events) {
      // ALWAYS deliver locally first, unconditionally.
      //
      // The first cut delivered locally only when the Redis publish failed. That
      // looks symmetrical and is a trap: if SUBSCRIBE had quietly failed while
      // PUBLISH still succeeded, the event went to a channel nobody was
      // listening on and the local fallback was skipped — delivered nowhere, with
      // no error. Local delivery must not depend on a remote component's health.
      this.channels.get(event.runId)?.next(event);

      // Then tell the OTHER instances. Failure here costs cross-instance
      // latency (clients fall back to the `?after=` catch-up read), never a
      // locally-connected subscriber.
      if (!this.redis) continue;
      try {
        await this.redis.publish(
          RUN_EVENT_CHANNEL,
          JSON.stringify({ from: this.instanceId, event }),
        );
      } catch (err) {
        this.logger.debug(
          `realtime cross-instance publish failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Everything recorded for a run so far, oldest first. */
  async history(
    companyId: string,
    runId: string,
    afterSeq = 0,
  ): Promise<RunEventEnvelope[]> {
    await this.assertOwnedRun(companyId, runId);
    const rows = await this.prisma.runEventOutbox.findMany({
      where: { runId, companyId, ...(afterSeq ? { id: { gt: afterSeq } } : {}) },
      orderBy: { id: 'asc' },
      take: 500,
    });
    return rows.map(toEnvelope);
  }

  /**
   * Catch-up, then live.
   *
   * `concat` is the important part: the replay is emitted BEFORE the live
   * subscription's output, and the subscription is created first, so an event
   * arriving during the replay is queued rather than dropped. Subscribing after
   * the replay would leave a window where a step could complete unseen — which
   * is precisely the bug a client cannot detect, because nothing tells it an
   * event is missing.
   */
  subscribe(
    companyId: string,
    runId: string,
    afterSeq = 0,
  ): Observable<MessageEvent> {
    const channel = this.channelFor(runId);
    let lastSeq = afterSeq;

    const replay = from(this.history(companyId, runId, afterSeq)).pipe(
      mergeMap((events) => events),
    );

    return concat(replay, channel).pipe(
      // A late duplicate from the replay/live overlap is dropped by seq. The
      // relay is at-least-once by design, so consumers must tolerate repeats.
      filter((event) => {
        if (event.seq <= lastSeq) return false;
        lastSeq = event.seq;
        return true;
      }),
      map(
        (event): MessageEvent => ({
          // The SSE event id: browsers send it back as `Last-Event-ID` on
          // reconnect, which is what makes recovery automatic.
          id: String(event.seq),
          type: event.type,
          data: event,
        }),
      ),
    );
  }

  private channelFor(runId: string): Subject<RunEventEnvelope> {
    let channel = this.channels.get(runId);
    if (!channel) {
      channel = new Subject<RunEventEnvelope>();
      this.channels.set(runId, channel);
    }
    return channel;
  }

  /**
   * Tenant scoping, checked ONCE at subscribe time and enforced again by the
   * `companyId` filter on every read. A stream keyed only by runId would let
   * anyone who learns an id watch another tenant's execution live.
   */
  private async assertOwnedRun(companyId: string, runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId, companyId },
      select: { id: true },
    });
    if (!run) throw new NotFoundException('Workflow run not found');
  }
}

function toEnvelope(row: {
  id: bigint;
  runId: string;
  companyId: string;
  eventType: string;
  createdAt: Date;
  payload: unknown;
}): RunEventEnvelope {
  return {
    seq: Number(row.id),
    runId: row.runId,
    companyId: row.companyId,
    type: row.eventType,
    emittedAt: row.createdAt.toISOString(),
    data: (row.payload ?? {}) as Record<string, unknown>,
  };
}
