import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  STORAGE_PROVIDER_TOKEN,
} from '../knowledge/storage/storage.provider';
import { storageFactory } from '../knowledge/knowledge.module';
import { AuditLogController } from './audit-log.controller';
import { AuditLegalHoldService } from './audit-legal-hold.service';
import { AuditLogService } from './audit-log.service';
import { AuditRetentionService } from './audit-retention.service';

/**
 * `@Global` so AuditLogService can be injected from workflows/users/skills/
 * organization without each importing this module (same pattern as
 * ResilienceModule/PrismaModule).
 */
@Global()
@Module({
  controllers: [AuditLogController],
  providers: [
    AuditLogService,
    AuditLegalHoldService,
    AuditRetentionService,
    // WAVE 4 §4.5 archive tier. Its OWN instance of the configured provider
    // rather than an import of KnowledgeModule: the provider is stateless, and
    // Audit is @Global — pulling a feature module in here would invert the
    // dependency direction for every consumer.
    {
      provide: STORAGE_PROVIDER_TOKEN,
      inject: [ConfigService],
      useFactory: storageFactory,
    },
  ],
  exports: [AuditLogService, AuditLegalHoldService, AuditRetentionService],
})
export class AuditModule {}
