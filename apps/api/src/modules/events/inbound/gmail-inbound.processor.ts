import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import {
  GMAIL_INBOUND_EVERY_MS,
  GMAIL_INBOUND_JOB,
  GMAIL_INBOUND_QUEUE,
  GMAIL_INBOUND_SCHEDULER,
} from '../events.constants';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { GmailInboundService } from './gmail-inbound.service';
import { runInJobContext } from '../../../common/observability/job-context';

/**
 * In-process BullMQ worker for the Gmail INBOUND poll sweep (the near-real-time
 * inbound driver), same WorkerHost style as the reconcile/health processors. On
 * boot it registers a ~60s REPEATABLE job (idempotent `upsertJobScheduler`); each
 * firing polls every CONNECTED gmail connector across tenants. Safe when Redis is
 * up but no gmail connector is connected (offline tests) — the sweep finds none
 * and does nothing; per-connector errors are already swallowed by `poll`.
 */
@Processor(GMAIL_INBOUND_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class GmailInboundProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(GmailInboundProcessor.name);

  constructor(
    @InjectQueue(GMAIL_INBOUND_QUEUE) private readonly queue: Queue,
    private readonly inbound: GmailInboundService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        GMAIL_INBOUND_SCHEDULER,
        { every: GMAIL_INBOUND_EVERY_MS },
        {
          name: GMAIL_INBOUND_JOB,
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      // A Redis hiccup at boot must not crash the app; inbound poll is best-effort.
      this.logger.warn(
        `Could not register gmail-inbound scheduler: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async process(job: Job): Promise<void> {
    // Correlation: an AsyncLocalStorage store does not survive the queue
    // hop, so it is re-established here from the job payload.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job): Promise<void> {
    if (job.name !== GMAIL_INBOUND_JOB) {
      return;
    }
    const { polled, newMessages, firedRuns } = await this.inbound.sweep();
    if (polled > 0) {
      this.logger.debug(
        `gmail-inbound sweep: polled ${polled} connector(s), ${newMessages} new, ${firedRuns} run(s) fired`,
      );
    }
  }
}
