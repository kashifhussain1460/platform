import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { ConnectorHealthService } from './connector-health.service';
import {
  CONNECTOR_HEALTH_EVERY_MS,
  CONNECTOR_HEALTH_JOB,
  CONNECTOR_HEALTH_QUEUE,
  CONNECTOR_HEALTH_SCHEDULER,
} from './connector.constants';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { runInJobContext } from '../../../common/observability/job-context';

/**
 * In-process BullMQ worker for the scheduled active health sweep (docs §1.8),
 * same WorkerHost style as the knowledge IngestionProcessor. On boot it registers
 * a REPEATABLE job (~every 10 min) exactly like the workflow SCHEDULE repeatables
 * (idempotent `upsertJobScheduler`), then each firing sweeps all live connectors.
 *
 * Safe offline: ConnectorHealthService.sweep() is a no-op when SKILL_EXECUTOR=mock
 * (the test/default mode), so this never hits the network during the suite.
 */
@Processor(CONNECTOR_HEALTH_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class ConnectorHealthProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(ConnectorHealthProcessor.name);

  constructor(
    @InjectQueue(CONNECTOR_HEALTH_QUEUE) private readonly queue: Queue,
    private readonly health: ConnectorHealthService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        CONNECTOR_HEALTH_SCHEDULER,
        { every: CONNECTOR_HEALTH_EVERY_MS },
        {
          name: CONNECTOR_HEALTH_JOB,
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      // A Redis hiccup at boot must not crash the app; the sweep is best-effort.
      this.logger.warn(
        `Could not register connector-health scheduler: ${
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
    if (job.name !== CONNECTOR_HEALTH_JOB) {
      return;
    }
    const { probed } = await this.health.sweep();
    this.logger.debug(`connector-health sweep probed ${probed} connector(s)`);
  }
}
