import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentItemStatus, CreativeVariantStatus } from '@prisma/client';
import type {
  AiCampaignDetailDto,
  CampaignGenerationStatusDto,
  ContentItemDto,
  CreativeVariantDto,
} from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditLogService } from '../../audit/audit-log.service';

/**
 * Reads over a generated campaign, plus variant selection.
 *
 * Separate from `CampaignGenerationService` on purpose: that one is a
 * long-running state machine driven by workers and crons, this one serves
 * synchronous requests from the review screen. Mixing them would put the
 * review page's latency behind a service that holds model calls.
 *
 * Every query filters by `companyId` (§3.1). A wrong id is a 404, never another
 * tenant's campaign.
 */
@Injectable()
export class CampaignQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async detail(companyId: string, campaignId: string): Promise<AiCampaignDetailDto> {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, companyId },
    });
    if (!campaign) throw new NotFoundException('Campaign not found for this company');

    const [totalItems, itemsWithOptions] = await Promise.all([
      this.prisma.contentItem.count({ where: { campaignId, companyId } }),
      this.prisma.contentItem.count({
        where: { campaignId, companyId, status: { not: ContentItemStatus.DRAFT } },
      }),
    ]);

    const generation: CampaignGenerationStatusDto = {
      campaignId,
      status: campaign.status,
      inProgress: ['ANALYZING', 'PLANNING', 'GENERATING', 'MEDIA_GENERATING', 'QUALITY_CHECK'].includes(
        campaign.status,
      ),
      detail: describeProgress(campaign.status, totalItems, itemsWithOptions),
      error: campaign.generationError,
      totalItems,
      itemsWithOptions,
    };

    return {
      id: campaign.id,
      name: campaign.name,
      brief: campaign.brief,
      objective: campaign.objective,
      description: campaign.description,
      status: campaign.status,
      startDate: campaign.startDate?.toISOString() ?? null,
      endDate: campaign.endDate?.toISOString() ?? null,
      timezone: campaign.timezone,
      postsPerDayMin: campaign.postsPerDayMin,
      postsPerDayMax: campaign.postsPerDayMax,
      platforms: campaign.platforms,
      contentPillars: campaign.contentPillars,
      approvalRequired: campaign.approvalRequired,
      generation,
      createdAt: campaign.createdAt.toISOString(),
    };
  }

  /**
   * The calendar (§59). Deliberately WITHOUT variants.
   *
   * §31/§62 are explicit about progressive disclosure: 35 posts x 6 options is
   * 210 variants, and shipping all of them to render a calendar would be a slow
   * page showing far more than anyone asked to see. Counts here; the options
   * arrive when a specific post is opened.
   */
  async contentItems(companyId: string, campaignId: string): Promise<ContentItemDto[]> {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, companyId },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found for this company');

    const rows = await this.prisma.contentItem.findMany({
      where: { campaignId, companyId },
      orderBy: [{ dayNumber: 'asc' }, { sequence: 'asc' }],
      include: { _count: { select: { variants: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      campaignId: row.campaignId,
      dayNumber: row.dayNumber,
      sequence: row.sequence,
      objective: row.objective,
      contentType: row.contentType,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      timezone: row.timezone,
      currentVersion: row.currentVersion,
      selectedVariantId: row.selectedVariantId,
      status: row.status,
      variantCount: row._count.variants,
    }));
  }

  /** One content item WITH its options — the expanded view (§31). */
  async contentItem(companyId: string, contentItemId: string): Promise<ContentItemDto> {
    const row = await this.prisma.contentItem.findFirst({
      where: { id: contentItemId, companyId },
      include: {
        _count: { select: { variants: true } },
        variants: {
          // Only the CURRENT version's options. Older versions stay in the
          // table for the audit trail (§93) but must not appear as choices.
          orderBy: [{ version: 'desc' }, { variantNumber: 'asc' }],
        },
      },
    });
    if (!row) throw new NotFoundException('Content item not found for this company');

    const current = row.variants.filter((v) => v.version === row.currentVersion);

    return {
      id: row.id,
      campaignId: row.campaignId,
      dayNumber: row.dayNumber,
      sequence: row.sequence,
      objective: row.objective,
      contentType: row.contentType,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      timezone: row.timezone,
      currentVersion: row.currentVersion,
      selectedVariantId: row.selectedVariantId,
      status: row.status,
      variantCount: row._count.variants,
      variants: current.map(toVariantDto),
    };
  }

  /**
   * Select one option for a content item (§33).
   *
   * Selection is NOT approval (§32/§3.4) — it records which creative the human
   * picked and nothing else. Nothing becomes publishable here; that is a
   * separate, explicit step.
   */
  async selectVariant(
    companyId: string,
    contentItemId: string,
    variantId: string,
    userId: string,
  ): Promise<ContentItemDto> {
    const item = await this.prisma.contentItem.findFirst({
      where: { id: contentItemId, companyId },
      select: { id: true, currentVersion: true },
    });
    if (!item) throw new NotFoundException('Content item not found for this company');

    const variant = await this.prisma.creativeVariant.findFirst({
      where: { id: variantId, contentItemId, companyId },
      select: { id: true, version: true },
    });
    if (!variant) {
      throw new NotFoundException('That option does not belong to this content item');
    }
    if (variant.version !== item.currentVersion) {
      // Selecting a superseded option would attach the campaign to creative the
      // human is no longer looking at.
      throw new NotFoundException(
        'That option belongs to an older version of this post. Reload and choose again.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Exactly one SELECTED per item: demote any previous choice first.
      await tx.creativeVariant.updateMany({
        where: { contentItemId, status: CreativeVariantStatus.SELECTED },
        data: { status: CreativeVariantStatus.READY },
      });
      await tx.creativeVariant.update({
        where: { id: variantId },
        data: { status: CreativeVariantStatus.SELECTED },
      });
      await tx.contentItem.update({
        where: { id: contentItemId },
        data: { selectedVariantId: variantId },
      });
    });

    await this.auditLog.record({
      companyId,
      action: 'marketing.variant.selected',
      entityType: 'ContentItem',
      entityId: contentItemId,
      metadata: { variantId, version: item.currentVersion, userId },
    });

    return this.contentItem(companyId, contentItemId);
  }
}

function toVariantDto(v: {
  id: string;
  variantNumber: number;
  version: number;
  hook: string;
  caption: string;
  cta: string;
  hashtags: string[];
  contentAngle: string;
  mediaBrief: string | null;
  recommended: boolean;
  recommendationReason: string | null;
  status: CreativeVariantStatus;
}): CreativeVariantDto {
  return {
    id: v.id,
    variantNumber: v.variantNumber,
    version: v.version,
    hook: v.hook,
    caption: v.caption,
    cta: v.cta,
    hashtags: v.hashtags,
    contentAngle: v.contentAngle,
    mediaBrief: v.mediaBrief,
    recommended: v.recommended,
    recommendationReason: v.recommendationReason,
    status: v.status,
  };
}

/** Progress in words, so the UI never has to invent a sentence from a status. */
function describeProgress(status: string, total: number, done: number): string {
  switch (status) {
    case 'DRAFT':
      return 'Not started yet.';
    case 'ANALYZING':
      return 'Reading your brief.';
    case 'PLANNING':
      return 'Building the content calendar.';
    case 'GENERATING':
      return total > 0
        ? `Writing options: ${done} of ${total} posts done.`
        : 'Writing options.';
    case 'READY_FOR_REVIEW':
      return `${total} posts ready for you to review.`;
    case 'FAILED':
      return 'Generation stopped. See the error for what went wrong.';
    default:
      return `Campaign is ${status.toLowerCase().replace(/_/g, ' ')}.`;
  }
}
