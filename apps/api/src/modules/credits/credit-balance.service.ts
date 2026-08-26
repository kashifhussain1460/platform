import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
import { decimalToNumber, type CompanyCreditBalanceSnapshot } from './credits.types';

/**
 * §9.2's fast-read cache accessor and §9.5's nightly reconciliation
 * primitive (Phase 2, Task 2.2).
 */
@Injectable()
export class CreditBalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
  ) {}

  /** Plain indexed read on `CompanyCreditBalance.companyId @id`. Self-heals to a zero-balance row — never 404s. */
  async getBalance(companyId: string): Promise<CompanyCreditBalanceSnapshot> {
    const row = await this.prisma.companyCreditBalance.upsert({
      where: { companyId },
      create: { companyId, balance: 0, reservedBalance: 0, updatedAt: new Date() },
      update: {},
    });
    return {
      companyId: row.companyId,
      balance: decimalToNumber(row.balance),
      reservedBalance: decimalToNumber(row.reservedBalance),
      lastReconciledAt: row.lastReconciledAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * §9.5 method 1: the O(n) verification — `SUM(amount) WHERE companyId=X`
   * across `CreditLedger` versus the cached `balance`. A zero-drift reconcile
   * is a no-op beyond the timestamp stamp.
   *
   * On drift, the cache is reset DIRECTLY to the ledger sum — deliberately
   * NOT via `CreditLedgerService.append()`. Applying a `drift`-sized
   * ADJUSTMENT through the normal append path would mutate the cache AND
   * add that same amount to the ledger sum simultaneously, which can never
   * close a pre-existing cache/sum mismatch: if `newCache = oldCache + adj`
   * and `newSum = oldSum + adj`, then `newCache == newSum` reduces to
   * `oldCache == oldSum` — the very thing that's false when there's drift to
   * begin with. (Caught by this phase's own e2e test re-running `reconcile`
   * a second time after a "corrected" run and finding it still drifted.)
   * The ledger is the source of truth and needs no new row to fix a VIEW
   * derived from it — the cache is simply reset. A zero-amount ADJUSTMENT
   * row is still appended purely for audit visibility (the real drift and
   * before/after values live in its `reason`/`metadata`), which is safe
   * precisely because `amount: 0` has no effect on the sum.
   */
  async reconcile(companyId: string): Promise<{ drift: number; corrected: boolean }> {
    const [{ _sum }, current] = await Promise.all([
      this.prisma.creditLedger.aggregate({
        where: { companyId },
        _sum: { amount: true },
      }),
      this.getBalance(companyId),
    ]);
    const summed = decimalToNumber(_sum.amount ?? new Prisma.Decimal(0));
    const drift = summed - current.balance;

    if (drift === 0) {
      await this.prisma.companyCreditBalance.update({
        where: { companyId },
        data: { lastReconciledAt: new Date() },
      });
      return { drift: 0, corrected: false };
    }

    // Deterministic idempotency key: keyed on the OBSERVED (pre-correction)
    // cache value, so a re-run of the same drift correction (e.g. two
    // overlapping reconciliation ticks both observing the same corrupted
    // cache) is a no-op, not a double audit entry — while a genuinely NEW
    // drift after this one settles (a different observed cache value) still
    // gets its own record.
    await this.ledger.append({
      companyId,
      transactionType: 'ADJUSTMENT',
      amount: 0,
      reason: `Reconciliation: cached balance ${current.balance} drifted from ledger sum ${summed} by ${drift}; cache reset to ${summed}`,
      source: 'SYSTEM',
      idempotencyKey: `reconcile:${companyId}:${current.balance}:${summed}`,
      metadata: { driftDetected: drift, priorCache: current.balance, correctedTo: summed },
    });
    await this.prisma.companyCreditBalance.update({
      where: { companyId },
      data: { balance: summed, lastReconciledAt: new Date() },
    });
    return { drift, corrected: true };
  }

  /**
   * Phase 9, Task 9.2 — the denominator for the nav credit badge's
   * Normal/Low/Critical/Zero state (§21, Option B thresholds). Trailing 30
   * days of DEBIT spend, the same "own trailing usage, not a plan-wide
   * average" computation `UsageService.totalCostForEmployee` already uses for
   * `overEmployeeLimit`/`estimatedCostUsd` — open to any member, same as
   * those two, since it reveals nothing more sensitive than "this company
   * spends about N credits a month."
   */
  async getTrailingMonthlyDebits(companyId: string): Promise<number> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { _sum } = await this.prisma.creditLedger.aggregate({
      where: { companyId, transactionType: 'DEBIT', createdAt: { gte: since } },
      _sum: { amount: true },
    });
    // DEBIT amounts are stored negative (see credit-reservation.service.ts's
    // settle path, `amount: -actualAbs`) — this returns a positive spend figure.
    return Math.abs(decimalToNumber(_sum.amount ?? new Prisma.Decimal(0)));
  }
}
