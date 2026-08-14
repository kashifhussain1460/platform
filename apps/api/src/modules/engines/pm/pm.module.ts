import { Module } from '@nestjs/common';
import { CanonicalIngestModule } from '../../events/ingestion/canonical-ingest.module';
import { PlaneClientService } from './plane-client.service';
import { PlaneEngineAdapter } from './plane-engine.adapter';
import { PmWebhookController } from './pm-webhook.controller';

/**
 * WAVE 3 §3.5 — the Plane (project management) engine module.
 *
 * Plane previously had a client but no module and no inbound path: it could push
 * work out and nothing could come back. This adds the signature-verified webhook
 * receiver and routes it into the shared canonical event pipeline.
 *
 * `PlaneClientService` is ALSO provided by SkillsModule (for RealSkillExecutor).
 * That is a second instance, not a shared one — it is a stateless HTTP client
 * over ConfigService, so a second instance costs nothing and avoids a
 * Skills ↔ Pm import edge. Contrast SupportModule/MarketingModule, which export
 * their clients because SkillsModule already imports those modules.
 */
@Module({
  imports: [CanonicalIngestModule],
  controllers: [PmWebhookController],
  providers: [PlaneClientService, PlaneEngineAdapter],
  exports: [PlaneClientService],
})
export class PmModule {}
