import { ChatwootEngineAdapter } from './chatwoot-engine.adapter';
import { Module } from '@nestjs/common';
import { CanonicalIngestModule } from '../../events/ingestion/canonical-ingest.module';
import { ChatwootClientService } from './chatwoot-client.service';
import { SupportWebhookController } from './support-webhook.controller';

/**
 * Support engine module: the Chatwoot REST client and the signature-verified
 * webhook receiver (docs/architecture/engines/chatwoot-engine.md §4/§20 — the
 * Agent Bot seam). Exports ChatwootClientService so SkillsModule's
 * RealSkillExecutor can use the same single instance rather than standing up
 * its own — mirrors MarketingModule/PostizClientService exactly.
 *
 * Unlike Marketing/Postiz, Chatwoot conversations are updated live via this
 * webhook itself, not a delayed external process, so there is no
 * reconciliation-sync BullMQ processor here (no concrete need was found for
 * one — see the task-5 report for the full reasoning).
 */
@Module({
  // WAVE 3 §3.4 — the canonical pipeline. The LEAF ingest module, not
  // EventsModule: Events imports Skills, and Skills imports THIS module for the
  // shared Chatwoot client, so importing Events here would close a cycle.
  imports: [CanonicalIngestModule],
  controllers: [SupportWebhookController],
  providers: [ChatwootEngineAdapter, ChatwootClientService],
  exports: [ChatwootClientService],
})
export class SupportModule {}
