import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { MarketingSyncService } from './marketing-sync.service';
import {
  MARKETING_SYNC_EVERY_MS,
  MARKETING_SYNC_JOB,
  MARKETING_SYNC_QUEUE,
  MARKETING_SYNC_SCHEDULER,
} from './marketing.constants';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { runInJobContext } from '../../../common/observability/job-context';

/**
 * Reconciliation backstop for the Postiz webhook (docs/architecture/engines/
 * postiz-engine.md §13): Postiz's own webhook is unsigned and has no retry, so
 * this scheduled sweep — not the webhook — is the source of truth for
 * ScheduledPost status. Mirrors ConnectorHealthProcessor's boot-time repeatable
 * job registration exactly.
 */
@Processor(MARKETING_SYNC_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class MarketingSyncProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MarketingSyncProcessor.name);

  constructor(
    @InjectQueue(MARKETING_SYNC_QUEUE) private readonly queue: Queue,
    private readonly sync: MarketingSyncService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        MARKETING_SYNC_SCHEDULER,
        { every: MARKETING_SYNC_EVERY_MS },
        { name: MARKETING_SYNC_JOB, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    } catch (err) {
      this.logger.warn(
        `Could not register marketing-sync scheduler: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async process(job: Job): Promise<void> {
    // Correlation: an AsyncLocalStorage store does not survive the queue
    // hop, so it is re-established here from the job payload.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job): Promise<void> {
    if (job.name !== MARKETING_SYNC_JOB) return;
    // Reconciliation logic lives in MarketingSyncService so the Vercel cron route
    // can drive the identical sweep on serverless (where no worker exists).
    await this.sync.sweep();
  }
}
