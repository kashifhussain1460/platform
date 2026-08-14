import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import {
  WORKFLOW_RUN_QUEUE,
  WORKFLOW_RUN_WATCHDOG_EVERY_MS,
  WORKFLOW_RUN_WATCHDOG_JOB,
  WORKFLOW_RUN_WATCHDOG_SCHEDULER,
  type WorkflowRunJobData,
} from '../workflows.constants';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { WorkflowEngine } from './workflow-engine.service';
import { runInJobContext } from '../../../common/observability/job-context';

/**
 * In-process BullMQ worker that executes queued workflow jobs by delegating to
 * the WorkflowEngine (same WorkerHost style as the knowledge IngestionProcessor).
 *
 * Job shapes that flow through the same queue:
 * - `{ runId }`     — an already-created run (MANUAL/EVENT/WEBHOOK). Existing path.
 * - `{ runId, resume: true }` — resume a WAITING run whose APPROVAL was approved.
 * - `{ workflowId, source }` — a SCHEDULE/repeatable fire: create a run (with
 *   that source) then execute it.
 * - `{ watchdog: true }` — repeatable stuck-run sweep, registered on boot below
 *   (same `upsertJobScheduler` pattern as ConnectorHealthProcessor).
 *
 * The engine owns all status transitions and error handling, so this handler
 * stays thin — a node failure is recorded as a FAILED run (a terminal domain
 * outcome the poller reads), not a thrown job error.
 */
@Processor(WORKFLOW_RUN_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class WorkflowProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(WorkflowProcessor.name);

  constructor(
    @InjectQueue(WORKFLOW_RUN_QUEUE) private readonly queue: Queue,
    private readonly engine: WorkflowEngine,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        WORKFLOW_RUN_WATCHDOG_SCHEDULER,
        { every: WORKFLOW_RUN_WATCHDOG_EVERY_MS },
        {
          name: WORKFLOW_RUN_WATCHDOG_JOB,
          data: { watchdog: true },
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      // A Redis hiccup at boot must not crash the app; the sweep is best-effort.
      this.logger.warn(
        `Could not register workflow-run watchdog scheduler: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async process(job: Job<WorkflowRunJobData>): Promise<void> {
    // Correlation: an AsyncLocalStorage store does not survive the queue
    // hop, so it is re-established here from the job payload.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job<WorkflowRunJobData>): Promise<void> {
    const data = job.data;
    if ('watchdog' in data && data.watchdog) {
      const { swept } = await this.engine.sweepStuckRuns();
      if (swept > 0) {
        this.logger.warn(`workflow-run watchdog swept ${swept} orphaned run(s)`);
      }
      return;
    }
    if ('runId' in data && data.runId) {
      if (data.resume) {
        this.logger.debug(`Resuming workflow run ${data.runId}`);
        await this.engine.resume(data.runId);
        return;
      }
      this.logger.debug(`Executing workflow run ${data.runId}`);
      await this.engine.execute(data.runId);
      return;
    }
    if ('workflowId' in data && data.workflowId) {
      const source = data.source ?? 'SCHEDULE';
      this.logger.debug(
        `Triggered workflow ${data.workflowId} (source=${source})`,
      );
      await this.engine.trigger(data.workflowId, source);
      return;
    }
    this.logger.warn(`Ignoring workflow job with unrecognised data shape`);
  }
}
