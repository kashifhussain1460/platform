import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import {
  HR_RETENTION_EVERY_MS,
  HR_RETENTION_JOB,
  HR_RETENTION_QUEUE,
  HR_RETENTION_SCHEDULER,
  type HrRetentionJobData,
} from './hr.constants';
import { HrRetentionService } from './hr-retention.service';

/**
 * In-process BullMQ worker that runs the daily HR data-retention sweep, registered
 * as a repeatable job on boot (same `upsertJobScheduler` pattern as the workflow
 * watchdog). Only instantiated when queue workers are enabled (not on the Vercel
 * serverless entry); scheduling is best-effort — a Redis hiccup at boot must not
 * crash the app.
 */
@Processor(HR_RETENTION_QUEUE)
export class HrRetentionProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(HrRetentionProcessor.name);

  constructor(
    @InjectQueue(HR_RETENTION_QUEUE) private readonly queue: Queue,
    private readonly retention: HrRetentionService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        HR_RETENTION_SCHEDULER,
        { every: HR_RETENTION_EVERY_MS },
        {
          name: HR_RETENTION_JOB,
          data: { retention: true } satisfies HrRetentionJobData,
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      this.logger.warn(
        `Could not register HR retention scheduler: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async process(_job: Job<HrRetentionJobData>): Promise<void> {
    await this.retention.runRetention(new Date());
  }
}
