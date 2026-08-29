import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PlatformAdminModule } from '../billing/platform-admin/platform-admin.module';
import { MarketingModule } from '../engines/marketing/marketing.module';
import { MarketingController } from './marketing.controller';
import { MarketingService } from './marketing.service';
import { PostizTenancyController } from './postiz-tenancy.controller';
import { LlmModule } from '../employees/llm/llm.module';
import { CampaignGenerationService } from './generation/campaign-generation.service';
import { CampaignQueryService } from './generation/campaign-query.service';
import { CampaignGenerationProcessor } from './generation/campaign-generation.processor';
import { CAMPAIGN_GENERATION_QUEUE } from './generation/campaign-generation.constants';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';

/**
 * The tenant-facing marketing workspace.
 *
 * Named `MarketingWorkspaceModule` because `MarketingModule` already exists
 * under `modules/engines/marketing` and means something different: that one is
 * the ENGINE adapter (the Postiz REST client, the reconciliation sweep, the
 * webhook receiver), this one is the customer-facing API over the local mirror
 * tables. This module imports that one for `PostizClientService` so there is a
 * single Postiz egress path — one circuit breaker, one rate limiter — rather
 * than a second client that would let human and AI traffic collectively blow
 * through the shared instance's cap.
 */
@Module({
  imports: [
    MarketingModule,
    AuthorizationModule,
    PlatformAdminModule,
    AuditModule,
    LlmModule,
    BullModule.registerQueue({ name: CAMPAIGN_GENERATION_QUEUE }),
  ],
  controllers: [MarketingController, PostizTenancyController],
  providers: [
    MarketingService,
    // Always provided, so the Vercel cron route can drive generation on
    // serverless. The PROCESSOR that also drives it is worker-gated — same
    // split as MarketingSyncService/MarketingSyncProcessor.
    CampaignGenerationService,
    CampaignQueryService,
    ...(queueWorkersEnabled() ? [CampaignGenerationProcessor] : []),
  ],
  exports: [MarketingService, CampaignGenerationService, CampaignQueryService],
})
export class MarketingWorkspaceModule {}
