import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { storageFactory } from '../knowledge/knowledge.module';
import { STORAGE_PROVIDER_TOKEN } from '../knowledge/storage/storage.provider';
import { DataRetentionService } from './data-retention.service';
import { RetentionController } from './retention.controller';

/**
 * WAVE 8 §8.3 — operational data retention.
 *
 * A leaf module: PrismaService and AuditLogService are both global, so the only
 * thing to wire is the storage provider (attachments have to be deleted with
 * their rows, and archives written before runs are removed). Its own instance
 * of the configured provider, exactly as AuditModule does — the provider is
 * stateless, and importing KnowledgeModule here would pull a feature module in
 * behind a background sweep.
 */
@Module({
  controllers: [RetentionController],
  providers: [
    DataRetentionService,
    {
      provide: STORAGE_PROVIDER_TOKEN,
      inject: [ConfigService],
      useFactory: storageFactory,
    },
  ],
  exports: [DataRetentionService],
})
export class RetentionModule {}
