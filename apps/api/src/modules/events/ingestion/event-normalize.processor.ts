import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Prisma, type CanonicalEvent } from '@prisma/client';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WorkflowsService } from '../../workflows/workflows.service';
import {
  EVENT_NORMALIZE_JOB,
  EVENT_NORMALIZE_QUEUE,
  type NormalizeJobData,
} from '../events.constants';
import { mapRawEvent } from '../normalization/event-mapper';
import { toQueueError } from '../../../common/resilience/queue-retry';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { runInJobContext } from '../../../common/observability/job-context';

/** Prisma Json helper: JS null → the DB JSON-null sentinel. */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/**
 * In-process BullMQ worker that NORMALIZES a RawEvent (same WorkerHost style as
 * the knowledge IngestionProcessor). For one RawEvent:
 *   1. a provider MAPPER (pure fn) produces { type, dedupeKey, occurredAt?, … };
 *   2. a CanonicalEvent is IDEMPOTENTLY upserted on (companyId, dedupeKey);
 *   3. the RawEvent flips to NORMALIZED (or FAILED + error on a mapper throw);
 *   4. WorkflowsService.fireEvent drives ACTIVE EVENT workflows — but ONLY when a
 *      NEW canonical event was created, so a re-delivery never double-fires runs.
 *
 * A mapper/DB failure marks the RawEvent FAILED and rethrows so BullMQ records
 * the failure (mirrors the ingestion processor). A `fireEvent` failure is caught
 * and logged — a downstream workflow error must not fail (or replay) normalization.
 * The RECEIVED guard makes retries safe: an already-NORMALIZED raw event is skipped.
 */
@Processor(EVENT_NORMALIZE_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class EventNormalizeProcessor extends WorkerHost {
  private readonly logger = new Logger(EventNormalizeProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflows: WorkflowsService,
  ) {
    super();
  }

  async process(job: Job<NormalizeJobData>): Promise<void> {
    // Correlation: an AsyncLocalStorage store does not survive the queue
    // hop, so it is re-established here from the job payload.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job<NormalizeJobData>): Promise<void> {
    if (job.name !== EVENT_NORMALIZE_JOB) {
      return;
    }
    const { rawEventId } = job.data;
    const raw = await this.prisma.rawEvent.findUnique({
      where: { id: rawEventId },
    });
    if (!raw) {
      this.logger.warn(`Normalize job for missing RawEvent ${rawEventId}`);
      return;
    }
    // Idempotency: only a RECEIVED raw event is normalized (re-runs are no-ops,
    // so workflows never fire twice for the same delivery).
    if (raw.status !== 'RECEIVED') {
      this.logger.debug(`RawEvent ${rawEventId} is ${raw.status}, skipping`);
      return;
    }

    try {
      const mapping = mapRawEvent({
        provider: raw.provider,
        externalId: raw.externalId,
        headers: raw.headers as Record<string, unknown> | null,
        payload: raw.payload as Record<string, unknown> | null,
      });

      // Idempotent create on the (companyId, dedupeKey) unique index.
      let canonical: CanonicalEvent | null =
        await this.prisma.canonicalEvent.findUnique({
          where: {
            companyId_dedupeKey: {
              companyId: raw.companyId,
              dedupeKey: mapping.dedupeKey,
            },
          },
        });
      let created = false;
      if (!canonical) {
        try {
          canonical = await this.prisma.canonicalEvent.create({
            data: {
              companyId: raw.companyId,
              connectorId: raw.connectorId,
              rawEventId: raw.id,
              provider: raw.provider,
              type: mapping.type,
              dedupeKey: mapping.dedupeKey,
              occurredAt: mapping.occurredAt,
              subject: toJson(mapping.subject),
              data: toJson(mapping.data),
            },
          });
          created = true;
        } catch (err) {
          // Lost a create race with a concurrent normalization → reuse the winner.
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            canonical = await this.prisma.canonicalEvent.findUnique({
              where: {
                companyId_dedupeKey: {
                  companyId: raw.companyId,
                  dedupeKey: mapping.dedupeKey,
                },
              },
            });
          } else {
            throw err;
          }
        }
      }

      await this.prisma.rawEvent.update({
        where: { id: raw.id },
        data: { status: 'NORMALIZED', error: null },
      });

      // Drive ACTIVE EVENT workflows — only for a freshly-created canonical event.
      if (created && canonical) {
        try {
          await this.workflows.fireEvent(raw.companyId, canonical.type, {
            eventId: canonical.id,
            subject: canonical.subject ?? null,
            data: canonical.data ?? null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `fireEvent failed for canonical ${canonical.id} (${canonical.type}): ${message}`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Normalize failed for RawEvent ${raw.id}: ${message}`);
      await this.prisma.rawEvent.update({
        where: { id: raw.id },
        data: { status: 'FAILED', error: message },
      });
      // Terminal (unmappable/validation) → DLQ immediately; transient → backoff.
      throw toQueueError(err);
    }
  }
}
