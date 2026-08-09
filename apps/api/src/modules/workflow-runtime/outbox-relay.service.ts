import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/** How many rows one relay pass publishes. */
const RELAY_BATCH = 200;
/** Published rows are pruned after this long — the outbox is a QUEUE, not a log. */
const PRUNE_PUBLISHED_AFTER_MS = 24 * 60 * 60_000;

export interface RunEventEnvelope {
  /** Monotonic per run. The field is `seq`, NOT `sequence` (doc 14 §14.B.7). */
  seq: number;
  runId: string;
  companyId: string;
  type: string;
  emittedAt: string;
  data: Record<string, unknown>;
}

/** A sink the relay publishes to (WebSocket gateway, bus, …). */
export interface RunEventSink {
  publish(events: RunEventEnvelope[]): Promise<void>;
}

/**
 * P1-06 — the transactional-outbox relay (doc 16 §17).
 *
 * Reads unpublished rows in `id` order and hands them to a sink, then marks
 * them published. Ordering comes from the database's BigInt autoincrement, not
 * from workers racing each other, which is what makes `seq` trustworthy enough
 * for a client to detect a gap and re-fetch.
 *
 * Delivery is AT-LEAST-ONCE by design: the publish happens before the
 * `publishedAt` write, so a crash in between re-publishes. Consumers must
 * tolerate duplicates — that is strictly safer than at-most-once, where a
 * crash silently loses a run's completion event.
 *
 * With no sink registered the relay still drains and marks rows published, so
 * the table cannot grow unbounded before the WebSocket gateway ships.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);
  private sink: RunEventSink | null = null;

  constructor(private readonly prisma: PrismaService) {}

  registerSink(sink: RunEventSink): void {
    this.sink = sink;
  }

  /** Publish one batch. Returns how many rows were relayed. */
  async relayOnce(): Promise<number> {
    const rows = await this.prisma.runEventOutbox.findMany({
      where: { publishedAt: null },
      orderBy: { id: 'asc' },
      take: RELAY_BATCH,
    });
    if (rows.length === 0) return 0;

    const events: RunEventEnvelope[] = rows.map((row) => ({
      seq: Number(row.id),
      runId: row.runId,
      companyId: row.companyId,
      type: row.eventType,
      emittedAt: row.createdAt.toISOString(),
      data: (row.payload ?? {}) as Record<string, unknown>,
    }));

    if (this.sink) {
      try {
        await this.sink.publish(events);
      } catch (error) {
        // Do NOT mark published — leave the rows for the next pass. Swallowing
        // this would silently drop run events with no way to notice.
        this.logger.error(
          `outbox sink failed; ${events.length} events will be retried: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 0;
      }
    }

    await this.prisma.runEventOutbox.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { publishedAt: new Date() },
    });
    return rows.length;
  }

  /**
   * Delete long-published rows. Not optional: at the design target of ~5M
   * events/day an unpruned outbox becomes the largest table in the database
   * within a month, and the relay's own query degrades with it.
   */
  async prunePublished(): Promise<number> {
    const cutoff = new Date(Date.now() - PRUNE_PUBLISHED_AFTER_MS);
    const { count } = await this.prisma.runEventOutbox.deleteMany({
      where: { publishedAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`outbox pruned ${count} published rows`);
    }
    return count;
  }

  /** Oldest unpublished age in ms — the lag metric to alert on (doc 16 §23). */
  async lagMs(): Promise<number> {
    const oldest = await this.prisma.runEventOutbox.findFirst({
      where: { publishedAt: null },
      orderBy: { id: 'asc' },
      select: { createdAt: true },
    });
    return oldest ? Date.now() - oldest.createdAt.getTime() : 0;
  }
}
