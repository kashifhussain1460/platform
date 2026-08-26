import { Prisma } from '@prisma/client';
import type { Decimal } from '@prisma/client/runtime/library';

/**
 * The transactional Prisma client handed to (or opened by) a credit service
 * method — Prisma's own `TransactionClient`, matching the exact convention
 * `run-lock.service.ts:12` already establishes in this codebase (NOT
 * `Omit<PrismaService, ...>`, which would drag in NestJS lifecycle hooks a
 * transaction client doesn't have). Letting callers pass one in is what lets
 * `CreditReservationService.settle` compose a DEBIT append and a RELEASE
 * append into a single atomic transaction (Task 2.6).
 */
export type PrismaTransaction = Prisma.TransactionClient;

/**
 * Internal credit-system types (docs/architecture/orlixa-ai-credit-usage-billing-plan.md,
 * Phase 2). NOT shared with the frontend yet — these are backend-only
 * service contracts. The stub DTOs in `@vaep/types` (Phase 1 Task 1.6) are a
 * separate, deliberately minimal, frontend-facing surface; this file is
 * where the real internal shape lives until a later phase needs to expose
 * more of it.
 */

/** DEBIT | CREDIT | RESERVATION | RELEASE | REFUND | ADJUSTMENT | EXPIRATION (§9.4). String, not an enum — this taxonomy is expected to grow (§28.0). */
export type CreditTransactionType =
  | 'DEBIT'
  | 'CREDIT'
  | 'RESERVATION'
  | 'RELEASE'
  | 'REFUND'
  | 'ADJUSTMENT'
  | 'EXPIRATION';

/** SYSTEM | USER | WEBHOOK | ADMIN (§9.4). */
export type CreditSource = 'SYSTEM' | 'USER' | 'WEBHOOK' | 'ADMIN';

/** LLM_CALL | TOOL_CALL (§28.2.5). */
export type CreditResourceType = 'LLM_CALL' | 'TOOL_CALL';

/**
 * Input to `CreditLedgerService.append` — the sole ledger-insert path
 * (§9.2/§40.10, Task 2.1). `amount` is signed: positive for CREDIT/RELEASE,
 * negative for DEBIT/RESERVATION/EXPIRATION, either sign for ADJUSTMENT.
 */
export interface CreditLedgerAppendInput {
  companyId: string;
  employeeId?: string | null;
  workflowId?: string | null;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  conversationId?: string | null;
  executionId?: string | null;
  reservationId?: string | null;
  packId?: string | null;
  enterpriseAgreementId?: string | null;
  transactionType: CreditTransactionType;
  grantKind?: string | null;
  /** Signed. */
  amount: number;
  reversesLedgerEntryId?: string | null;
  /** Required (service-enforced) for a DEBIT/RESERVATION priced from an LLM call. */
  modelCostRateId?: string | null;
  /** Required (service-enforced) for a DEBIT/RESERVATION priced from a tool call. */
  toolCostRateId?: string | null;
  reason: string;
  source: CreditSource;
  idempotencyKey: string;
  metadata?: Record<string, unknown> | null;
}

/** A ledger row as returned to callers — `amount`/`balanceBefore`/`balanceAfter` as `number` (credits are not currency; precision loss at display scale is acceptable, unlike raw USD). */
export interface CreditLedgerEntry {
  id: string;
  companyId: string;
  employeeId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  workflowStepRunId: string | null;
  conversationId: string | null;
  executionId: string | null;
  reservationId: string | null;
  transactionType: CreditTransactionType;
  grantKind: string | null;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  source: CreditSource;
  idempotencyKey: string;
  createdAt: Date;
}

export interface CompanyCreditBalanceSnapshot {
  companyId: string;
  balance: number;
  reservedBalance: number;
  lastReconciledAt: Date | null;
  updatedAt: Date;
}

/** Convert a Prisma `Decimal` (or a plain number, for test fixtures) to a JS number. */
export function decimalToNumber(value: Decimal | number): number {
  return typeof value === 'number' ? value : value.toNumber();
}
