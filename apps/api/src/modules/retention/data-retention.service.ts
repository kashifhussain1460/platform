import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, WorkflowRun } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import {
  STORAGE_PROVIDER_TOKEN,
  type StorageProvider,
} from '../knowledge/storage/storage.provider';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Rows handled per pass. Bounds memory and the transaction footprint. */
const BATCH_SIZE = 1_000;

/** Every class this sweep is responsible for, and what it counted. */
export interface RetentionCounts {
  workflowRuns: number;
  workflowStepRuns: number;
  workflowStepAttempts: number;
  outboxEvents: number;
  rawEvents: number;
  canonicalEvents: number;
  knowledgeDocuments: number;
  knowledgeChunks: number;
  employeeMemories: number;
  conversations: number;
  skillExecutions: number;
  mediaAssets: number;
  /** Object-storage blobs removed alongside their rows. */
  attachments: number;
}

export interface RetentionResult {
  companiesScanned: number;
  companiesHeld: number;
  deleted: RetentionCounts;
  /** Set on a preview: nothing was actually deleted. */
  dryRun?: boolean;
}

const ZERO: RetentionCounts = {
  workflowRuns: 0,
  workflowStepRuns: 0,
  workflowStepAttempts: 0,
  outboxEvents: 0,
  rawEvents: 0,
  canonicalEvents: 0,
  knowledgeDocuments: 0,
  knowledgeChunks: 0,
  employeeMemories: 0,
  conversations: 0,
  skillExecutions: 0,
  mediaAssets: 0,
  attachments: 0,
};

/**
 * WAVE 8 §8.3 — operational data retention.
 *
 * The plan lists ten classes that retention must cover. Two of them already had
 * a sweep and are deliberately NOT touched here:
 *
 * - **audit** — `AuditRetentionService`. It has its own 365-day floor and its
 *   own archive tier, precisely so a tenant cannot shorten its own evidence
 *   trail by changing an operational setting. Sweeping it from here would
 *   defeat that.
 * - **HR data** — `HrRetentionService`, which prunes satellites and never the
 *   staff roster.
 *
 * This service covers the rest: workflow runs, step runs, step attempts, the
 * run-event outbox, provider snapshots (raw + canonical events), knowledge,
 * memory, conversations, skill executions and attachments.
 *
 * Three rules it will not bend:
 *
 * 1. **A legal hold stops everything.** Checked first, per company, before any
 *    cutoff is computed.
 * 2. **In-flight runs are never deleted.** Only terminal runs age out. Deleting
 *    a `WAITING` run would destroy a live approval and strand whatever was
 *    waiting on it.
 * 3. **A row and its bytes go together.** Deleting a `KnowledgeDocument` while
 *    leaving its upload in the bucket means the data was not actually deleted —
 *    which is the whole point of a retention policy, and the thing an erasure
 *    request is checked against.
 *
 * `dataRetentionDays = 0` (the default) means keep for ever and is skipped, so
 * no existing tenant starts losing data because this shipped.
 */
@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER_TOKEN)
    private readonly storage: StorageProvider,
  ) {}

  /** Sweep every company that has opted into a retention window. */
  async sweep(asOf: Date = new Date()): Promise<RetentionResult> {
    const policies = await this.prisma.securityPolicy.findMany({
      where: { dataRetentionDays: { gt: 0 } },
      select: { companyId: true, dataRetentionDays: true },
    });

    const deleted = { ...ZERO };
    let companiesHeld = 0;

    for (const policy of policies) {
      const cutoff = new Date(asOf.getTime() - policy.dataRetentionDays * MS_PER_DAY);
      const result = await this.sweepCompany(policy.companyId, cutoff, false);
      if (result === 'HELD') {
        companiesHeld++;
        continue;
      }
      for (const key of Object.keys(deleted) as (keyof RetentionCounts)[]) {
        deleted[key] += result[key];
      }
    }

    return { companiesScanned: policies.length, companiesHeld, deleted };
  }

  /**
   * What a sweep WOULD delete for one company, without deleting it.
   *
   * §8.3 asks for manual deletion and audit evidence. Both are much safer with
   * a preview: "delete everything older than 90 days" is a sentence people
   * agree to before they know it means 4,000 workflow runs.
   */
  async preview(companyId: string, asOf: Date = new Date()): Promise<RetentionResult> {
    const policy = await this.prisma.securityPolicy.findUnique({
      where: { companyId },
      select: { dataRetentionDays: true },
    });
    const days = policy?.dataRetentionDays ?? 0;
    if (days <= 0) {
      return { companiesScanned: 0, companiesHeld: 0, deleted: { ...ZERO }, dryRun: true };
    }
    const cutoff = new Date(asOf.getTime() - days * MS_PER_DAY);
    const result = await this.sweepCompany(companyId, cutoff, true);
    if (result === 'HELD') {
      return { companiesScanned: 1, companiesHeld: 1, deleted: { ...ZERO }, dryRun: true };
    }
    return { companiesScanned: 1, companiesHeld: 0, deleted: result, dryRun: true };
  }

  /** Run the sweep for ONE company now (manual deletion, §8.3). */
  async runForCompany(
    companyId: string,
    actorUserId: string,
    asOf: Date = new Date(),
  ): Promise<RetentionResult> {
    const policy = await this.prisma.securityPolicy.findUnique({
      where: { companyId },
      select: { dataRetentionDays: true },
    });
    const days = policy?.dataRetentionDays ?? 0;
    if (days <= 0) {
      return { companiesScanned: 0, companiesHeld: 0, deleted: { ...ZERO } };
    }
    const cutoff = new Date(asOf.getTime() - days * MS_PER_DAY);
    const result = await this.sweepCompany(companyId, cutoff, false, actorUserId);
    if (result === 'HELD') {
      return { companiesScanned: 1, companiesHeld: 1, deleted: { ...ZERO } };
    }
    return { companiesScanned: 1, companiesHeld: 0, deleted: result };
  }

  // --- the sweep itself -------------------------------------------------------

  private async sweepCompany(
    companyId: string,
    cutoff: Date,
    dryRun: boolean,
    actorUserId?: string,
  ): Promise<RetentionCounts | 'HELD'> {
    // Rule 1. Before any cutoff arithmetic, so no policy misconfiguration can
    // get past it.
    if (await this.audit.hasActiveLegalHold(companyId, 'ALL')) {
      this.logger.log(
        `data retention: company=${companyId} is under legal hold — nothing deleted`,
      );
      return 'HELD';
    }

    const counts = { ...ZERO };

    // Rule 2. Terminal runs only. A PENDING/RUNNING/WAITING run is live work.
    const runWhere: Prisma.WorkflowRunWhereInput = {
      companyId,
      createdAt: { lt: cutoff },
      status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
    };

    if (dryRun) {
      counts.workflowRuns = await this.prisma.workflowRun.count({ where: runWhere });
    } else {
      // Batched: a tenant with a year of runs is millions of rows, and one
      // unbounded delete would either lock the table for minutes or blow the
      // transaction. A chunk at a time also makes partial progress durable —
      // an interrupted sweep keeps whatever it already finished.
      for (;;) {
        const batch = await this.prisma.workflowRun.findMany({
          where: runWhere,
          select: { id: true },
          take: BATCH_SIZE,
        });
        if (batch.length === 0) break;
        const ids = batch.map((r) => r.id);

        // Archive before deleting. A completed run is the record of what an AI
        // Employee did on the company's behalf — who approved it, which tools
        // fired, what came back. Retention should bound what is ONLINE, not
        // erase the answer to "what happened in March".
        try {
          await this.archiveRuns(companyId, cutoff, ids);
        } catch (err) {
          this.logger.error(
            `data retention: run archive FAILED for company=${companyId}; ` +
              `deletion skipped, will retry next sweep — ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
          break;
        }

        // Counted before the delete: WorkflowStepRun, WorkflowStepAttempt,
        // RunEventOutbox, timers and join state all cascade from WorkflowRun,
        // so afterwards there is nothing left to count and the report would
        // claim the sweep removed far less than it did.
        const [steps, attempts, outbox] = await this.prisma.$transaction([
          this.prisma.workflowStepRun.count({ where: { runId: { in: ids } } }),
          this.prisma.workflowStepAttempt.count({ where: { runId: { in: ids } } }),
          this.prisma.runEventOutbox.count({ where: { runId: { in: ids } } }),
        ]);
        const removed = await this.prisma.workflowRun.deleteMany({
          where: { id: { in: ids } },
        });

        counts.workflowRuns += removed.count;
        counts.workflowStepRuns += steps;
        counts.workflowStepAttempts += attempts;
        counts.outboxEvents += outbox;
        if (batch.length < BATCH_SIZE) break;
      }
    }

    // Provider snapshots. Raw payloads are the rawest personal data the system
    // holds — a whole inbound email, headers included — so they age out with
    // everything else rather than living for ever as debugging convenience.
    counts.rawEvents = await this.countOrDelete(
      'rawEvent',
      { companyId, receivedAt: { lt: cutoff } },
      dryRun,
    );
    counts.canonicalEvents = await this.countOrDelete(
      'canonicalEvent',
      { companyId, receivedAt: { lt: cutoff } },
      dryRun,
    );

    // Knowledge: rows AND the uploaded files behind them (rule 3).
    const knowledge = await this.sweepAttachments(
      companyId,
      cutoff,
      dryRun,
      'knowledgeDocument',
    );
    counts.knowledgeDocuments = knowledge.rows;
    counts.knowledgeChunks = knowledge.extra;
    counts.attachments += knowledge.blobs;

    const media = await this.sweepAttachments(companyId, cutoff, dryRun, 'mediaAsset');
    counts.mediaAssets = media.rows;
    counts.attachments += media.blobs;

    counts.employeeMemories = await this.countOrDelete(
      'employeeMemory',
      { companyId, createdAt: { lt: cutoff } },
      dryRun,
    );
    // Messages cascade from Conversation.
    counts.conversations = await this.countOrDelete(
      'conversation',
      { companyId, createdAt: { lt: cutoff } },
      dryRun,
    );
    counts.skillExecutions = await this.countOrDelete(
      'skillExecution',
      { companyId, createdAt: { lt: cutoff } },
      dryRun,
    );

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0 && !dryRun) {
      // §8.3 "audit evidence". Written after the deletion, and deliberately not
      // swept by this service (audit has its own retention with a floor), so
      // the record of what was removed outlives what was removed.
      await this.audit.record({
        companyId,
        actorUserId,
        actorType: actorUserId ? 'USER' : 'SYSTEM',
        action: 'data.retention.deleted',
        entityType: 'Company',
        entityId: companyId,
        metadata: { olderThan: cutoff.toISOString(), ...counts },
      });
      this.logger.log(
        `data retention: company=${companyId} removed ${total} records older than ${cutoff.toISOString()}`,
      );
    }
    return counts;
  }

  /**
   * Count (dry run) or delete a plain time-bounded class.
   *
   * The model is looked up by name off the Prisma client because these differ
   * only by delegate and where-clause; a dozen near-identical blocks would hide
   * the one that was wrong.
   */
  private async countOrDelete(
    model:
      | 'rawEvent'
      | 'canonicalEvent'
      | 'employeeMemory'
      | 'conversation'
      | 'skillExecution',
    where: Record<string, unknown>,
    dryRun: boolean,
  ): Promise<number> {
    const delegate = this.prisma[model] as unknown as {
      count(a: { where: unknown }): Promise<number>;
      deleteMany(a: { where: unknown }): Promise<{ count: number }>;
    };
    if (dryRun) return delegate.count({ where });
    const result = await delegate.deleteMany({ where });
    return result.count;
  }

  /**
   * Delete rows that own a file in object storage, and the file with them.
   *
   * Order matters: the ROW goes first, then the blob. The reverse leaves a live
   * record pointing at a missing file — a document that lists in the UI and
   * 404s when opened. This way a storage failure leaves an orphaned blob, which
   * is wasted bytes rather than a broken product, and is logged so it can be
   * swept later.
   */
  private async sweepAttachments(
    companyId: string,
    cutoff: Date,
    dryRun: boolean,
    model: 'knowledgeDocument' | 'mediaAsset',
  ): Promise<{ rows: number; extra: number; blobs: number }> {
    const where = { companyId, createdAt: { lt: cutoff } };
    const delegate = this.prisma[model] as unknown as {
      findMany(a: {
        where: unknown;
        select: unknown;
        take: number;
      }): Promise<{ id: string; storageKey: string }[]>;
      deleteMany(a: { where: unknown }): Promise<{ count: number }>;
      count(a: { where: unknown }): Promise<number>;
    };

    if (dryRun) {
      const rows = await delegate.count({ where });
      const extra =
        model === 'knowledgeDocument'
          ? await this.prisma.knowledgeChunk.count({
              where: { companyId, createdAt: { lt: cutoff } },
            })
          : 0;
      return { rows, extra, blobs: rows };
    }

    let rows = 0;
    let extra = 0;
    let blobs = 0;
    for (;;) {
      const batch = await delegate.findMany({
        where,
        select: { id: true, storageKey: true },
        take: BATCH_SIZE,
      });
      if (batch.length === 0) break;
      const ids = batch.map((r) => r.id);

      if (model === 'knowledgeDocument') {
        extra += await this.prisma.knowledgeChunk.count({
          where: { documentId: { in: ids } },
        });
      }
      const removed = await delegate.deleteMany({ where: { id: { in: ids } } });
      rows += removed.count;

      for (const row of batch) {
        if (!row.storageKey) continue;
        try {
          await this.storage.delete(row.storageKey);
          blobs++;
        } catch (err) {
          // Best-effort BY DESIGN — see the method doc. Logged rather than
          // swallowed so the orphan is findable.
          this.logger.warn(
            `data retention: row ${row.id} deleted but its object ${row.storageKey} was not — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (batch.length < BATCH_SIZE) break;
    }
    return { rows, extra, blobs };
  }

  /** Archive a batch of runs as NDJSON, mirroring the audit archive format. */
  private async archiveRuns(
    companyId: string,
    cutoff: Date,
    runIds: readonly string[],
  ): Promise<void> {
    const runs = await this.prisma.workflowRun.findMany({
      where: { id: { in: [...runIds] } },
      include: { steps: true },
    });
    const ndjson = runs
      .map((run) =>
        JSON.stringify({
          ...serialiseRun(run),
          steps: (run as WorkflowRun & { steps: unknown[] }).steps,
        }),
      )
      .join(String.fromCharCode(10));
    // Keyed by the first run id in the batch: unique, re-derivable, so a re-run
    // that archives the same rows overwrites one object instead of littering.
    const key =
      `run-archive/${companyId}/${cutoff.toISOString().slice(0, 10)}` +
      `-${runIds[0]}.ndjson`;
    await this.storage.put(key, Buffer.from(ndjson, 'utf8'), 'application/x-ndjson');
  }
}

/** Dates to ISO so the archive is readable without the Prisma client. */
function serialiseRun(run: WorkflowRun): Record<string, unknown> {
  return {
    ...run,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
