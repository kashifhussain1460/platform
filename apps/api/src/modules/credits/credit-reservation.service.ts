import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, type CreditReservation } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { LEASE_TTL_SECONDS } from '../workflow-runtime/attempt-lease.service';
import { CreditLedgerService } from './credit-ledger.service';
import {
  decimalToNumber,
  type CreditResourceType,
  type CreditSource,
  type PrismaTransaction,
} from './credits.types';

export interface ReserveInput {
  companyId: string;
  employeeId?: string | null;
  workflowRunId?: string | null;
  /** The idempotency anchor for workflow-triggered reservations (§40.8's corrected keying — see class doc). */
  workflowStepRunId?: string | null;
  conversationId?: string | null;
  /** Required when `workflowStepRunId` is absent (chat/assist calls) — the client-supplied `Message.idempotencyKey` (Task 1.3). */
  messageIdempotencyKey?: string | null;
  executionId?: string | null;
  resourceType: CreditResourceType;
  estimatedCredits: number;
  modelCostRateId?: string | null;
  toolCostRateId?: string | null;
  reason: string;
  source?: CreditSource;
}

export type ReserveOutcome = 'created' | 'settled' | 'duplicateInFlight' | 'resumable';

export interface ReserveResult {
  outcome: ReserveOutcome;
  reservation: CreditReservationDto;
}

export interface CreditReservationDto {
  id: string;
  companyId: string;
  employeeId: string | null;
  workflowRunId: string | null;
  workflowStepRunId: string | null;
  conversationId: string | null;
  executionId: string | null;
  resourceType: string;
  status: CreditReservation['status'];
  estimatedCredits: number;
  actualCredits: number | null;
  idempotencyKey: string;
  leaseExpiresAt: Date;
  createdAt: Date;
  settledAt: Date | null;
  releasedAt: Date | null;
}

/**
 * The Reserve→Execute→Settle hold record (§10) — Phase 2, Tasks 2.5–2.7. All
 * three methods live in one file/class: they share one state machine
 * (`CreditReservationStatus`) and the same `CreditReservation` row.
 *
 * §40.8-corrected keying (kill-critic Q3 fix): the idempotency key is
 * derived from `WorkflowStepRun.id`, NOT `nodeId` — `sha256(companyId:
 * workflowStepRunId)`. `TraversalService.enqueueNode` opens a NEW
 * `WorkflowStepRun` row per LOOP iteration while reusing the same static
 * `nodeId` (`forceNewStep: true`, `traversal.service.ts:377-387`), so keying
 * on `nodeId` would make iteration 2 collide with iteration 1's already-
 * `SETTLED` reservation and silently replay its cached output forever.
 * Keying on `workflowStepRunId` is simultaneously unique per loop iteration
 * (each iteration = a new row) AND correctly reused across every retry
 * ATTEMPT of the same logical step (attempts share one `WorkflowStepRun` via
 * `WorkflowStepAttempt.stepId`).
 *
 * For non-workflow (chat/assist) calls there is no `WorkflowStepRun` — the
 * key is `sha256(companyId:conversationId:messageIdempotencyKey)`, closing
 * kill-critic Q3(a): keying off `Message.id` alone doesn't help, since
 * message creation itself had zero dedup before Task 1.3.
 */
@Injectable()
export class CreditReservationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
    // Credit system Phase 3, Task 3.7 (§33) — one audit row per SETTLEMENT,
    // not per reservation (a settlement is the economically meaningful
    // event; the reserve step alone moves nothing final).
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * On a duplicate idempotency key (this method's own P2002, caught OUTSIDE
   * the transaction and re-queried fresh — never inside the `$transaction`
   * callback, which would try to keep issuing statements against a Postgres
   * transaction Postgres has already aborted; mirrors
   * `workflow-templates.service.ts`'s proven idiom):
   * - `SETTLED` → return as-is; the caller replays the cached result.
   * - `PENDING` with an unexpired lease → `duplicateInFlight`; a genuine
   *   concurrent duplicate, the caller should wait/poll.
   * - `PENDING` with an expired/absent lease, or terminal
   *   (`RELEASED`/`EXPIRED_UNKNOWN`) → `resumable`; the caller proceeds on
   *   the existing row rather than creating a second reservation and a
   *   second balance decrement.
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const idempotencyKey = this.deriveKey(input);
    const estimateAbs = Math.abs(input.estimatedCredits);
    const source = input.source ?? 'SYSTEM';

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_SECONDS * 1000);
        const reservation = await tx.creditReservation.create({
          data: {
            companyId: input.companyId,
            employeeId: input.employeeId ?? null,
            workflowRunId: input.workflowRunId ?? null,
            workflowStepRunId: input.workflowStepRunId ?? null,
            conversationId: input.conversationId ?? null,
            executionId: input.executionId ?? null,
            resourceType: input.resourceType,
            status: 'PENDING',
            estimatedCredits: estimateAbs,
            idempotencyKey,
            leaseExpiresAt,
          },
        });
        await this.ledger.append(
          {
            companyId: input.companyId,
            employeeId: input.employeeId ?? null,
            workflowRunId: input.workflowRunId ?? null,
            workflowStepRunId: input.workflowStepRunId ?? null,
            conversationId: input.conversationId ?? null,
            executionId: input.executionId ?? null,
            reservationId: reservation.id,
            transactionType: 'RESERVATION',
            amount: -estimateAbs,
            modelCostRateId: input.modelCostRateId ?? null,
            toolCostRateId: input.toolCostRateId ?? null,
            reason: input.reason,
            source,
            idempotencyKey: `rsv:${idempotencyKey}`,
          },
          tx,
        );
        return reservation;
      });
      return { outcome: 'created', reservation: toDto(created) };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.creditReservation.findUniqueOrThrow({
          where: {
            companyId_idempotencyKey: { companyId: input.companyId, idempotencyKey },
          },
        });
        if (existing.status === 'SETTLED') {
          return { outcome: 'settled', reservation: toDto(existing) };
        }
        if (existing.status === 'PENDING') {
          const unexpired = existing.leaseExpiresAt.getTime() > Date.now();
          return {
            outcome: unexpired ? 'duplicateInFlight' : 'resumable',
            reservation: toDto(existing),
          };
        }
        // RELEASED / EXPIRED_UNKNOWN: a caller re-deriving the same logical
        // key after the hold already ended. Resumable — it is the caller's
        // choice (e.g. workflow retry semantics) whether to reserve fresh.
        return { outcome: 'resumable', reservation: toDto(existing) };
      }
      // InsufficientCreditsError or anything else: the whole transaction
      // rolled back, so zero reservation rows and zero ledger rows exist —
      // propagate as-is.
      throw err;
    }
  }

  /**
   * §10.2 step 5 / §40.9's corrected settlement guard: `companyId` is
   * MANDATORY in the claiming `updateMany`'s WHERE clause (an earlier draft
   * omitted it — the explicit §40.9 fix). `count===0` → idempotent no-op,
   * returning the existing terminal row. On success, in the SAME
   * transaction: a DEBIT of `actualCredits` (against `reservedBalance`, not
   * `balance` again — see `CreditLedgerService`'s class doc) then a RELEASE
   * of the unused `estimatedCredits - actualCredits` (skipped entirely when
   * that is exactly zero).
   *
   * Known, deliberate limitation: if `actualCredits` exceeds
   * `estimatedCredits` (the reservation under-estimated), the DEBIT's
   * `reservedBalance` floor-guard throws rather than silently over-drawing
   * the hold — surfacing an estimation bug loudly instead of masking it. A
   * true-up mechanism for that case is not built in this phase.
   */
  async settle(
    input: {
      reservationId: string;
      companyId: string;
      actualCredits: number;
      modelCostRateId?: string | null;
      toolCostRateId?: string | null;
      reason?: string;
    },
    tx?: PrismaTransaction,
  ): Promise<CreditReservationDto> {
    const [dto, settled] = tx
      ? await this.settleWithin(tx, input)
      : await this.prisma.$transaction((inner) => this.settleWithin(inner, input));
    // §33 — one audit row per SETTLEMENT, not per reservation: only on the
    // call that actually performed it, never on the idempotent no-op replay.
    // Best-effort (AuditLogService.record never throws) and NOT part of the
    // settle transaction itself — same trade every metrics emission in this
    // phase makes, since the audit trail is a secondary artifact, not the
    // ledger of record.
    if (settled) {
      await this.auditLog.record({
        companyId: input.companyId,
        action: 'credit.settled',
        entityType: 'CreditReservation',
        entityId: dto.id,
        employeeId: dto.employeeId,
        workflowRunId: dto.workflowRunId,
        metadata: {
          estimatedCredits: dto.estimatedCredits,
          actualCredits: dto.actualCredits,
          resourceType: dto.resourceType,
        },
      });
    }
    return dto;
  }

  private async settleWithin(
    tx: PrismaTransaction,
    input: {
      reservationId: string;
      companyId: string;
      actualCredits: number;
      modelCostRateId?: string | null;
      toolCostRateId?: string | null;
      reason?: string;
    },
  ): Promise<[CreditReservationDto, boolean]> {
    const actualAbs = Math.abs(input.actualCredits);
    const claimed = await tx.creditReservation.updateMany({
      where: { id: input.reservationId, companyId: input.companyId, status: 'PENDING' },
      data: { status: 'SETTLED', actualCredits: actualAbs, settledAt: new Date() },
    });
    const reservation = await tx.creditReservation.findUniqueOrThrow({
      where: { id: input.reservationId },
    });
    if (claimed.count === 0) return [toDto(reservation), false]; // idempotent no-op

    await this.ledger.append(
      {
        companyId: input.companyId,
        employeeId: reservation.employeeId,
        workflowRunId: reservation.workflowRunId,
        workflowStepRunId: reservation.workflowStepRunId,
        conversationId: reservation.conversationId,
        executionId: reservation.executionId,
        reservationId: reservation.id,
        transactionType: 'DEBIT',
        amount: -actualAbs,
        modelCostRateId: input.modelCostRateId ?? null,
        toolCostRateId: input.toolCostRateId ?? null,
        reason: input.reason ?? `Settle reservation ${reservation.id}: ${actualAbs} credits`,
        source: 'SYSTEM',
        idempotencyKey: `settle-debit:${reservation.id}`,
      },
      tx,
    );

    const unusedAmount = decimalToNumber(reservation.estimatedCredits) - actualAbs;
    if (unusedAmount !== 0) {
      await this.ledger.append(
        {
          companyId: input.companyId,
          employeeId: reservation.employeeId,
          workflowRunId: reservation.workflowRunId,
          workflowStepRunId: reservation.workflowStepRunId,
          conversationId: reservation.conversationId,
          executionId: reservation.executionId,
          reservationId: reservation.id,
          transactionType: 'RELEASE',
          amount: unusedAmount,
          reason: `Release unused hold for reservation ${reservation.id}`,
          source: 'SYSTEM',
          idempotencyKey: `settle-release:${reservation.id}`,
        },
        tx,
      );
    }

    await this.rollUpSpendOntoRun(tx, reservation, actualAbs);

    return [
      toDto(
        await tx.creditReservation.findUniqueOrThrow({ where: { id: input.reservationId } }),
      ),
      true,
    ];
  }

  /**
   * Record what a run and its step ACTUALLY cost, on the run and step rows the
   * product reads.
   *
   * ## The defect this closes
   *
   * `WorkflowRun.totalCreditsCharged` was incremented in exactly one place —
   * `CreditLimitsService.checkAndReserveWorkflowLimit` — which returns early
   * when `run.creditLimit == null`. Null is the default, so for essentially
   * every run the counter never moved. `WorkflowStepRun.creditsCharged` was
   * worse: no writer anywhere in the repository.
   *
   * `RunCreditPanel` renders both. The 2026-09-02 audit watched a run debit a
   * real credit against a real balance (1000 → 999) while the run page told the
   * customer **"Credits 0 — No billable steps in this run yet."** A billing
   * system may not do that.
   *
   * ## Why here
   *
   * Settlement is the moment actual cost becomes known, and it already runs in
   * a transaction with the ledger append — so the rollup either lands with the
   * DEBIT or not at all. It is also idempotent by construction: the caller
   * reached this line only after winning the guarded `updateMany` above, so a
   * replayed settle takes the no-op branch and never double-counts.
   *
   * ## Interaction with the per-run cap
   *
   * `checkAndReserveWorkflowLimit` still increments the same counter, at
   * RESERVATION time, because a live per-node cap must reserve against the
   * ceiling before spending — it cannot wait for settlement. When a run has a
   * cap, `totalCreditsCharged` is therefore the reserved figure, which is the
   * conservative one and the one the cap is enforced against. This method fills
   * the gap for the uncapped default, where nothing was recorded at all, and
   * deliberately skips capped runs so neither path double-bills.
   */
  private async rollUpSpendOntoRun(
    tx: PrismaTransaction,
    reservation: { workflowRunId: string | null; workflowStepRunId: string | null },
    actualCredits: number,
  ): Promise<void> {
    if (actualCredits === 0) return;

    if (reservation.workflowStepRunId) {
      // Accumulating rather than setting, because one step can settle more than
      // one reservation — an AI_EMPLOYEE_STEP's completion plus each tool call
      // it makes.
      //
      // Raw SQL rather than Prisma's `increment`, and this is not a style
      // choice: `WorkflowStepRun.creditsCharged` is nullable with NO default,
      // so `increment` emits `"creditsCharged" + 1`, and in SQL `NULL + 1` is
      // `NULL`. The first settlement against a step would silently write
      // nothing at all — which is the exact class of defect this rollup exists
      // to fix, reintroduced one layer down. Caught only by running it.
      //
      // The column stays nullable on purpose: `null` means "no reservation ever
      // settled here", which is how a control-flow node (WAIT, CONDITION) is
      // distinguished from a cost-bearing one that happened to cost nothing.
      // `RunCreditPanel` reads exactly that distinction.
      await tx.$executeRaw`
        UPDATE "WorkflowStepRun"
           SET "creditsCharged" = COALESCE("creditsCharged", 0) + ${actualCredits}::numeric
         WHERE id = ${reservation.workflowStepRunId}
      `;
    }

    if (reservation.workflowRunId) {
      // `creditLimit: null` in the WHERE is the anti-double-bill guard
      // described above, not an optimisation.
      await tx.workflowRun.updateMany({
        where: { id: reservation.workflowRunId, creditLimit: null },
        data: { totalCreditsCharged: { increment: actualCredits } },
      });
    }
  }

  /**
   * The "never executed / terminally failed pre-provider-call" path
   * (Failed-Executions Case 1/3/9/11). Releasing an already-settled/released
   * reservation is a safe no-op.
   *
   * Claims from `PENDING` (the normal direct-release path) OR
   * `EXPIRED_UNKNOWN` (the reservation-leak sweep's two-step claim, Task
   * 2.8: claim-as-`EXPIRED_UNKNOWN` first so two concurrent sweep ticks can't
   * both act on the same stale row, then release to actually credit back) —
   * never from `SETTLED`/`RELEASED`, which stay a safe no-op.
   */
  async release(
    input: { reservationId: string; companyId: string; reason: string },
    tx?: PrismaTransaction,
  ): Promise<CreditReservationDto> {
    const [dto, released] = tx
      ? await this.releaseWithin(tx, input)
      : await this.prisma.$transaction((inner) => this.releaseWithin(inner, input));
    // §33 — same "one row per resolution, not per reservation" rule as settle().
    if (released) {
      await this.auditLog.record({
        companyId: input.companyId,
        action: 'credit.released',
        entityType: 'CreditReservation',
        entityId: dto.id,
        employeeId: dto.employeeId,
        workflowRunId: dto.workflowRunId,
        metadata: { estimatedCredits: dto.estimatedCredits, resourceType: dto.resourceType, reason: input.reason },
      });
    }
    return dto;
  }

  private async releaseWithin(
    tx: PrismaTransaction,
    input: { reservationId: string; companyId: string; reason: string },
  ): Promise<[CreditReservationDto, boolean]> {
    const claimed = await tx.creditReservation.updateMany({
      where: {
        id: input.reservationId,
        companyId: input.companyId,
        status: { in: ['PENDING', 'EXPIRED_UNKNOWN'] },
      },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    const reservation = await tx.creditReservation.findUniqueOrThrow({
      where: { id: input.reservationId },
    });
    if (claimed.count === 0) return [toDto(reservation), false]; // idempotent no-op

    await this.ledger.append(
      {
        companyId: input.companyId,
        employeeId: reservation.employeeId,
        workflowRunId: reservation.workflowRunId,
        workflowStepRunId: reservation.workflowStepRunId,
        conversationId: reservation.conversationId,
        executionId: reservation.executionId,
        reservationId: reservation.id,
        transactionType: 'RELEASE',
        amount: decimalToNumber(reservation.estimatedCredits),
        reason: input.reason,
        source: 'SYSTEM',
        idempotencyKey: `release:${reservation.id}`,
      },
      tx,
    );

    return [
      toDto(
        await tx.creditReservation.findUniqueOrThrow({ where: { id: input.reservationId } }),
      ),
      true,
    ];
  }

  private deriveKey(input: ReserveInput): string {
    const raw = input.workflowStepRunId
      ? `${input.companyId}:${input.workflowStepRunId}`
      : `${input.companyId}:${input.conversationId}:${input.messageIdempotencyKey}`;
    return createHash('sha256').update(raw).digest('hex');
  }
}

function toDto(row: CreditReservation): CreditReservationDto {
  return {
    id: row.id,
    companyId: row.companyId,
    employeeId: row.employeeId,
    workflowRunId: row.workflowRunId,
    workflowStepRunId: row.workflowStepRunId,
    conversationId: row.conversationId,
    executionId: row.executionId,
    resourceType: row.resourceType,
    status: row.status,
    estimatedCredits: decimalToNumber(row.estimatedCredits),
    actualCredits: row.actualCredits ? decimalToNumber(row.actualCredits) : null,
    idempotencyKey: row.idempotencyKey,
    leaseExpiresAt: row.leaseExpiresAt,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
    releasedAt: row.releasedAt,
  };
}
