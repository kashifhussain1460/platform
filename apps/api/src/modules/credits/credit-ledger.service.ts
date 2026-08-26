import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma, type CreditLedger } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { METRIC, MetricsRegistry } from '../../common/observability/metrics.registry';
import {
  decimalToNumber,
  type CreditLedgerAppendInput,
  type CreditLedgerEntry,
  type PrismaTransaction,
} from './credits.types';

/**
 * The single, only code path permitted to insert a `CreditLedger` row
 * (docs/architecture/orlixa-ai-credit-usage-billing-plan.md §9.2/§40.10's
 * "insert-only, one owning layer" invariant; §46's "only this service reads
 * raw tokens/cost"). Phase 2, Task 2.1.
 *
 * Locking: **ADV** — a per-company Postgres advisory transaction lock,
 * mirroring `AuditLogService.record` (`audit-log.service.ts:87-93`) exactly:
 * `pg_advisory_xact_lock(hashtext('credit:' + companyId))`. This serializes
 * every ledger append for one company (never across companies — a hashtext
 * collision between two different companies costs a little contention and
 * nothing else, same tradeoff `AuditLogService` already makes), which is
 * what lets `balanceBefore`/`balanceAfter` be computed by a plain
 * read-then-write instead of needing row-level locking.
 *
 * Balance bookkeeping (reproduces the §10.3 worked example verbatim — reserve
 * 20 → settle 13 → release 7 → balance 100→80→87 — which is NOT the same as
 * naively re-decrementing `balance` on every DEBIT):
 * - RESERVATION: `balance -= amount` (GUM floor-guard), `reservedBalance += amount`
 *   (the hold moves spendable credits into the "held" sub-balance).
 * - DEBIT **that settles a reservation** (has `reservationId`): `reservedBalance
 *   -= amount` ONLY — `balance` is untouched, because it already moved at
 *   RESERVE time; a DEBIT here is relabeling part of an existing hold as
 *   permanently spent, not moving money a second time.
 * - DEBIT with no `reservationId` (a hypothetical direct/un-reserved debit —
 *   not used by any Phase 2/3 call site, since every real spend path reserves
 *   first, but kept correct for a future caller that might bypass reservation,
 *   e.g. a flat Enterprise deduction): `balance -= amount` (GUM floor-guard).
 * - RELEASE: `balance += amount`, `reservedBalance -= amount` (the unused
 *   portion of a hold returns to spendable and simultaneously leaves the held
 *   pool — this is the SAME `amount` moving both ways, not two independent
 *   numbers).
 * - CREDIT, REFUND: `balance += amount` (unconditional — cannot go negative).
 * - ADJUSTMENT: `balance += amount` if positive (unconditional), `balance -=
 *   |amount|` (GUM floor-guard) if negative. `reservedBalance` untouched — an
 *   admin adjustment corrects spendable balance directly, not an active hold.
 * - EXPIRATION: `balance -= amount` (GUM floor-guard). Lot-aware
 *   `LEAST(lot.remaining, balance)` bounding (§28.2.4) is deferred to the
 *   phase that wires up `CreditLot`/`CreditLotConsumption` — Phase 2 has no
 *   real grants yet, so there is nothing to lot-bound against.
 */
@Injectable()
export class CreditLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    // Credit system Phase 3, Task 3.7 (§33) — emitted at the single choke
    // point every ledger row passes through, so no individual call site
    // needs its own instrumentation.
    private readonly metrics: MetricsRegistry,
  ) {}

  /**
   * @param tx An existing transaction to append within (e.g.
   *   `CreditReservationService.settle` composing a DEBIT + a RELEASE into
   *   one atomic unit). Omit to let this method open its own transaction —
   *   the right choice for a standalone append with no other co-committed
   *   writes.
   */
  async append(
    entry: CreditLedgerAppendInput,
    tx?: PrismaTransaction,
  ): Promise<CreditLedgerEntry> {
    this.assertRatePresence(entry);
    // Composed within a caller's own transaction (e.g. settle's DEBIT+RELEASE
    // pair): any error, including a P2002 that "shouldn't happen" given the
    // ADV lock, propagates as-is so Postgres aborts and rolls back the WHOLE
    // composed unit — the caller's responsibility, not this method's.
    if (tx) return this.appendWithin(tx, entry);

    // Standalone: mirrors `CreditReservationService.reserve`'s documented
    // idiom exactly — the P2002 catch and its re-query MUST sit outside the
    // `$transaction` call. Once any statement inside a Postgres transaction
    // errors, the whole transaction is aborted and every further statement on
    // it fails with 25P02 until rollback; catching-and-requerying against the
    // SAME (aborted) `tx` would surface that confusing error instead of the
    // duplicate row.
    try {
      return await this.prisma.$transaction((inner) => this.appendWithin(inner, entry));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.creditLedger.findUnique({
          where: {
            companyId_idempotencyKey: {
              companyId: entry.companyId,
              idempotencyKey: entry.idempotencyKey,
            },
          },
        });
        if (winner) return toEntry(winner);
      }
      throw err;
    }
  }

  private async appendWithin(
    tx: PrismaTransaction,
    entry: CreditLedgerAppendInput,
  ): Promise<CreditLedgerEntry> {
    // ADV: serialize every append for this company. Released automatically
    // at transaction end (commit or rollback) — never held across a call's
    // whole lifetime, unlike SELECT ... FOR UPDATE. Safe to re-acquire when
    // `tx` is a caller-supplied transaction already holding it (e.g. settle's
    // DEBIT-then-RELEASE pair): Postgres advisory-lock acquisition is
    // reentrant within the same transaction/session.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`credit:${entry.companyId}`}))
    `;

    // IDEM fast path: a prior successful append for this idempotency key
    // returns as-is, with ZERO additional balance mutation. Safe to check
    // before the balance math (not just after a P2002) because the ADV
    // lock above already serializes every writer for this company — by the
    // time we reach this line, any earlier request for the same key has
    // either fully committed (visible here) or not started.
    const existing = await tx.creditLedger.findUnique({
      where: {
        companyId_idempotencyKey: {
          companyId: entry.companyId,
          idempotencyKey: entry.idempotencyKey,
        },
      },
    });
    if (existing) return toEntry(existing);

    // Self-heal a zero-balance row if this company has never had one
    // (mirrors `ensureDefaultSubscription`'s self-healing pattern).
    const current = await tx.companyCreditBalance.upsert({
      where: { companyId: entry.companyId },
      create: { companyId: entry.companyId, balance: 0, reservedBalance: 0, updatedAt: new Date() },
      update: {},
    });

    const balanceBefore = decimalToNumber(current.balance);
    const amount = entry.amount;
    const balanceAfter = balanceBefore + this.balanceDelta(entry, amount);

    const { balanceGuard, reservedGuard } = this.guards(entry, amount);

    if (balanceGuard) {
      const guarded = await tx.companyCreditBalance.updateMany({
        where: { companyId: entry.companyId, balance: { gte: Math.abs(amount) } },
        data: { balance: { increment: amount } },
      });
      if (guarded.count === 0) {
        throw new InsufficientCreditsError(entry.companyId, Math.abs(amount));
      }
    } else if (this.balanceDelta(entry, amount) !== 0) {
      await tx.companyCreditBalance.update({
        where: { companyId: entry.companyId },
        data: { balance: { increment: this.balanceDelta(entry, amount) } },
      });
    }

    if (reservedGuard) {
      const guarded = await tx.companyCreditBalance.updateMany({
        where: { companyId: entry.companyId, reservedBalance: { gte: Math.abs(amount) } },
        data: { reservedBalance: { decrement: Math.abs(amount) } },
      });
      if (guarded.count === 0) {
        // Should be unreachable by construction (a settle/release always
        // targets a reservation that put exactly this much into
        // reservedBalance) — a real hit here means the ledger and an open
        // reservation have desynced, which must surface loudly, not silently
        // clamp to zero.
        throw new InternalServerErrorException(
          `reservedBalance underflow for company ${entry.companyId} (reservation/ledger desync)`,
        );
      }
    } else if (this.reservedDelta(entry, amount) !== 0) {
      await tx.companyCreditBalance.update({
        where: { companyId: entry.companyId },
        data: { reservedBalance: { increment: this.reservedDelta(entry, amount) } },
      });
    }

    // A P2002 here "shouldn't happen" given the ADV lock above already
    // serializes every writer for this company before the IDEM pre-check ran
    // — but if it ever does (e.g. a future caller bypassing the lock), it
    // must propagate uncaught: catching it here, inside the transaction
    // callback, and re-querying on this same `tx` would hit Postgres's
    // "current transaction is aborted" (25P02) instead of the duplicate row.
    // The standalone branch of `append()` is the one place allowed to catch
    // and recover from it, with a fresh, non-transactional connection.
    const created = await tx.creditLedger.create({
      data: {
        companyId: entry.companyId,
        employeeId: entry.employeeId ?? null,
        workflowId: entry.workflowId ?? null,
        workflowRunId: entry.workflowRunId ?? null,
        workflowStepRunId: entry.workflowStepRunId ?? null,
        conversationId: entry.conversationId ?? null,
        executionId: entry.executionId ?? null,
        reservationId: entry.reservationId ?? null,
        packId: entry.packId ?? null,
        enterpriseAgreementId: entry.enterpriseAgreementId ?? null,
        transactionType: entry.transactionType,
        grantKind: entry.grantKind ?? null,
        amount,
        balanceBefore,
        balanceAfter,
        reversesLedgerEntryId: entry.reversesLedgerEntryId ?? null,
        modelCostRateId: entry.modelCostRateId ?? null,
        toolCostRateId: entry.toolCostRateId ?? null,
        reason: entry.reason,
        source: entry.source,
        idempotencyKey: entry.idempotencyKey,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    this.emitMetrics(entry);
    return toEntry(created);
  }

  /**
   * §33's reservation-lifecycle counters, derived from this single insertion
   * choke point rather than instrumented at every reserve/settle/release call
   * site. `outcome` only covers `SUCCESS`/`RELEASED` here — a reservation that
   * resolves to `EXPIRED_UNKNOWN` never reaches `append()` (it is a pure
   * status flip with no ledger effect, by design) and is covered instead by
   * `credit_reservation_leak_detected_total` at the sweep that finds it.
   */
  private emitMetrics(entry: CreditLedgerAppendInput): void {
    const companyId = entry.companyId;
    switch (entry.transactionType) {
      case 'RESERVATION':
        this.metrics.counter(
          METRIC.creditsReservedTotal,
          'Credit reservations opened',
          { companyId },
        );
        break;
      case 'DEBIT':
        if (entry.reservationId) {
          this.metrics.counter(
            METRIC.creditsSettledTotal,
            'Credit reservations resolved',
            { companyId, outcome: 'SUCCESS' },
          );
        }
        break;
      case 'RELEASE':
        if (entry.reservationId) {
          this.metrics.counter(
            METRIC.creditsSettledTotal,
            'Credit reservations resolved',
            { companyId, outcome: 'RELEASED' },
          );
        }
        break;
      case 'REFUND':
        // No `reason` label: `reason` is free text, and a label with
        // unbounded cardinality is a Prometheus footgun, not an observability win.
        this.metrics.counter(METRIC.creditsRefundedTotal, 'Credits refunded', { companyId });
        break;
      default:
        break;
    }
  }

  /** Net change to the spendable `balance` column for this entry (see class doc). */
  private balanceDelta(entry: CreditLedgerAppendInput, amount: number): number {
    switch (entry.transactionType) {
      case 'RESERVATION':
        return amount; // amount is negative
      case 'DEBIT':
        return entry.reservationId ? 0 : amount;
      case 'RELEASE':
      case 'CREDIT':
      case 'REFUND':
        return amount; // amount is positive
      case 'ADJUSTMENT':
        return amount; // signed, either direction
      case 'EXPIRATION':
        return amount; // amount is negative
      default:
        return amount;
    }
  }

  /** Net change to the held `reservedBalance` column for this entry (see class doc). */
  private reservedDelta(entry: CreditLedgerAppendInput, amount: number): number {
    switch (entry.transactionType) {
      case 'RESERVATION':
        return Math.abs(amount);
      case 'DEBIT':
        return entry.reservationId ? -Math.abs(amount) : 0;
      case 'RELEASE':
        return -Math.abs(amount);
      default:
        return 0;
    }
  }

  /** Whether each column's mutation must go through a GUM floor-guard (vs. an unconditional increment). */
  private guards(
    entry: CreditLedgerAppendInput,
    amount: number,
  ): { balanceGuard: boolean; reservedGuard: boolean } {
    const balanceGuard =
      entry.transactionType === 'RESERVATION' ||
      (entry.transactionType === 'DEBIT' && !entry.reservationId) ||
      entry.transactionType === 'EXPIRATION' ||
      (entry.transactionType === 'ADJUSTMENT' && amount < 0);
    const reservedGuard =
      (entry.transactionType === 'DEBIT' && Boolean(entry.reservationId)) ||
      entry.transactionType === 'RELEASE';
    return { balanceGuard, reservedGuard };
  }

  /**
   * Phase 9, Task 9.5 — row-level ledger read for the Usage page. Read-only,
   * tenant-scoped, newest first; no write-path invariant applies here (this
   * never touches `balance`/`reservedBalance`).
   */
  async listEntries(filters: {
    companyId: string;
    employeeId?: string;
    source?: string;
    since?: Date;
    until?: Date;
    limit?: number;
  }): Promise<CreditLedgerEntry[]> {
    const rows = await this.prisma.creditLedger.findMany({
      where: {
        companyId: filters.companyId,
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        ...(filters.source ? { source: filters.source } : {}),
        ...(filters.since || filters.until
          ? {
              createdAt: {
                ...(filters.since ? { gte: filters.since } : {}),
                ...(filters.until ? { lte: filters.until } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
    });
    return rows.map(toEntry);
  }

  /** §28.2.1's "mandatory, non-nullable rate snapshot" — enforced in code since the DB column is nullable. */
  private assertRatePresence(entry: CreditLedgerAppendInput): void {
    if (entry.transactionType !== 'DEBIT' && entry.transactionType !== 'RESERVATION') return;
    if (entry.modelCostRateId || entry.toolCostRateId) return;
    throw new InternalServerErrorException(
      `CreditLedgerService.append: ${entry.transactionType} requires a non-null modelCostRateId or toolCostRateId (got neither) — every priced spend must freeze which rate produced its amount.`,
    );
  }
}

/** Thrown when a floor-guarded balance mutation would go negative — the company genuinely doesn't have enough credit. */
export class InsufficientCreditsError extends Error {
  constructor(
    public readonly companyId: string,
    public readonly required: number,
  ) {
    super(`Company ${companyId} has insufficient credits (needs ${required} more).`);
    this.name = 'InsufficientCreditsError';
  }
}

function toEntry(row: CreditLedger): CreditLedgerEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    employeeId: row.employeeId,
    workflowId: row.workflowId,
    workflowRunId: row.workflowRunId,
    workflowStepRunId: row.workflowStepRunId,
    conversationId: row.conversationId,
    executionId: row.executionId,
    reservationId: row.reservationId,
    transactionType: row.transactionType as CreditLedgerEntry['transactionType'],
    grantKind: row.grantKind,
    amount: decimalToNumber(row.amount),
    balanceBefore: decimalToNumber(row.balanceBefore),
    balanceAfter: decimalToNumber(row.balanceAfter),
    reason: row.reason,
    source: row.source as CreditLedgerEntry['source'],
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}
