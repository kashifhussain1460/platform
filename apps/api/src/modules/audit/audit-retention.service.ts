import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditLog } from '@prisma/client';
import {
  STORAGE_PROVIDER_TOKEN,
  type StorageProvider,
} from '../knowledge/storage/storage.provider';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from './audit-log.service';

export interface AuditRetentionResult {
  companiesScanned: number;
  companiesHeld: number;
  deleted: number;
}

/**
 * The floor on how long audit stays, regardless of the company's normal
 * data-retention setting.
 *
 * §4.5 lists "normal retention" and "audit retention" as SEPARATE policies for
 * a reason: a company setting a 30-day data-retention window is talking about
 * its operational data, not about erasing the record of who changed its
 * permissions. Honouring `dataRetentionDays` directly here would let a tenant
 * quietly shorten its own audit trail — which is precisely the move an audit
 * trail exists to make visible.
 */
export const MIN_AUDIT_RETENTION_DAYS = 365;

/** Rows archived+deleted per pass. Bounds memory and the transaction footprint. */
const ARCHIVE_BATCH_SIZE = 1_000;

/**
 * WAVE 4 §4.5 — audit retention, with legal hold.
 *
 * Deliberately conservative: it deletes only what is BOTH older than the
 * company's effective audit retention AND not under a legal hold. Everything
 * else is left alone. Over-retaining audit costs storage; under-retaining it
 * destroys evidence.
 */
@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(STORAGE_PROVIDER_TOKEN)
    private readonly storage: StorageProvider,
  ) {}

  /**
   * Sweep every company. Cross-tenant by design (a background job), and it
   * re-reads each company's own policy rather than trusting a caller.
   */
  async sweep(): Promise<AuditRetentionResult> {
    // Only consider companies that actually HAVE something expirable.
    //
    // The first version iterated every Company row and ran a legal-hold check, a
    // policy read and a scan for each — three queries per tenant per night,
    // whether or not it had a single deletable entry. At a few thousand tenants
    // that is ~10k queries to usually delete nothing, and it stalled the sweep
    // long enough to look like a hang. One grouped query answers "who is even a
    // candidate", and the per-tenant work then runs only for those.
    //
    // The floor is the widest possible cutoff: a company's own retention can
    // only be LONGER, so nothing newer than this can be deletable for anyone.
    const widestCutoff = new Date(
      Date.now() - MIN_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const candidates = await this.prisma.auditLog.groupBy({
      by: ['companyId'],
      where: { createdAt: { lt: widestCutoff } },
    });
    const companies = candidates.map((c) => ({ id: c.companyId }));

    let companiesHeld = 0;
    let deleted = 0;

    for (const company of companies) {
      // §4.5: "Never delete an event under legal hold." Checked FIRST, so no
      // amount of policy misconfiguration can get past it.
      if (await this.audit.hasActiveLegalHold(company.id)) {
        companiesHeld++;
        continue;
      }

      const days = await this.effectiveRetentionDays(company.id);
      if (days <= 0) continue; // 0 = keep for ever.

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // §4.5 ARCHIVE, before deletion, IN BOUNDED BATCHES.
      //
      // Deleting audit with no archive step means the evidence is simply gone.
      // Exporting it first — as the same verifiable NDJSON the export endpoint
      // produces, hashes included — means the retention window bounds what is
      // ONLINE, not what exists.
      //
      // Batched deliberately: the first version of this loaded every expiring
      // row for every company into memory in one `findMany`, which is fine on a
      // fresh database and pathological on a real one — a tenant with a year of
      // audit is millions of rows, and the sweep would either OOM or stall the
      // job for so long it never completed. A chunk at a time bounds memory AND
      // makes partial progress durable: an interrupted sweep has already
      // archived and deleted whatever it got through.
      let companyDeleted = 0;
      for (;;) {
        const batch = await this.prisma.auditLog.findMany({
          where: { companyId: company.id, createdAt: { lt: cutoff } },
          orderBy: { seq: 'asc' },
          take: ARCHIVE_BATCH_SIZE,
        });
        if (batch.length === 0) break;

        // Archiving is REQUIRED, not best-effort: if the archive write fails the
        // deletion is skipped and retried next sweep. Deleting evidence because
        // storage was briefly unavailable is not an acceptable failure mode.
        try {
          await this.archive(company.id, cutoff, batch);
        } catch (err) {
          this.logger.error(
            `audit retention: archive FAILED for company=${company.id}; ` +
              `deletion skipped and will retry — ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
          break;
        }

        const result = await this.prisma.auditLog.deleteMany({
          where: { id: { in: batch.map((r) => r.id) } },
        });
        companyDeleted += result.count;
        if (batch.length < ARCHIVE_BATCH_SIZE) break;
      }

      if (companyDeleted > 0) {
        deleted += companyDeleted;
        // Deleting audit is itself an auditable act (§4.3 "Retention deletion").
        // Written AFTER the delete so the entry is not itself swept.
        await this.audit.record({
          companyId: company.id,
          actorType: 'SYSTEM',
          action: 'audit.retention.deleted',
          entityType: 'AuditLog',
          metadata: {
            deleted: companyDeleted,
            olderThan: cutoff.toISOString(),
            retentionDays: days,
            archived: true,
          },
        });
        this.logger.log(
          `audit retention: archived + deleted ${companyDeleted} entries older than ${cutoff.toISOString()} for company=${company.id}`,
        );
      }
    }

    return { companiesScanned: companies.length, companiesHeld, deleted };
  }

  /**
   * Write the archive: verifiable NDJSON, one object per line, hashes included.
   *
   * Uses the same StorageProvider as knowledge documents, so it follows whatever
   * the deployment already configured (`local` dir or S3/MinIO) rather than
   * inventing a second storage story.
   */
  private async archive(
    companyId: string,
    cutoff: Date,
    rows: readonly AuditLog[],
  ): Promise<void> {
    const ndjson = rows
      .map((r) =>
        JSON.stringify({
          ...r,
          seq: String(r.seq),
          createdAt: r.createdAt.toISOString(),
        }),
      )
      .join(String.fromCharCode(10));
    // Keyed by the FIRST sequence in the batch: unique per batch, ordered, and
    // re-derivable — so a re-run that archives the same rows overwrites the same
    // object rather than littering storage with near-duplicates.
    const key =
      `audit-archive/${companyId}/${cutoff.toISOString().slice(0, 10)}` +
      `-seq${rows[0].seq}.ndjson`;
    await this.storage.put(key, Buffer.from(ndjson, 'utf8'), 'application/x-ndjson');
    this.logger.log(
      `audit retention: archived ${rows.length} entries for company=${companyId} → ${key}`,
    );
  }

  /**
   * The company's audit retention in days.
   *
   * `dataRetentionDays` is honoured only where it is LONGER than the audit
   * floor. A tenant may keep audit for longer than its operational data; it may
   * not use the operational setting to keep it for less.
   */
  private async effectiveRetentionDays(companyId: string): Promise<number> {
    const policy = await this.prisma.securityPolicy.findUnique({
      where: { companyId },
      select: { dataRetentionDays: true },
    });
    const configured = policy?.dataRetentionDays ?? 0;
    if (configured <= 0) return MIN_AUDIT_RETENTION_DAYS;
    return Math.max(configured, MIN_AUDIT_RETENTION_DAYS);
  }
}
