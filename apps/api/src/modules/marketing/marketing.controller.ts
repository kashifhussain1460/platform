import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AiCampaignDetailDto,
  CampaignDto,
  ContentItemDto,
  ImportSocialAccountsResultDto,
  MarketingAnalyticsSnapshotDto,
  ScheduledPostDto,
  ScheduledPostStatus,
  SocialAccountDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import {
  CreateAiCampaignBodyDto,
  CreateCampaignBodyDto,
  CreatePostDto,
  SelectVariantBodyDto,
  StartConnectDto,
  UpdateCampaignBodyDto,
  UpdatePostDto,
} from './dto/marketing.dto';
import { MarketingService } from './marketing.service';
import { CampaignGenerationService } from './generation/campaign-generation.service';
import { CampaignQueryService } from './generation/campaign-query.service';

/**
 * The marketing workspace — the human front door to the Marketing AI Employee.
 *
 * Split by capability, not by role: `marketing:read` (MEMBER floor) so anyone
 * in the company can SEE what is queued and what went out on their public
 * accounts, `marketing:manage` (ADMIN floor) for anything that changes the
 * outside world. Both floors live in `authorization.policy.ts` with every
 * other action rather than as `@Roles` scattered here.
 *
 * Tenant comes from the JWT on every route; the service filters by it on every
 * query, so a wrong id is a 404, never another company's row.
 */
@Controller('marketing')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class MarketingController {
  constructor(
    private readonly marketing: MarketingService,
    private readonly generation: CampaignGenerationService,
    private readonly campaigns: CampaignQueryService,
  ) {}

  // --- Social accounts -----------------------------------------------------

  @Get('accounts')
  @RequirePermission('marketing:read')
  listAccounts(@CurrentTenant() companyId: string): Promise<SocialAccountDto[]> {
    return this.marketing.listAccounts(companyId);
  }

  @Post('accounts/connect')
  @RequirePermission('marketing:manage')
  startConnect(@Body() dto: StartConnectDto): Promise<{ url: string }> {
    return this.marketing.startConnect(dto.platform);
  }

  /** Pull the company's connected accounts across from the shared Postiz instance. */
  @Post('accounts/import')
  @RequirePermission('marketing:manage')
  importAccounts(
    @CurrentTenant() companyId: string,
  ): Promise<ImportSocialAccountsResultDto> {
    return this.marketing.importAccounts(companyId);
  }

  @Post('accounts/:id/disconnect')
  @RequirePermission('marketing:manage')
  disconnect(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<SocialAccountDto> {
    return this.marketing.disconnectAccount(companyId, id);
  }

  // --- Posts ---------------------------------------------------------------

  @Get('posts')
  @RequirePermission('marketing:read')
  listPosts(
    @CurrentTenant() companyId: string,
    @Query('status') status?: ScheduledPostStatus,
    @Query('campaignId') campaignId?: string,
  ): Promise<ScheduledPostDto[]> {
    return this.marketing.listPosts(companyId, { status, campaignId });
  }

  @Post('posts')
  @RequirePermission('marketing:manage')
  createPost(
    @CurrentTenant() companyId: string,
    @Body() dto: CreatePostDto,
  ): Promise<ScheduledPostDto> {
    return this.marketing.createPost(companyId, dto);
  }

  @Patch('posts/:id')
  @RequirePermission('marketing:manage')
  updatePost(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePostDto,
  ): Promise<ScheduledPostDto> {
    return this.marketing.updatePost(companyId, id, dto);
  }

  @Delete('posts/:id')
  @RequirePermission('marketing:manage')
  cancelPost(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    return this.marketing.cancelPost(companyId, id);
  }

  // --- Campaigns -----------------------------------------------------------

  @Get('campaigns')
  @RequirePermission('marketing:read')
  listCampaigns(@CurrentTenant() companyId: string): Promise<CampaignDto[]> {
    return this.marketing.listCampaigns(companyId);
  }

  @Post('campaigns')
  @RequirePermission('marketing:manage')
  createCampaign(
    @CurrentTenant() companyId: string,
    @Body() dto: CreateCampaignBodyDto,
  ): Promise<CampaignDto> {
    return this.marketing.createCampaign(companyId, dto);
  }

  @Patch('campaigns/:id')
  @RequirePermission('marketing:manage')
  updateCampaign(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCampaignBodyDto,
  ): Promise<CampaignDto> {
    return this.marketing.updateCampaign(companyId, id, dto);
  }

  @Delete('campaigns/:id')
  @RequirePermission('marketing:manage')
  deleteCampaign(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<{ id: string; detachedPosts: number }> {
    return this.marketing.deleteCampaign(companyId, id);
  }

  // --- AI campaigns (architecture doc §72) ---------------------------------

  /**
   * Create a campaign from a natural-language brief and start generating.
   *
   * Returns as soon as the work is ACCEPTED, not when it is finished (§74) — a
   * 21-post campaign is 21 model calls and must never be held open in the
   * request that asked for it. Poll the detail endpoint for progress.
   */
  @Post('campaigns/ai')
  @RequirePermission('marketing:manage')
  async createAiCampaign(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAiCampaignBodyDto,
  ): Promise<AiCampaignDetailDto> {
    const campaign = await this.marketing.createAiCampaign(companyId, user.userId, dto);
    await this.generation.start(companyId, campaign.id);
    return this.campaigns.detail(companyId, campaign.id);
  }

  /** The campaign, its plan, and generation progress (§75). */
  @Get('campaigns/:id/detail')
  @RequirePermission('marketing:read')
  campaignDetail(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<AiCampaignDetailDto> {
    return this.campaigns.detail(companyId, id);
  }

  /**
   * The content calendar (§59) — WITHOUT options.
   *
   * §31/§62: 35 posts x 6 options is 210 variants, and sending them all to
   * render a calendar would be slow and show far more than anyone asked for.
   * Open a single post to see its options.
   */
  @Get('campaigns/:id/content')
  @RequirePermission('marketing:read')
  campaignContent(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<ContentItemDto[]> {
    return this.campaigns.contentItems(companyId, id);
  }

  /** One post with its 5–6 options. */
  @Get('content/:id')
  @RequirePermission('marketing:read')
  contentItem(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<ContentItemDto> {
    return this.campaigns.contentItem(companyId, id);
  }

  /**
   * Pick which option to use.
   *
   * Selection is NOT approval (§32/§3.4). Nothing becomes publishable here.
   */
  @Post('content/:id/select-variant')
  @RequirePermission('marketing:manage')
  selectVariant(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SelectVariantBodyDto,
  ): Promise<ContentItemDto> {
    return this.campaigns.selectVariant(companyId, id, dto.variantId, user.userId);
  }

  // --- Analytics -----------------------------------------------------------

  @Get('analytics')
  @RequirePermission('marketing:read')
  listAnalytics(
    @CurrentTenant() companyId: string,
    @Query('socialAccountId') socialAccountId?: string,
  ): Promise<MarketingAnalyticsSnapshotDto[]> {
    return this.marketing.listAnalytics(companyId, socialAccountId);
  }
}
