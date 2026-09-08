import { Module } from '@nestjs/common';
import { CanonicalIngestModule } from '../../events/ingestion/canonical-ingest.module';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';
import { WhatsappAccountsController } from './whatsapp-accounts.controller';
import { WhatsappAccountsService } from './whatsapp-accounts.service';
import { WhatsappEngineAdapter } from './whatsapp-engine.adapter';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';

/**
 * WhatsApp engine module (docs/plans/2026-09-06-whatsapp-sales-engine-plan.md §4):
 * the Twilio REST client, the signature-verified inbound webhook, and the
 * `WhatsAppAccount` connect surface (Task 13 — see `whatsapp-accounts.controller.ts`
 * for why this is a dedicated route rather than the generic Skill Config flow).
 * Exports TwilioWhatsappClientService so SkillsModule's RealSkillExecutor can
 * use the same single instance rather than standing up its own — mirrors
 * SupportModule/ChatwootClientService exactly.
 */
@Module({
  // Leaf ingest module, not EventsModule — Events imports Skills, and Skills
  // imports THIS module for the shared Twilio client, so importing Events
  // here would close a cycle (same reasoning as SupportModule).
  imports: [CanonicalIngestModule],
  controllers: [WhatsappWebhookController, WhatsappAccountsController],
  providers: [WhatsappEngineAdapter, TwilioWhatsappClientService, WhatsappAccountsService],
  exports: [TwilioWhatsappClientService],
})
export class WhatsappModule {}
