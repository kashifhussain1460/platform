import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import {
  PLATFORM_SWEEPS,
  PLATFORM_SWEEPS_QUEUE,
  schedulerIdFor,
  type PlatformSweepJobData,
} from './platform-sweeps.constants';
import { PlatformSweepsService } from './platform-sweeps.service';

/**
 * Registers a BullMQ repeatable for each of the eight periodic sweeps that had
 * no queue of their own — see `platform-sweeps.constants.ts` for the list and
 * why it existed.
 *
 * Same shape as `ApprovalSlaProcessor` and the workflow-run watchdog: only
 * instantiated when queue workers are enabled, `upsertJobScheduler` is
 * idempotent so re-registering on every boot is safe, and a Redis hiccup at
 * boot logs a warning rather than crashing the app.
 *
 * Concurrency is deliberately the default rather than 1: these eight are
 * cadence-staggered in the constants file precisely so they do not collide, and
 * pinning the queue to one worker would make a slow `data-retention` sweep
 * delay `alerts` behind it.
 */
@Processor(PLATFORM_SWEEPS_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class PlatformSweepsProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(PlatformSweepsProcessor.name);

  constructor(
    @InjectQueue(PLATFORM_SWEEPS_QUEUE) private readonly queue: Queue,
    private readonly sweeps: PlatformSweepsService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    for (const definition of PLATFORM_SWEEPS) {
      try {
        await this.queue.upsertJobScheduler(
          schedulerIdFor(definition.job),
          definition.cron ? { pattern: definition.cron, tz: 'UTC' } : { every: definition.every! },
          {
            name: definition.job,
            data: { job: definition.job } satisfies PlatformSweepJobData,
            opts: { removeOnComplete: true, removeOnFail: 100 },
          },
        );
      } catch (err) {
        this.logger.warn(
          `Could not register platform sweep "${definition.job}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.logger.log(
      `platform sweeps registered: ${PLATFORM_SWEEPS.map((s) => s.job).join(', ')}`,
    );
  }

  async process(job: Job<PlatformSweepJobData>): Promise<void> {
    const name = job.data.job;
    const started = Date.now();
    const result = await this.sweeps.run(name);
    this.logger.log(
      `platform sweep "${name}" finished in ${Date.now() - started}ms: ${JSON.stringify(result)}`,
    );
  }
}
