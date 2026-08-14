import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Queue } from 'bullmq';
import { Prisma, type KnowledgeDocument } from '@prisma/client';
import type { EmployeeRole, KnowledgeDocumentDto, SearchResultDto } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { clampLimit } from '../../common/pagination';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embeddings/embedding.provider';
import {
  STORAGE_PROVIDER_TOKEN,
  type StorageProvider,
} from './storage/storage.provider';
import {
  INGEST_JOB,
  KNOWLEDGE_INGEST_QUEUE,
  type IngestJobData,
} from './knowledge.constants';
import { SearchDto } from './dto/search.dto';
import { toVectorLiteral } from './knowledge.util';
import { AuditLogService } from '../audit/audit-log.service';
import { AuthorizationService } from '../authorization/authorization.service';

/** Minimal shape of the Multer memory-storage file we consume on upload. */
export interface UploadedDocFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER_TOKEN) private readonly storage: StorageProvider,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @InjectQueue(KNOWLEDGE_INGEST_QUEUE)
    private readonly queue: Queue<IngestJobData>,
    // WAVE 4 §4.3 — knowledge changes are on the plan's critical-audit list:
    // an uploaded document becomes retrievable context for every AI Employee
    // with that role, so who added or removed one is a security question.
    private readonly auditLog: AuditLogService,
    // WAVE 2 §2.1 — department scoping on KnowledgeDocument.category.
    private readonly authz: AuthorizationService,
  ) {}

  /** Store the bytes, create a PENDING doc, and enqueue async ingestion. */
  async upload(
    companyId: string,
    file: UploadedDocFile | undefined,
    category?: EmployeeRole,
  ): Promise<KnowledgeDocumentDto> {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    const storageKey = `${companyId}/${randomUUID()}`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);

    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        companyId,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey,
        status: 'PENDING',
        category: category ?? null,
      },
    });

    await this.queue.add(
      INGEST_JOB,
      { documentId: doc.id, companyId },
      { removeOnComplete: true, removeOnFail: 100 },
    );

    await this.auditLog.record({
      companyId,
      action: 'knowledge.uploaded',
      entityType: 'KnowledgeDocument',
      entityId: doc.id,
      metadata: {
        filename: file.originalname,
        sizeBytes: file.size,
        category: category ?? null,
      },
    });

    return toDocumentDto(doc);
  }

  async list(
    companyId: string,
    category?: EmployeeRole,
    limitRaw?: unknown,
  ): Promise<KnowledgeDocumentDto[]> {
    const docs = await this.prisma.knowledgeDocument.findMany({
      where: category
        ? { companyId, OR: [{ category }, { category: null }] }
        : { companyId },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limitRaw),
    });
    return docs.map(toDocumentDto);
  }

  async get(companyId: string, id: string): Promise<KnowledgeDocumentDto> {
    const doc = await this.findOwned(companyId, id);
    return toDocumentDto(doc);
  }

  /** Raw stored bytes for the "View file" action (tenant-scoped). */
  async getContent(
    companyId: string,
    id: string,
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const doc = await this.findOwned(companyId, id);
    const buffer = await this.storage.get(doc.storageKey);
    return { buffer, mimeType: doc.mimeType, filename: doc.filename };
  }

  async remove(
    companyId: string,
    id: string,
    actorUserId?: string,
  ): Promise<void> {
    const doc = await this.findOwned(companyId, id);
    await this.assertDocScope(companyId, actorUserId, doc, 'knowledge:manage');
    // Best-effort blob delete; the row (and cascaded chunks) go regardless.
    await this.storage.delete(doc.storageKey).catch(() => undefined);
    await this.prisma.knowledgeDocument.delete({ where: { id: doc.id } });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'knowledge.deleted',
      entityType: 'KnowledgeDocument',
      entityId: id,
      metadata: { filename: doc.filename, category: doc.category },
    });
  }

  /**
   * WAVE 2 §2.1 — department-scope a loaded document.
   *
   * `KnowledgeDocument.category` already carries the right axis (the same
   * `EmployeeRole` an AI Employee is scoped by), so this is adoption of the
   * existing authorization layer, not new design. A `null` category means
   * company-wide/Shared and stays visible to everyone.
   */
  private async assertDocScope(
    companyId: string,
    actorUserId: string | undefined,
    doc: { id: string; category: string | null },
    action: 'knowledge:read' | 'knowledge:manage',
  ): Promise<void> {
    const actor = await this.authz.actorById(companyId, actorUserId);
    if (!actor) return;
    await this.authz.assert(actor, action, {
      type: 'knowledge',
      companyId,
      id: doc.id,
      scope: doc.category,
    });
  }

  /**
   * Retags a document's category and cascades the change to its existing
   * chunks. Wrapped in a transaction so a crash between the two writes can
   * never leave a document's category out of sync with its own chunks'
   * (retrieval filters on the chunk-level column, not the document's).
   */
  async updateCategory(
    companyId: string,
    id: string,
    category: EmployeeRole | null,
  ): Promise<KnowledgeDocumentDto> {
    const doc = await this.findOwned(companyId, id);
    const [updated] = await this.prisma.$transaction([
      this.prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { category },
      }),
      this.prisma.knowledgeChunk.updateMany({
        where: { documentId: doc.id },
        data: { category },
      }),
    ]);
    return toDocumentDto(updated);
  }

  /**
   * Cross-module retrieval capability consumed by the employees runtime
   * (RetrievalService). Reuses the exact embed + pgvector cosine search below so
   * the SQL is not duplicated. Tenant-scoped by companyId.
   */
  retrieve(
    companyId: string,
    query: string,
    k = 5,
    category?: EmployeeRole,
    /**
     * Restrict to SHARED documents only (`category IS NULL`).
     *
     * Needed by the workflow RETRIEVE node (§44): a workflow whose category has
     * no `EmployeeRole` equivalent — FINANCE-as-OPERATIONS, IT, COMPLIANCE —
     * cannot name a role to scope by, and no document can be tagged with one
     * either. Falling back to company-wide there would let an IT workflow read
     * HR's documents, which is the leak being closed; shared-only is the tight
     * and truthful answer.
     */
    sharedOnly = false,
  ): Promise<SearchResultDto[]> {
    return this.search(companyId, { query, k, category }, sharedOnly);
  }

  /** Embed the query and return the top-k nearest chunks for this tenant. */
  async search(
    companyId: string,
    dto: SearchDto,
    sharedOnly = false,
  ): Promise<SearchResultDto[]> {
    const k = dto.k ?? 5;
    const [vector] = await this.embeddings.embed([dto.query]);
    const literal = toVectorLiteral(vector);
    const categoryFilter = sharedOnly
      ? Prisma.sql`AND "category" IS NULL`
      : dto.category
        ? Prisma.sql`AND ("category" = ${dto.category}::"EmployeeRole" OR "category" IS NULL)`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; documentId: string; content: string; score: number }>
    >(Prisma.sql`
      SELECT "id", "documentId", "content", 1 - (embedding <=> ${literal}::vector) AS score
      FROM "KnowledgeChunk"
      WHERE "companyId" = ${companyId} AND embedding IS NOT NULL
      ${categoryFilter}
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${k}
    `);

    return rows.map((r) => ({
      chunkId: r.id,
      documentId: r.documentId,
      content: r.content,
      score: Number(r.score),
    }));
  }

  private async findOwned(
    companyId: string,
    id: string,
  ): Promise<KnowledgeDocument> {
    const doc = await this.prisma.knowledgeDocument.findFirst({
      where: { id, companyId },
    });
    if (!doc) {
      throw new NotFoundException('Document not found');
    }
    return doc;
  }
}

function toDocumentDto(doc: KnowledgeDocument): KnowledgeDocumentDto {
  return {
    id: doc.id,
    companyId: doc.companyId,
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    error: doc.error,
    chunkCount: doc.chunkCount,
    createdAt: doc.createdAt.toISOString(),
    category: doc.category,
  };
}
