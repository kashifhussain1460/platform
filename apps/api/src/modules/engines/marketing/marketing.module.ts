import { PostizEngineAdapter } from './postiz-engine.adapter';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PostizClientService } from './postiz-client.service';
import { SuppressionService } from './suppression.service';
import { MarketingSyncService } from './marketing-sync.service';
import { MarketingSyncProcessor } from './marketing-sync.processor';
import { MarketingWebhookController } from './marketing-webhook.controller';
import { MARKETING_SYNC_QUEUE } from './marketing.constants';
import { queueWorkersEnabled } from '../../../common/resilience/queue-workers';

/**
 * Marketing engine module: the Postiz REST client, the unsigned-webhook
 * receiver, and the reconciliation sync processor (BullMQ repeatable, docs
 * §13). Exports PostizClientService so SkillsModule's RealSkillExecutor can
 * use the same single instance rather than standing up its own.
 */
@Module({
  imports: [BullModule.registerQueue({ name: MARKETING_SYNC_QUEUE })],
  controllers: [MarketingWebhookController],
  providers: [PostizEngineAdapter, 
    // WAVE 3 §3.6 — consent + suppression, consumed by SkillsService.
    SuppressionService,
    PostizClientService,
    // Always provided so the Vercel cron route can drive the sweep on serverless
    // (the processor that also drives it is worker-gated).
    MarketingSyncService,
    ...(queueWorkersEnabled() ? [MarketingSyncProcessor] : []),
  ],
  exports: [SuppressionService, PostizClientService, MarketingSyncService],
})
export class MarketingModule {}
