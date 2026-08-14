import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { OutboxRelayService } from './outbox-relay.service';
import { ReaperService } from './reaper.service';
import {
  WF_TIMER_QUEUE,
  WF_TIMER_SWEEP_EVERY_MS,
  WF_TIMER_SWEEP_JOB,
  WF_TIMER_SWEEP_SCHEDULER,
} from './workflow-runtime.constants';
import { runInJobContext } from '../../common/observability/job-context';

/**
 * P1-05/P1-06 — the periodic maintenance worker.
 *
 * Concurrency 1 on purpose: two overlapping sweeps would contend on the same
 * expired leases and due timers. The sweeps are individually idempotent, but
 * running one at a time keeps the logs readable and the load predictable.
 *
 * Registers its own repeatable job on boot, the same `upsertJobScheduler`
 * pattern the ConnectorHealthProcessor already uses.
 */
@Processor(WF_TIMER_QUEUE, { concurrency: 1 })
export class WorkflowTimerProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(WorkflowTimerProcessor.name);

  constructor(
    @InjectQueue(WF_TIMER_QUEUE) private readonly queue: Queue,
    private readonly reaper: ReaperService,
    private readonly relay: OutboxRelayService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      WF_TIMER_SWEEP_SCHEDULER,
      { every: WF_TIMER_SWEEP_EVERY_MS },
      { name: WF_TIMER_SWEEP_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
    this.logger.log(
      `workflow timer sweep scheduled every ${WF_TIMER_SWEEP_EVERY_MS}ms`,
    );
  }

  async process(job: Job): Promise<void> {
    // Correlation: an AsyncLocalStorage store does not survive the queue
    // hop, so it is re-established here from the job payload.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job): Promise<void> {
    if (job.name !== WF_TIMER_SWEEP_JOB) return;

    await this.reaper.sweep();

    // Drain the outbox in the same pass. Failures inside relayOnce are logged
    // and the rows stay unpublished for the next sweep — never silently dropped.
    let relayed = 0;
    for (let batch = 0; batch < 10; batch += 1) {
      const n = await this.relay.relayOnce();
      relayed += n;
      if (n === 0) break;
    }

    const lag = await this.relay.lagMs();
    if (lag > 60_000) {
      // The alert threshold from doc 16 §23 — a stale realtime feed means the
      // UI is silently showing the wrong run state.
      this.logger.warn(`outbox lag ${Math.round(lag / 1000)}s exceeds 60s`);
    }
    if (relayed > 0) {
      this.logger.debug(`outbox relayed ${relayed} events`);
    }

    await this.relay.prunePublished();
  }
}
