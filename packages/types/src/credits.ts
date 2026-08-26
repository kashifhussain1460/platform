import { z } from 'zod';

/**
 * Credit system DTOs (docs/architecture/orlixa-ai-credit-usage-billing-plan.md).
 * Not yet consumed by any real call site — the credit system's own internal
 * types (`apps/api/src/modules/credits/credits.types.ts`) are what Phases 1-3
 * actually use; these are the shapes the future `/billing/credits*` HTTP
 * surface (Phase 9's frontend, Phase 5's purchase endpoint) will return.
 */

/**
 * // FOUNDER-PENDING: mirrors `apps/api`'s `DEFAULT_CREDITS_PER_USD` — Final
 * Architecture Decision recommended $0.01/credit (100 credits per USD).
 * Frontend-only illustrative conversions (e.g. UsageSummary's credits line)
 * use this; the real ledger always freezes its own per-call rate row and
 * never reads this constant.
 */
export const DEFAULT_CREDITS_PER_USD = 100;

export interface CreditBalanceDto {
  companyId: string;
  balance: number;
  reservedBalance: number;
  lastReconciledAt: string | null;
  updatedAt: string;
  /**
   * Phase 9, Task 9.2 — trailing 30-day DEBIT spend, the denominator for the
   * nav credit badge's percentage-remaining state. 0 for a company with no
   * spend yet (never shows a warning state on day one).
   */
  trailingMonthlyDebits: number;
}

export interface CreditLedgerEntryDto {
  id: string;
  companyId: string;
  employeeId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  workflowStepRunId: string | null;
  conversationId: string | null;
  executionId: string | null;
  reservationId: string | null;
  transactionType: string;
  grantKind: string | null;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  source: string;
  createdAt: string;
}

export interface CreditPackDto {
  id: string;
  packKey: string;
  displayName: string;
  creditAmount: number;
  bonusPercent: number;
  priceUsd: number;
}

export const purchaseCreditsSchema = z.object({
  packId: z.string().min(1),
});
export type PurchaseCreditsDto = z.infer<typeof purchaseCreditsSchema>;

export const adjustCreditsSchema = z.object({
  amount: z.number(),
  reason: z.string().min(10),
});
export type AdjustCreditsDto = z.infer<typeof adjustCreditsSchema>;
