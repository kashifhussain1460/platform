import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EVENT_NORMALIZE_QUEUE } from '../events.constants';
import { CanonicalIngestService } from './canonical-ingest.service';

/**
 * WAVE 3 §3.2 — the canonical ingest as a LEAF module.
 *
 * It cannot live in `EventsModule`, which imports `SkillsModule` (the
 * InstalledSkill IS the connector). `SkillsModule` in turn imports
 * `SupportModule` for the shared Chatwoot client — so a Support → Events edge
 * closes `Skills → Support → Events → Skills`, and Nest refuses to instantiate
 * it. (Discovered exactly that way: every events and approvals e2e suite failed
 * at module construction, not at any assertion.)
 *
 * `CanonicalIngestService` needs only Prisma (global) and the normalize QUEUE,
 * so forking it into a leaf that depends on neither Events nor Skills lets every
 * engine reach it. Same shape as `EngineModeModule` from WAVE 1.
 *
 * Keep it a leaf. The moment this needs `SkillsService`, the cycle returns.
 */
@Module({
  imports: [BullModule.registerQueue({ name: EVENT_NORMALIZE_QUEUE })],
  providers: [CanonicalIngestService],
  exports: [CanonicalIngestService],
})
export class CanonicalIngestModule {}
