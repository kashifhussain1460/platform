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
  CampaignDto,
  ImportSocialAccountsResultDto,
  MarketingAnalyticsSnapshotDto,
  ScheduledPostDto,
  ScheduledPostStatus,
  SocialAccountDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import {
  CreateCampaignBodyDto,
  CreatePostDto,
  StartConnectDto,
  UpdateCampaignBodyDto,
  UpdatePostDto,
} from './dto/marketing.dto';
import { MarketingService } from './marketing.service';

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
  constructor(private readonly marketing: MarketingService) {}

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
