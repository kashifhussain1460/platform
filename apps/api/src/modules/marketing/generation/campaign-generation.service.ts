import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CampaignStatus, ContentItemStatus, CreativeVariantStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { isInlineExecution } from '../../../common/resilience/workflow-execution-mode';
import {
  CAMPAIGN_GENERATION_JOB,
  CAMPAIGN_GENERATION_QUEUE,
} from './campaign-generation.constants';
import { extractJson } from '../../../common/json/extract-json';
import { LLM_PROVIDER_TOKEN, type LlmProvider } from '../../employees/llm/llm.provider';
import { AuditLogService } from '../../audit/audit-log.service';
import {
  DEFAULT_CONTENT_PILLARS,
  planContentCalendar,
  CampaignPlanError,
} from '../planning/campaign-planner';
import {
  buildPlanPrompt,
  buildVariantsPrompt,
  buildVariantsRequest,
  type BrandContext,
} from './marketing-prompts';
import {
  VariantValidationError,
  validateCampaignPlan,
  validateVariantSet,
} from './variant-validation';

/**
 * How many content items one call generates variants for.
 *
 * This is the whole reason generation is incremental rather than a single
 * pass. A 21-item campaign is 21 model calls; the Vercel function ceiling is
 * 300s (`apps/api/vercel.json`). Doing the lot in one invocation would time
 * out somewhere in the middle and leave the campaign wedged. Instead each call
 * advances a bounded amount and returns whether work remains, so a worker tick
 * or a cron tick can be run repeatedly until done.
 */
export const ITEMS_PER_PASS = 3;

/** Result of one unit of work, so the caller knows whether to come back. */
export interface AdvanceResult {
  campaignId: string;
  status: CampaignStatus;
  /** True when this campaign still has work left. */
  more: boolean;
  /** What this pass actually did, for logs and the progress UI. */
  detail: string;
}

/**
 * The campaign generation state machine (architecture doc §76).
 *
 *   DRAFT -> ANALYZING -> PLANNING -> GENERATING -> READY_FOR_REVIEW
 *
 * MEDIA_GENERATING and QUALITY_CHECK are deliberately NOT implemented yet:
 * §103/§104 put media generation AFTER variant selection, and there is no media
 * provider wired. Passing through a state that does nothing would be worse than
 * not claiming it — a customer watching progress would see "Media" tick green
 * having generated nothing.
 *
 * ## Why this is a service and not a processor
 *
 * Identical to `MarketingSyncService`: the logic lives here so BOTH the BullMQ
 * worker (where one exists) and the `/admin/cron/*` route (serverless, where one
 * does not) drive exactly the same code. Neither deployment shape gets a
 * different implementation.
 */
@Injectable()
export class CampaignGenerationService {
  private readonly logger = new Logger(CampaignGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
    private readonly auditLog: AuditLogService,
    /**
     * Optional so unit tests can construct the service without a Redis-backed
     * queue, and so an inline deployment that registers no queue still works.
     */
    @InjectQueue(CAMPAIGN_GENERATION_QUEUE) private readonly queue?: Queue,
  ) {}

  /**
   * Kick generation off for a campaign in DRAFT.
   *
   * Returns as soon as the work is ACCEPTED, never when it is finished (74):
   * a 21-item campaign is 21 model calls and must not be held open in the
   * request that asked for it.
   *
   * How it then runs depends on the deployment shape, exactly like workflow
   * execution:
   *   - queue mode  -> a BullMQ job drives it, plus the repeatable sweep as a
   *                    safety net if that job is lost.
   *   - inline mode -> serverless, no worker. ONE pass runs in this request so
   *                    the customer sees immediate movement, and the
   *                    /admin/cron/campaign-generation sweep carries it the
   *                    rest of the way.
   */
  async start(companyId: string, campaignId: string): Promise<AdvanceResult> {
    const claimed = await this.prisma.campaign.updateMany({
      where: { id: campaignId, companyId, status: CampaignStatus.DRAFT },
      data: {
        status: CampaignStatus.ANALYZING,
        generationStartedAt: new Date(),
        generationFinishedAt: null,
        generationError: null,
      },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.campaign.findFirst({
        where: { id: campaignId, companyId },
        select: { status: true },
      });
      if (!current) throw new Error('Campaign not found for this company');
      // Not an error: asking twice should be safe, and the caller can see the
      // state it is already in.
      return {
        campaignId,
        status: current.status,
        more: false,
        detail: `Generation was already started; the campaign is ${current.status}.`,
      };
    }

    await this.auditLog.record({
      companyId,
      action: 'marketing.campaign.generation_started',
      entityType: 'Campaign',
      entityId: campaignId,
    });

    if (isInlineExecution() || !this.queue) {
      // One pass now so the progress screen is not empty; the cron sweep
      // continues from here.
      return this.advance(campaignId);
    }

    await this.queue.add(
      CAMPAIGN_GENERATION_JOB,
      { campaignId },
      { removeOnComplete: true, removeOnFail: 100 },
    );
    return {
      campaignId,
      status: CampaignStatus.ANALYZING,
      more: true,
      detail: 'Generation queued.',
    };
  }

  /**
   * Cross-tenant sweep: advance every campaign that is mid-generation.
   *
   * Mirrors the other sweeps in this codebase (approval SLA, marketing sync) —
   * no companyId filter, because each row carries its own and this is system
   * reconciliation rather than a tenant request.
   */
  async sweep(limit = 5): Promise<{ advanced: number }> {
    const pending = await this.prisma.campaign.findMany({
      where: {
        status: {
          in: [CampaignStatus.ANALYZING, CampaignStatus.PLANNING, CampaignStatus.GENERATING],
        },
      },
      orderBy: { generationStartedAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    let advanced = 0;
    for (const { id } of pending) {
      try {
        await this.advance(id);
        advanced += 1;
      } catch (err) {
        // One bad campaign must not stop the sweep for every other tenant.
        this.logger.error(
          `Campaign ${id} generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { advanced };
  }

  /**
   * Move ONE campaign forward by one bounded unit of work.
   *
   * Safe to call concurrently: each transition is a guarded `updateMany` on the
   * status it expects, so a second caller that loses the race simply finds
   * nothing to claim rather than duplicating the step.
   */
  async advance(campaignId: string): Promise<AdvanceResult> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    try {
      switch (campaign.status) {
        case CampaignStatus.ANALYZING:
          return await this.runAnalyze(campaign);
        case CampaignStatus.PLANNING:
          return await this.runPlan(campaign);
        case CampaignStatus.GENERATING:
          return await this.runGenerate(campaign);
        default:
          return {
            campaignId,
            status: campaign.status,
            more: false,
            detail: `Nothing to do in state ${campaign.status}.`,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A generation failure is reported to the customer, not just logged —
      // "it stopped and nobody said why" is the failure this codebase treats
      // as a defect in its own right.
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: CampaignStatus.FAILED,
          generationError: message.slice(0, 1_000),
          generationFinishedAt: new Date(),
        },
      });
      await this.auditLog.record({
        companyId: campaign.companyId,
        action: 'marketing.campaign.generation_failed',
        entityType: 'Campaign',
        entityId: campaignId,
        metadata: { error: message.slice(0, 500), state: campaign.status },
      });
      throw err;
    }
  }

  // --- Step 1: brief -> structured plan (§9) --------------------------------

  private async runAnalyze(campaign: {
    id: string;
    companyId: string;
    brief: string | null;
    timezone: string;
  }): Promise<AdvanceResult> {
    const brand = await this.brandContext(campaign.companyId);
    const today = new Date().toISOString().slice(0, 10);

    const completion = await this.llm.complete({
      system: buildPlanPrompt(brand, today),
      messages: [{ role: 'user', content: campaign.brief ?? 'Plan a short awareness campaign.' }],
      json: true,
      temperature: 0.3,
      maxTokens: 1_200,
    });

    const parsed = extractJson(completion.content);
    if (!parsed) {
      throw new VariantValidationError('The planning step did not return usable JSON.');
    }
    const plan = validateCampaignPlan(parsed);

    // The model may suggest a timezone; the campaign's existing one wins if it
    // was set deliberately at creation. Never silently move a customer's
    // schedule to a zone they did not choose.
    const timezone = campaign.timezone !== 'UTC' ? campaign.timezone : (plan.timezone ?? 'UTC');

    const startDate = plan.startDateIso ? new Date(`${plan.startDateIso}T00:00:00Z`) : new Date();
    if (Number.isNaN(startDate.getTime())) {
      throw new VariantValidationError(`The plan returned an unusable start date.`);
    }
    const endDate = new Date(startDate.getTime());
    endDate.setUTCDate(endDate.getUTCDate() + plan.durationDays - 1);

    const claimed = await this.prisma.campaign.updateMany({
      where: { id: campaign.id, status: CampaignStatus.ANALYZING },
      data: {
        status: CampaignStatus.PLANNING,
        name: plan.name,
        objective: plan.objective,
        description: plan.description,
        startDate,
        endDate,
        timezone,
        postsPerDayMin: plan.postsPerDay,
        postsPerDayMax: plan.postsPerDay,
        platforms: plan.platforms,
        contentPillars: plan.contentPillars.length ? plan.contentPillars : [...DEFAULT_CONTENT_PILLARS],
        approvalRequired: plan.approvalRequired,
      },
    });
    if (claimed.count === 0) {
      return { campaignId: campaign.id, status: CampaignStatus.PLANNING, more: true, detail: 'Already claimed.' };
    }

    return {
      campaignId: campaign.id,
      status: CampaignStatus.PLANNING,
      more: true,
      detail: `Planned ${plan.durationDays} days x ${plan.postsPerDay}/day.`,
    };
  }

  // --- Step 2: plan -> content calendar (§11) -------------------------------

  private async runPlan(campaign: {
    id: string;
    companyId: string;
    startDate: Date | null;
    endDate: Date | null;
    timezone: string;
    postsPerDayMax: number | null;
    contentPillars: string[];
  }): Promise<AdvanceResult> {
    if (!campaign.startDate || !campaign.endDate || !campaign.postsPerDayMax) {
      throw new CampaignPlanError('The campaign has no dates or cadence to plan from.');
    }

    const items = planContentCalendar({
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      postsPerDay: campaign.postsPerDayMax,
      contentPillars: campaign.contentPillars,
      timezone: campaign.timezone,
    });

    // One transaction: a half-written calendar would leave GENERATING with an
    // incomplete set of items and no way to tell that from a finished one.
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.campaign.updateMany({
        where: { id: campaign.id, status: CampaignStatus.PLANNING },
        data: { status: CampaignStatus.GENERATING },
      });
      if (claimed.count === 0) return;

      await tx.contentItem.createMany({
        data: items.map((item) => ({
          companyId: campaign.companyId,
          campaignId: campaign.id,
          dayNumber: item.dayNumber,
          sequence: item.sequence,
          objective: item.objective,
          contentType: item.contentType,
          scheduledAt: item.scheduledAt,
          timezone: campaign.timezone,
          status: ContentItemStatus.DRAFT,
        })),
      });
    });

    return {
      campaignId: campaign.id,
      status: CampaignStatus.GENERATING,
      more: true,
      detail: `Calendar created: ${items.length} content items.`,
    };
  }

  // --- Step 3: content items -> 5-6 variants each (§13) ---------------------

  private async runGenerate(campaign: {
    id: string;
    companyId: string;
    objective: string | null;
    platforms: string[];
  }): Promise<AdvanceResult> {
    const pending = await this.prisma.contentItem.findMany({
      where: { campaignId: campaign.id, status: ContentItemStatus.DRAFT },
      orderBy: [{ dayNumber: 'asc' }, { sequence: 'asc' }],
      take: ITEMS_PER_PASS,
    });

    if (pending.length === 0) {
      return this.finishGeneration(campaign, 'All content items have options; ready for review.');
    }

    const brand = await this.brandContext(campaign.companyId);
    // Angles already used, so the model is told what NOT to repeat (§46).
    const usedAngles = await this.prisma.creativeVariant.findMany({
      where: { contentItem: { campaignId: campaign.id } },
      select: { contentAngle: true },
      take: 60,
      orderBy: { createdAt: 'desc' },
    });
    const avoidAngles = [...new Set(usedAngles.map((a) => a.contentAngle))];

    let generated = 0;
    for (const item of pending) {
      const completion = await this.llm.complete({
        system: buildVariantsPrompt(brand),
        messages: [
          {
            role: 'user',
            content: buildVariantsRequest({
              objective: item.objective,
              contentType: item.contentType,
              campaignObjective: campaign.objective,
              platforms: campaign.platforms,
              dayNumber: item.dayNumber,
              avoidAngles,
            }),
          },
        ],
        json: true,
        temperature: 0.9, // Higher than planning: this step wants divergence.
        maxTokens: 3_000,
      });

      const parsed = extractJson(completion.content);
      if (!parsed) {
        throw new VariantValidationError(
          `The creative step returned no usable JSON for day ${item.dayNumber} post ${item.sequence}.`,
        );
      }
      const set = validateVariantSet(parsed);

      await this.prisma.$transaction(async (tx) => {
        // Guarded: another pass may have generated this item already.
        const claimed = await tx.contentItem.updateMany({
          where: { id: item.id, status: ContentItemStatus.DRAFT },
          data: { status: ContentItemStatus.READY_FOR_REVIEW },
        });
        if (claimed.count === 0) return;

        await tx.creativeVariant.createMany({
          data: set.variants.map((v, index) => ({
            companyId: campaign.companyId,
            contentItemId: item.id,
            variantNumber: index + 1,
            version: item.currentVersion,
            hook: v.hook,
            caption: v.caption,
            cta: v.cta,
            hashtags: v.hashtags,
            contentAngle: v.contentAngle,
            mediaBrief: v.mediaBrief,
            recommended: index === set.recommendedIndex,
            recommendationReason:
              index === set.recommendedIndex ? set.recommendationReason : null,
            status: CreativeVariantStatus.READY,
          })),
        });
      });

      for (const v of set.variants) avoidAngles.push(v.contentAngle);
      generated += 1;
      if (set.droppedAsDuplicate > 0) {
        this.logger.log(
          `Campaign ${campaign.id} item ${item.id}: dropped ${set.droppedAsDuplicate} near-duplicate option(s).`,
        );
      }
    }

    const remaining = await this.prisma.contentItem.count({
      where: { campaignId: campaign.id, status: ContentItemStatus.DRAFT },
    });

    // Finish HERE when the queue is empty rather than reporting `more: false`
    // and relying on one further call to make the transition. A caller that
    // stops as soon as there is no more work — which is exactly what `more`
    // tells it to do — would otherwise leave the campaign stuck in GENERATING
    // with every item already generated.
    if (remaining === 0) {
      return this.finishGeneration(
        campaign,
        `Generated options for ${generated} item(s); ready for review.`,
      );
    }

    return {
      campaignId: campaign.id,
      status: CampaignStatus.GENERATING,
      more: true,
      detail: `Generated options for ${generated} item(s); ${remaining} remaining.`,
    };
  }

  /** GENERATING -> READY_FOR_REVIEW, guarded so a concurrent pass cannot repeat it. */
  private async finishGeneration(
    campaign: { id: string; companyId: string },
    detail: string,
  ): Promise<AdvanceResult> {
    const claimed = await this.prisma.campaign.updateMany({
      where: { id: campaign.id, status: CampaignStatus.GENERATING },
      data: {
        status: CampaignStatus.READY_FOR_REVIEW,
        generationFinishedAt: new Date(),
        generationError: null,
      },
    });
    if (claimed.count > 0) {
      await this.auditLog.record({
        companyId: campaign.companyId,
        action: 'marketing.campaign.generation_completed',
        entityType: 'Campaign',
        entityId: campaign.id,
      });
    }
    return {
      campaignId: campaign.id,
      status: CampaignStatus.READY_FOR_REVIEW,
      more: false,
      detail,
    };
  }

  // --- Context -------------------------------------------------------------

  /**
   * §5/§40 — only fields the platform genuinely holds. There is no brand-voice
   * or forbidden-claims store, and the prompt says so rather than inventing one.
   */
  private async brandContext(companyId: string): Promise<BrandContext> {
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: {
        name: true,
        industry: true,
        description: true,
        website: true,
        businessGoals: true,
      },
    });
    return {
      companyName: company.name,
      industry: company.industry,
      description: company.description,
      website: company.website,
      businessGoals: company.businessGoals,
    };
  }
}
