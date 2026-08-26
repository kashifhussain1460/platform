import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../common/resilience/queue-concurrency.constants';
import {
  CREDIT_RESERVATION_SWEEP_EVERY_MS,
  CREDIT_RESERVATION_SWEEP_JOB,
  CREDIT_RESERVATION_SWEEP_QUEUE,
  CREDIT_RESERVATION_SWEEP_SCHEDULER,
  type CreditReservationSweepJobData,
} from './credit-reservation-sweep.constants';
import { CreditReservationSweepService } from './credit-reservation-sweep.service';

/**
 * Repeatable reservation-leak sweep worker, registered on boot with the same
 * `upsertJobScheduler` pattern as the approval-SLA sweep
 * (`approval-sla.processor.ts`). Only instantiated when queue workers are
 * enabled; scheduling is best-effort (a Redis hiccup at boot must not crash
 * the app).
 */
@Processor(CREDIT_RESERVATION_SWEEP_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class CreditReservationSweepProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(CreditReservationSweepProcessor.name);

  constructor(
    @InjectQueue(CREDIT_RESERVATION_SWEEP_QUEUE) private readonly queue: Queue,
    private readonly sweepService: CreditReservationSweepService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        CREDIT_RESERVATION_SWEEP_SCHEDULER,
        { every: CREDIT_RESERVATION_SWEEP_EVERY_MS },
        {
          name: CREDIT_RESERVATION_SWEEP_JOB,
          data: { sweep: true } satisfies CreditReservationSweepJobData,
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      this.logger.warn(
        `Could not register credit-reservation-sweep scheduler: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async process(_job: Job<CreditReservationSweepJobData>): Promise<void> {
    await this.sweepService.sweep();
  }
}
