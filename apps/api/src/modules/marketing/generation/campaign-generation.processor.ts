import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { CampaignGenerationService } from './campaign-generation.service';
import {
  CAMPAIGN_GENERATION_EVERY_MS,
  CAMPAIGN_GENERATION_JOB,
  CAMPAIGN_GENERATION_QUEUE,
  CAMPAIGN_GENERATION_SCHEDULER,
} from './campaign-generation.constants';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { runInJobContext } from '../../../common/observability/job-context';

/**
 * Worker-side driver for campaign generation. Mirrors MarketingSyncProcessor's
 * shape exactly, including boot-time repeatable registration.
 *
 * ## Why a job AND a repeatable sweep
 *
 * The per-campaign job is the fast path: it loops `advance()` until that
 * campaign is done, so a customer watching the progress screen sees it fill in
 * without waiting for a tick. The repeatable sweep is the SAFETY NET — it picks
 * up any campaign left mid-generation because a worker died, a job was lost, or
 * the deployment had no worker at the time generation started.
 *
 * Without the sweep, a process killed halfway through a 21-item campaign would
 * leave it in GENERATING with nothing scheduled to ever touch it again — the
 * same orphaned-run failure the workflow watchdog exists to catch.
 */
@Processor(CAMPAIGN_GENERATION_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class CampaignGenerationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(CampaignGenerationProcessor.name);

  /**
   * Upper bound on passes inside ONE job, so a campaign that somehow never
   * reports completion cannot spin forever holding a worker slot. The sweep
   * picks up anything left over.
   */
  private static readonly MAX_PASSES = 60;

  constructor(
    @InjectQueue(CAMPAIGN_GENERATION_QUEUE) private readonly queue: Queue,
    private readonly generation: CampaignGenerationService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        CAMPAIGN_GENERATION_SCHEDULER,
        { every: CAMPAIGN_GENERATION_EVERY_MS },
        {
          name: CAMPAIGN_GENERATION_JOB,
          opts: { removeOnComplete: true, removeOnFail: 100 },
        },
      );
    } catch (err) {
      this.logger.warn(
        `Could not register campaign-generation scheduler: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async process(job: Job): Promise<void> {
    // An AsyncLocalStorage store does not survive the queue hop; re-established
    // from the job payload so logs stay correlated.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job): Promise<void> {
    if (job.name !== CAMPAIGN_GENERATION_JOB) return;

    const campaignId = (job.data as { campaignId?: string } | undefined)?.campaignId;

    // No campaignId = the repeatable sweep tick.
    if (!campaignId) {
      await this.generation.sweep();
      return;
    }

    for (let pass = 0; pass < CampaignGenerationProcessor.MAX_PASSES; pass += 1) {
      const result = await this.generation.advance(campaignId);
      if (!result.more) return;
    }
    this.logger.warn(
      `Campaign ${campaignId} still generating after ${CampaignGenerationProcessor.MAX_PASSES} ` +
        'passes; leaving it for the sweep.',
    );
  }
}
