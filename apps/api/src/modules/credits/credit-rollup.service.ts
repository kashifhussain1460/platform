import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decimalToNumber } from './credits.types';

export interface DailyRollupRow {
  companyId: string;
  employeeId: string | null;
  day: string;
  creditsGranted: number;
  creditsConsumed: number;
  creditsRefunded: number;
  /** Signed (a correction can move either direction) — see class doc. */
  creditsAdjusted: number;
}

/**
 * Credit system Phase 10, Task 10.4 (§24/§27) — nightly job populating
 * `CreditUsageDailyRollup`. `FinanceReportingController` reads ONLY this
 * table (never the raw ledger) for cross-tenant scans.
 */
@Injectable()
export class CreditRollupService {
  constructor(private readonly prisma: PrismaService) {}

  async runNightly(dateUtc: Date): Promise<{ day: string; rowsUpserted: number }> {
    const dayStart = new Date(
      Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    type Bucket = {
      companyId: string;
      employeeId: string;
      granted: number;
      consumed: number;
      refunded: number;
      adjusted: number;
    };
    const buckets = new Map<string, Bucket>();
    const keyOf = (companyId: string, employeeId: string) => `${companyId}::${employeeId}`;
    const emptyBucket = (companyId: string, employeeId: string): Bucket => ({
      companyId,
      employeeId,
      granted: 0,
      consumed: 0,
      refunded: 0,
      adjusted: 0,
    });
    // ADJUSTMENT is signed (a correction can move either direction) — every
    // other type here is summed as an absolute magnitude, since the ledger's
    // own sign convention (DEBIT negative, CREDIT/REFUND positive) is an
    // internal bookkeeping detail this report isn't meant to expose.
    const applyAmount = (bucket: Bucket, transactionType: string, rawSum: Prisma.Decimal | null) => {
      const signed = decimalToNumber(rawSum ?? new Prisma.Decimal(0));
      if (transactionType === 'CREDIT') bucket.granted += Math.abs(signed);
      else if (transactionType === 'DEBIT') bucket.consumed += Math.abs(signed);
      else if (transactionType === 'REFUND') bucket.refunded += Math.abs(signed);
      // Gap fix (Task 10.4): ADJUSTMENT rows (Task 10.2's manual
      // corrections — "the single most protected mutation in the system")
      // were previously dropped entirely from this rollup.
      else if (transactionType === 'ADJUSTMENT') bucket.adjusted += signed;
    };

    // Pass 1 — company-level totals (employeeId='' sentinel), summing EVERY
    // entry for the company regardless of which employee (or none) it's on.
    const companyRows = await this.prisma.creditLedger.groupBy({
      by: ['companyId', 'transactionType'],
      where: { createdAt: { gte: dayStart, lt: dayEnd } },
      _sum: { amount: true },
    });
    for (const row of companyRows) {
      const key = keyOf(row.companyId, '');
      const bucket = buckets.get(key) ?? emptyBucket(row.companyId, '');
      applyAmount(bucket, row.transactionType, row._sum.amount);
      buckets.set(key, bucket);
    }

    // Pass 2 — per-employee breakdown, excluding employee-less entries (those
    // are already folded into the company-level row above and have no
    // meaningful employee bucket of their own).
    const employeeRows = await this.prisma.creditLedger.groupBy({
      by: ['companyId', 'employeeId', 'transactionType'],
      where: { createdAt: { gte: dayStart, lt: dayEnd }, employeeId: { not: null } },
      _sum: { amount: true },
    });
    for (const row of employeeRows) {
      const employeeId = row.employeeId as string;
      const key = keyOf(row.companyId, employeeId);
      const bucket = buckets.get(key) ?? emptyBucket(row.companyId, employeeId);
      applyAmount(bucket, row.transactionType, row._sum.amount);
      buckets.set(key, bucket);
    }

    for (const bucket of buckets.values()) {
      await this.prisma.creditUsageDailyRollup.upsert({
        where: {
          companyId_employeeId_day: {
            companyId: bucket.companyId,
            employeeId: bucket.employeeId,
            day: dayStart,
          },
        },
        create: {
          companyId: bucket.companyId,
          employeeId: bucket.employeeId,
          day: dayStart,
          creditsGranted: bucket.granted,
          creditsConsumed: bucket.consumed,
          creditsRefunded: bucket.refunded,
          creditsAdjusted: bucket.adjusted,
        },
        update: {
          creditsGranted: bucket.granted,
          creditsConsumed: bucket.consumed,
          creditsRefunded: bucket.refunded,
          creditsAdjusted: bucket.adjusted,
        },
      });
    }

    return { day: dayStart.toISOString().slice(0, 10), rowsUpserted: buckets.size };
  }

  /** Read-only aggregate for the finance reporting controller. */
  async query(filters: {
    since?: Date;
    until?: Date;
    companyId?: string;
  }): Promise<DailyRollupRow[]> {
    const rows = await this.prisma.creditUsageDailyRollup.findMany({
      where: {
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
        ...(filters.since || filters.until
          ? {
              day: {
                ...(filters.since ? { gte: filters.since } : {}),
                ...(filters.until ? { lte: filters.until } : {}),
              },
            }
          : {}),
      },
      orderBy: { day: 'desc' },
      take: 1000,
    });
    return rows.map((r) => ({
      companyId: r.companyId,
      employeeId: r.employeeId === '' ? null : r.employeeId,
      day: r.day.toISOString().slice(0, 10),
      creditsGranted: decimalToNumber(r.creditsGranted),
      creditsConsumed: decimalToNumber(r.creditsConsumed),
      creditsRefunded: decimalToNumber(r.creditsRefunded),
      creditsAdjusted: decimalToNumber(r.creditsAdjusted),
    }));
  }
}
