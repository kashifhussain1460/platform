import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import {
  CONNECTOR_RECONCILE_EVERY_MS,
  CONNECTOR_RECONCILE_JOB,
  CONNECTOR_RECONCILE_QUEUE,
  CONNECTOR_RECONCILE_SCHEDULER,
} from '../events.constants';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { ConnectorReconcileService } from './connector-reconcile.service';
import { runInJobContext } from '../../../common/observability/job-context';

/**
 * In-process BullMQ worker for the scheduled reconciliation sweep (docs §2.3),
 * same WorkerHost style as the EventNormalizeProcessor. On boot it registers a
 * low-frequency (hourly) REPEATABLE job like the workflow SCHEDULE repeatables
 * (idempotent `upsertJobScheduler`), then each firing reconciles all live
 * connectors. Safe offline: the sweep is a no-op when SKILL_EXECUTOR=mock.
 */
@Processor(CONNECTOR_RECONCILE_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class ConnectorReconcileProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(ConnectorReconcileProcessor.name);

  constructor(
    @InjectQueue(CONNECTOR_RECONCILE_QUEUE) private readonly queue: Queue,
    private readonly reconcile: ConnectorReconcileService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        CONNECTOR_RECONCILE_SCHEDULER,
        { every: CONNECTOR_RECONCILE_EVERY_MS },
        {
          name: CONNECTOR_RECONCILE_JOB,
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      // A Redis hiccup at boot must not crash the app; reconcile is best-effort.
      this.logger.warn(
        `Could not register connector-reconcile scheduler: ${
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
    if (job.name !== CONNECTOR_RECONCILE_JOB) {
      return;
    }
    const { reconciled } = await this.reconcile.sweep();
    this.logger.debug(`connector-reconcile sweep caught up ${reconciled} event(s)`);
  }
}
