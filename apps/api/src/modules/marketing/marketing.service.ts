import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  CampaignDto,
  CreateCampaignDto,
  CreateScheduledPostDto,
  ImportSocialAccountsResultDto,
  MarketingAnalyticsSnapshotDto,
  ScheduledPostDto,
  ScheduledPostStatus,
  SocialAccountDto,
  UpdateCampaignDto,
  UpdateScheduledPostDto,
} from '@vaep/types';
import { CampaignStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PostizClientService } from '../engines/marketing/postiz-client.service';

/** Statuses a human may still edit or cancel. Anything else is already out the door. */
const EDITABLE_STATUSES: ScheduledPostStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'FAILED'];

/**
 * The human-facing marketing workspace.
 *
 * ## Why this module exists
 *
 * The Marketing AI Employee's `postiz.*` tools already create
 * `ScheduledPost`/`PublishedPost` rows, and `MarketingSyncService` already
 * reconciles them against Postiz — but there was NO tenant-facing API over any
 * of it. An AI could queue and publish to a company's real, public social
 * accounts while the company had no screen listing what was queued, what went
 * out, or which accounts were even connected. This is the same defect class as
 * an approval nobody can see, with a larger blast radius: the side effects are
 * public and irreversible.
 *
 * ## What it deliberately does NOT do
 *
 * It does not re-implement publishing. Sending to Postiz goes through the same
 * `PostizClientService` the `RealSkillExecutor` uses, so there is one egress
 * path with one circuit breaker and one rate limiter (`POSTIZ_RESOURCE_KEY`),
 * not a second one that would let humans and AI collectively exceed Postiz's
 * instance-wide cap while each stayed under its own budget.
 */
@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postiz: PostizClientService,
  ) {}

  // --- Social accounts -----------------------------------------------------

  async listAccounts(companyId: string): Promise<SocialAccountDto[]> {
    const rows = await this.prisma.socialAccount.findMany({
      where: { companyId },
      orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toAccountDto(r));
  }

  /**
   * Start connecting a new social account. Returns Postiz's own provider
   * redirect URL; the customer completes the real Instagram/LinkedIn consent
   * screen, and the resulting integration is picked up by `importAccounts`.
   */
  async startConnect(platform: string): Promise<{ url: string }> {
    const clean = platform.trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(clean)) {
      throw new BadRequestException('Unsupported platform identifier');
    }
    return this.postiz.getConnectUrl(clean);
  }

  /**
   * Import this company's connected accounts from the shared Postiz instance.
   *
   * 🔴 **This is the step that makes the Marketing AI Employee work at all.**
   * `schedule_post` and `publish_now` both look up a `SocialAccount` row and
   * fail without one, and until now NOTHING in production ever created one —
   * only tests did. So every marketing tool call failed with "SocialAccount
   * not found" on a real deployment.
   *
   * 🔴 **And it is the sharpest tenant-isolation boundary in the module.**
   * One Postiz instance is shared by every Orlixa company, so "list the
   * integrations" without a filter returns OTHER TENANTS' social accounts —
   * importing those would let this company publish to a rival's Instagram.
   * The Postiz `Customer`/group id is the only thing separating them, so this
   * refuses to run when the company has none assigned rather than importing
   * whatever the shared instance happens to return. Failing closed here costs
   * a support ticket; failing open costs someone else's brand.
   */
  async importAccounts(companyId: string): Promise<ImportSocialAccountsResultDto> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { postizCustomerGroupId: true },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    if (!company.postizCustomerGroupId) {
      throw new ConflictException(
        'This company has no Postiz customer group assigned yet, so connected ' +
          'accounts cannot be imported safely. Ask support to finish setting up ' +
          'social publishing.',
      );
    }

    const integrations = await this.postiz.listIntegrations(company.postizCustomerGroupId);

    // Defence in depth: `?group=` is a server-side filter we do not control.
    // If Postiz ever ignores or widens it, an untagged or differently-tagged
    // integration must NOT become this company's account.
    const mine = integrations.filter(
      (i) => i.customer?.id === company.postizCustomerGroupId,
    );
    if (mine.length !== integrations.length) {
      this.logger.warn(
        `Postiz returned ${integrations.length - mine.length} integration(s) outside ` +
          `group ${company.postizCustomerGroupId}; they were discarded.`,
      );
    }

    let imported = 0;
    let updated = 0;
    const accounts: SocialAccountDto[] = [];

    for (const integration of mine) {
      const existing = await this.prisma.socialAccount.findFirst({
        where: { companyId, postizIntegrationId: integration.id },
      });
      const data = {
        provider: integration.identifier,
        displayName: integration.name ?? null,
        postizCustomerId: integration.customer?.id ?? null,
        // Postiz's own `disabled` flag is the truth about whether the token
        // still works; mirroring it stops the AI from picking an account that
        // would fail at publish time.
        status: integration.disabled ? ('DISCONNECTED' as const) : ('CONNECTED' as const),
      };

      if (existing) {
        const row = await this.prisma.socialAccount.update({
          where: { id: existing.id },
          data,
        });
        updated += 1;
        accounts.push(this.toAccountDto(row));
      } else {
        const row = await this.prisma.socialAccount.create({
          data: { companyId, postizIntegrationId: integration.id, ...data },
        });
        imported += 1;
        accounts.push(this.toAccountDto(row));
      }
    }

    return { imported, updated, accounts };
  }

  /**
   * Mark an account disconnected locally. Deliberately NOT a delete: published
   * posts reference it, and a company needs its publishing history to survive
   * a revoked token.
   */
  async disconnectAccount(companyId: string, id: string): Promise<SocialAccountDto> {
    const account = await this.prisma.socialAccount.findFirst({ where: { id, companyId } });
    if (!account) {
      throw new NotFoundException('Social account not found for this company');
    }
    const row = await this.prisma.socialAccount.update({
      where: { id },
      data: { status: 'DISCONNECTED' },
    });
    return this.toAccountDto(row);
  }

  // --- Posts ---------------------------------------------------------------

  async listPosts(
    companyId: string,
    opts: { status?: ScheduledPostStatus; campaignId?: string } = {},
  ): Promise<ScheduledPostDto[]> {
    const rows = await this.prisma.scheduledPost.findMany({
      where: {
        companyId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
      },
      orderBy: [{ publishAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: {
        socialAccount: { select: { provider: true, displayName: true } },
        campaign: { select: { name: true } },
        publishedPost: { select: { permalink: true, publishedAt: true } },
      },
    });
    return rows.map((r) => this.toPostDto(r));
  }

  /**
   * Create a post.
   *
   * `schedule: false` writes a local DRAFT and stops — nothing reaches Postiz.
   * `schedule: true` hands it to Postiz FIRST and stores the returned id.
   *
   * 🔴 The ordering matters and the two modes must stay distinct. A row with
   * `status: SCHEDULED` but no `postizPostId` is invisible to Postiz and is
   * skipped by the reconciliation sweep (`if (!post.postizPostId) continue`),
   * so it would sit in the UI looking scheduled and never publish — a green
   * screen with no side effect, which is worse than an error. There is no code
   * path here that produces one.
   */
  async createPost(
    companyId: string,
    dto: CreateScheduledPostDto,
  ): Promise<ScheduledPostDto> {
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: dto.socialAccountId, companyId },
    });
    if (!account) {
      throw new NotFoundException('Social account not found for this company');
    }
    if (dto.campaignId) {
      await this.assertCampaign(companyId, dto.campaignId);
    }

    const content = dto.content.trim();
    if (!content) {
      throw new BadRequestException('A post needs some content');
    }

    if (!dto.schedule) {
      const row = await this.prisma.scheduledPost.create({
        data: {
          companyId,
          socialAccountId: account.id,
          campaignId: dto.campaignId ?? null,
          content,
          // A draft still needs a target time so the calendar can place it;
          // "now" is the honest default for one the author hasn't dated.
          publishAt: dto.publishAt ? new Date(dto.publishAt) : new Date(),
          status: 'DRAFT',
        },
        include: this.postInclude(),
      });
      return this.toPostDto(row);
    }

    if (account.status !== 'CONNECTED') {
      throw new ConflictException(
        'That social account is not connected, so nothing can be scheduled to it',
      );
    }
    const publishAt = this.requireFutureDate(dto.publishAt);

    const { postizPostId } = await this.postiz.schedulePost({
      postizIntegrationId: account.postizIntegrationId,
      content,
      type: 'schedule',
      date: publishAt.toISOString(),
    });

    const row = await this.prisma.scheduledPost.create({
      data: {
        companyId,
        socialAccountId: account.id,
        campaignId: dto.campaignId ?? null,
        content,
        publishAt,
        status: 'SCHEDULED',
        postizPostId,
      },
      include: this.postInclude(),
    });
    return this.toPostDto(row);
  }

  /**
   * Edit a post that has not gone out yet.
   *
   * Editing is refused once a post is SCHEDULED, because the copy Postiz holds
   * is the one that will actually publish — changing only the local row would
   * show the customer text that differs from what their followers see. Cancel
   * and re-create instead, which really does withdraw it.
   */
  async updatePost(
    companyId: string,
    id: string,
    dto: UpdateScheduledPostDto,
  ): Promise<ScheduledPostDto> {
    const post = await this.prisma.scheduledPost.findFirst({ where: { id, companyId } });
    if (!post) {
      throw new NotFoundException('Post not found for this company');
    }
    if (!EDITABLE_STATUSES.includes(post.status)) {
      throw new ConflictException(
        `A ${post.status.toLowerCase()} post can no longer be edited. Cancel it and create a new one.`,
      );
    }
    if (dto.campaignId) {
      await this.assertCampaign(companyId, dto.campaignId);
    }

    const row = await this.prisma.scheduledPost.update({
      where: { id },
      data: {
        ...(dto.content !== undefined ? { content: dto.content.trim() } : {}),
        ...(dto.publishAt !== undefined ? { publishAt: new Date(dto.publishAt) } : {}),
        ...(dto.campaignId !== undefined ? { campaignId: dto.campaignId } : {}),
      },
      include: this.postInclude(),
    });
    return this.toPostDto(row);
  }

  /**
   * Cancel a post.
   *
   * A PUBLISHED post cannot be cancelled — it is already public, and pretending
   * otherwise in the UI would be a lie about the outside world.
   */
  async cancelPost(companyId: string, id: string): Promise<{ id: string }> {
    const post = await this.prisma.scheduledPost.findFirst({ where: { id, companyId } });
    if (!post) {
      throw new NotFoundException('Post not found for this company');
    }
    if (post.status === 'PUBLISHED') {
      throw new ConflictException('That post is already published and cannot be cancelled');
    }
    await this.prisma.scheduledPost.delete({ where: { id } });
    return { id };
  }

  // --- Campaigns -----------------------------------------------------------

  async listCampaigns(companyId: string): Promise<CampaignDto[]> {
    const rows = await this.prisma.campaign.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { posts: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      goal: r.goal,
      status: r.status,
      aiEmployeeId: r.aiEmployeeId,
      postCount: r._count.posts,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createCampaign(companyId: string, dto: CreateCampaignDto): Promise<CampaignDto> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('A campaign needs a name');
    }
    if (dto.aiEmployeeId) {
      const employee = await this.prisma.aiEmployee.findFirst({
        where: { id: dto.aiEmployeeId, companyId },
        select: { id: true },
      });
      if (!employee) {
        throw new NotFoundException('AI Employee not found for this company');
      }
    }
    const row = await this.prisma.campaign.create({
      data: {
        companyId,
        name,
        goal: dto.goal?.trim() || null,
        aiEmployeeId: dto.aiEmployeeId ?? null,
      },
      include: { _count: { select: { posts: true } } },
    });
    return {
      id: row.id,
      name: row.name,
      goal: row.goal,
      status: row.status,
      aiEmployeeId: row.aiEmployeeId,
      postCount: row._count.posts,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Create a campaign from a natural-language brief, ready for generation (§8).
   *
   * Stored in DRAFT with the brief kept VERBATIM. Everything else — name,
   * dates, cadence, platforms, pillars — is left for the ANALYZING step to
   * derive, so there is exactly one place that interprets the brief. Guessing a
   * name here and having the AI overwrite it moments later would just show the
   * customer two different answers.
   */
  async createAiCampaign(
    companyId: string,
    userId: string,
    dto: { brief: string; timezone?: string; aiEmployeeId?: string },
  ): Promise<{ id: string }> {
    const brief = dto.brief.trim();
    if (!brief) {
      throw new BadRequestException('A campaign brief is required');
    }
    if (dto.aiEmployeeId) {
      const employee = await this.prisma.aiEmployee.findFirst({
        where: { id: dto.aiEmployeeId, companyId },
        select: { id: true },
      });
      if (!employee) {
        throw new NotFoundException('AI Employee not found for this company');
      }
    }

    const row = await this.prisma.campaign.create({
      data: {
        companyId,
        createdByUserId: userId,
        aiEmployeeId: dto.aiEmployeeId ?? null,
        // A placeholder the ANALYZING step replaces. Never shown as final.
        name: 'Planning…',
        brief,
        // Only an explicitly chosen zone is stored now; otherwise the planner
        // decides and UTC is the honest default until it does.
        timezone: dto.timezone?.trim() || 'UTC',
        status: CampaignStatus.DRAFT,
      },
      select: { id: true },
    });
    return row;
  }

  async updateCampaign(
    companyId: string,
    id: string,
    dto: UpdateCampaignDto,
  ): Promise<CampaignDto> {
    await this.assertCampaign(companyId, id);
    const row = await this.prisma.campaign.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.goal !== undefined ? { goal: dto.goal?.trim() || null } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
      include: { _count: { select: { posts: true } } },
    });
    return {
      id: row.id,
      name: row.name,
      goal: row.goal,
      status: row.status,
      aiEmployeeId: row.aiEmployeeId,
      postCount: row._count.posts,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Delete a campaign. Its posts are kept and simply un-grouped — deleting
   * real scheduled/published posts as a side effect of tidying up a label
   * would be a destructive surprise.
   */
  async deleteCampaign(companyId: string, id: string): Promise<{ id: string; detachedPosts: number }> {
    await this.assertCampaign(companyId, id);
    const detached = await this.prisma.scheduledPost.updateMany({
      where: { companyId, campaignId: id },
      data: { campaignId: null },
    });
    await this.prisma.campaign.delete({ where: { id } });
    return { id, detachedPosts: detached.count };
  }

  // --- Analytics -----------------------------------------------------------

  async listAnalytics(
    companyId: string,
    socialAccountId?: string,
  ): Promise<MarketingAnalyticsSnapshotDto[]> {
    const rows = await this.prisma.marketingAnalyticsSnapshot.findMany({
      where: { companyId, ...(socialAccountId ? { socialAccountId } : {}) },
      orderBy: { capturedAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      socialAccountId: r.socialAccountId,
      capturedAt: r.capturedAt.toISOString(),
      metrics: (r.metrics ?? {}) as Record<string, unknown>,
    }));
  }

  // --- helpers -------------------------------------------------------------

  private postInclude() {
    return {
      socialAccount: { select: { provider: true, displayName: true } },
      campaign: { select: { name: true } },
      publishedPost: { select: { permalink: true, publishedAt: true } },
    };
  }

  private async assertCampaign(companyId: string, id: string): Promise<void> {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found for this company');
    }
  }

  private requireFutureDate(value?: string): Date {
    if (!value) {
      throw new BadRequestException('publishAt is required when scheduling a post');
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('publishAt is not a valid date');
    }
    if (date.getTime() <= Date.now()) {
      throw new BadRequestException('publishAt must be in the future');
    }
    return date;
  }

  private toAccountDto(row: {
    id: string;
    provider: string;
    displayName: string | null;
    status: string;
    employeeId: string | null;
    externalAccountId: string | null;
    createdAt: Date;
  }): SocialAccountDto {
    return {
      id: row.id,
      provider: row.provider,
      displayName: row.displayName,
      status: row.status as SocialAccountDto['status'],
      employeeId: row.employeeId,
      externalAccountId: row.externalAccountId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toPostDto(row: {
    id: string;
    socialAccountId: string;
    campaignId: string | null;
    content: string;
    publishAt: Date;
    status: string;
    postizPostId: string | null;
    createdAt: Date;
    updatedAt: Date;
    socialAccount?: { provider: string; displayName: string | null } | null;
    campaign?: { name: string } | null;
    publishedPost?: { permalink: string | null; publishedAt: Date } | null;
  }): ScheduledPostDto {
    return {
      id: row.id,
      socialAccountId: row.socialAccountId,
      socialAccountProvider: row.socialAccount?.provider ?? 'unknown',
      socialAccountName: row.socialAccount?.displayName ?? null,
      campaignId: row.campaignId,
      campaignName: row.campaign?.name ?? null,
      content: row.content,
      publishAt: row.publishAt.toISOString(),
      status: row.status as ScheduledPostStatus,
      postizPostId: row.postizPostId,
      permalink: row.publishedPost?.permalink ?? null,
      publishedAt: row.publishedPost?.publishedAt.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
