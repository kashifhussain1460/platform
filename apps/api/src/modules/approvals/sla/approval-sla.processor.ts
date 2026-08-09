import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import {
  APPROVAL_SLA_QUEUE,
  APPROVAL_SLA_SCHEDULER,
  APPROVAL_SLA_SWEEP_EVERY_MS,
  APPROVAL_SLA_SWEEP_JOB,
  type ApprovalSlaJobData,
} from './approval-sla.constants';
import { ApprovalSlaService } from './approval-sla.service';

/**
 * Repeatable approval-SLA sweep worker (P3-05 §8.2) — registered on boot with the
 * same `upsertJobScheduler` pattern as the workflow-run watchdog
 * (`workflow.processor.ts`). Only instantiated when queue workers are enabled (not
 * on the Vercel serverless entry); scheduling is best-effort (a Redis hiccup at
 * boot must not crash the app).
 */
@Processor(APPROVAL_SLA_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class ApprovalSlaProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ApprovalSlaProcessor.name);

  constructor(
    @InjectQueue(APPROVAL_SLA_QUEUE) private readonly queue: Queue,
    private readonly sla: ApprovalSlaService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        APPROVAL_SLA_SCHEDULER,
        { every: APPROVAL_SLA_SWEEP_EVERY_MS },
        {
          name: APPROVAL_SLA_SWEEP_JOB,
          data: { sweep: true } satisfies ApprovalSlaJobData,
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      this.logger.warn(
        `Could not register approval-sla scheduler: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async process(_job: Job<ApprovalSlaJobData>): Promise<void> {
    const { processed } = await this.sla.sweep();
    if (processed > 0) {
      this.logger.warn(`approval-sla sweep processed ${processed} breach(es)`);
    }
  }
}
