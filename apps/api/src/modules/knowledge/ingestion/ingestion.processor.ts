import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../embeddings/embedding.provider';
import {
  STORAGE_PROVIDER_TOKEN,
  type StorageProvider,
} from '../storage/storage.provider';
import {
  INGEST_JOB,
  KNOWLEDGE_INGEST_QUEUE,
  type IngestJobData,
} from '../knowledge.constants';
import { chunkText, extractText, toVectorLiteral } from '../knowledge.util';
import { toQueueError } from '../../../common/resilience/queue-retry';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../../common/resilience/queue-concurrency.constants';
import { runInJobContext } from '../../../common/observability/job-context';

const EMBED_BATCH = 16;

/**
 * In-process BullMQ worker that turns an uploaded document into searchable
 * chunks: PROCESSING → fetch bytes → extract text → chunk → embed (batched) →
 * insert chunks (raw SQL, ::vector cast) → READY. Any failure flips the doc to
 * FAILED with the error message and rethrows so BullMQ records the failure.
 */
@Processor(KNOWLEDGE_INGEST_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER_TOKEN) private readonly storage: StorageProvider,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {
    super();
  }

  async process(job: Job<IngestJobData>): Promise<void> {
    // Correlation: an AsyncLocalStorage store does not survive the queue
    // hop, so it is re-established here from the job payload.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job<IngestJobData>): Promise<void> {
    if (job.name !== INGEST_JOB) {
      return;
    }
    const { documentId } = job.data;
    const doc = await this.prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc) {
      this.logger.warn(`Ingest job for missing document ${documentId}`);
      return;
    }

    try {
      await this.prisma.knowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'PROCESSING', error: null },
      });

      const bytes = await this.storage.get(doc.storageKey);
      const text = await extractText(bytes, doc.mimeType, doc.filename);
      const chunks = chunkText(text);

      // Idempotent re-ingest: clear any chunks from a previous attempt.
      await this.prisma.knowledgeChunk.deleteMany({ where: { documentId } });

      let inserted = 0;
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const vectors = await this.embeddings.embed(batch);
        for (let j = 0; j < batch.length; j += 1) {
          const literal = toVectorLiteral(vectors[j]);
          // Prisma cannot write the Unsupported vector column, so insert via
          // raw SQL with a ::vector cast. id/createdAt have no DB-level default
          // (Prisma applies those client-side), so we supply them explicitly.
          await this.prisma.$executeRaw`
            INSERT INTO "KnowledgeChunk" ("id", "documentId", "companyId", "content", "chunkIndex", "embedding", "category", "createdAt")
            VALUES (${randomUUID()}, ${documentId}, ${doc.companyId}, ${batch[j]}, ${inserted}, ${literal}::vector, ${doc.category}::"EmployeeRole", now())
          `;
          inserted += 1;
        }
      }

      await this.prisma.knowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'READY', chunkCount: inserted, error: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Ingest failed for ${documentId}: ${message}`);
      await this.prisma.knowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'FAILED', error: message },
      });
      // Terminal errors (bad file, validation) go straight to the DLQ; transient
      // ones (I/O, provider) use the queue's bounded backoff (docs §4.4).
      throw toQueueError(err);
    }
  }
}
