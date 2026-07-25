import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KNOWLEDGE_INGEST_QUEUE } from './knowledge.constants';
import { RESILIENT_JOB_OPTIONS } from '../../common/resilience/queue-retry';
import { IngestionProcessor } from './ingestion/ingestion.processor';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embeddings/embedding.provider';
import { HashEmbeddingProvider } from './embeddings/hash-embedding.provider';
import { LocalEmbeddingProvider } from './embeddings/local-embedding.provider';
import { OpenAIEmbeddingProvider } from './embeddings/openai-embedding.provider';
import {
  STORAGE_PROVIDER_TOKEN,
  type StorageProvider,
} from './storage/storage.provider';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { S3StorageProvider } from './storage/s3-storage.provider';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { redisConnectionFromUrl } from '../../common/resilience/redis-connection';

/** Parse REDIS_URL into ioredis connection options for BullMQ. */
function redisConnection(config: ConfigService) {
  return {
    ...redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
    // Required by BullMQ blocking commands (workers) on ioredis.
    maxRetriesPerRequest: null,
  };
}

/** Pick the embedding backend from EMBEDDINGS_PROVIDER (default: hash). */
function embeddingFactory(config: ConfigService): EmbeddingProvider {
  const kind = (config.get<string>('EMBEDDINGS_PROVIDER') ?? 'hash').toLowerCase();
  switch (kind) {
    case 'local':
      return new LocalEmbeddingProvider();
    case 'openai':
      return new OpenAIEmbeddingProvider(config);
    case 'hash':
    default:
      return new HashEmbeddingProvider();
  }
}

/** Pick the storage backend from STORAGE_PROVIDER (default: local). */
function storageFactory(config: ConfigService): StorageProvider {
  const kind = (config.get<string>('STORAGE_PROVIDER') ?? 'local').toLowerCase();
  if (kind === 's3') {
    return new S3StorageProvider(config);
  }
  const dir = config.get<string>('STORAGE_DIR') ?? '.storage';
  return new LocalStorageProvider(dir);
}

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnection(config),
        // Bounded attempts + exponential-with-jitter backoff + keep-failed (=DLQ)
        // for EVERY queue (docs §4.4). Per-`add()` opts still merge over these.
        defaultJobOptions: RESILIENT_JOB_OPTIONS,
      }),
    }),
    BullModule.registerQueue({ name: KNOWLEDGE_INGEST_QUEUE }),
  ],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    ...(queueWorkersEnabled() ? [IngestionProcessor] : []),
    // Swap these useFactory selections via env to change backends later.
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ConfigService],
      useFactory: embeddingFactory,
    },
    {
      provide: STORAGE_PROVIDER_TOKEN,
      inject: [ConfigService],
      useFactory: storageFactory,
    },
  ],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
