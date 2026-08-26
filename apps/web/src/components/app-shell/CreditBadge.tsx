'use client';

import { useCreditBalance } from '@/features/billing/credits-hooks';

/**
 * // FOUNDER-PENDING: §17 Option B (25%/10%) — RECOMMENDED over 20%/5% (A) or
 * 30%/15% (C). Kept as named constants (not inlined) so a founder-approved
 * change is a one-line edit here, not a hunt through the component.
 */
const LOW_THRESHOLD_PCT = 0.25;
const CRITICAL_THRESHOLD_PCT = 0.1;

export type CreditBadgeState = 'normal' | 'low' | 'critical' | 'zero';

/** Pure so the state logic is unit-testable without mounting the hook. */
export function creditBadgeState(balance: number, trailingMonthlyDebits: number): CreditBadgeState {
  if (balance <= 0) return 'zero';
  if (trailingMonthlyDebits <= 0) return 'normal'; // no spend history yet — nothing to warn against
  const pctRemaining = balance / trailingMonthlyDebits;
  if (pctRemaining <= CRITICAL_THRESHOLD_PCT) return 'critical';
  if (pctRemaining <= LOW_THRESHOLD_PCT) return 'low';
  return 'normal';
}

const STATE_STYLES: Record<Exclude<CreditBadgeState, 'normal'>, string> = {
  low: 'bg-amber-500/20 text-amber-300',
  critical: 'bg-orange-500/20 text-orange-300',
  zero: 'bg-red-500/20 text-red-300',
};

const STATE_LABELS: Record<Exclude<CreditBadgeState, 'normal'>, string> = {
  low: 'Low',
  critical: 'Critical',
  zero: 'Zero',
};

/**
 * Nav credit-balance pill (§22 CREATE NEW), same idiom as the Runs-in-flight
 * pill (`Sidebar.tsx`'s `NavLink` badge). Renders NOTHING at Normal — same
 * visual restraint as that badge hiding at zero, so a healthy balance never
 * competes for attention with the nav label.
 */
export function CreditBadge() {
  const { data } = useCreditBalance();
  if (!data) return null;
  const state = creditBadgeState(data.balance, data.trailingMonthlyDebits);
  if (state === 'normal') return null;
  return (
    <span
      className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATE_STYLES[state]}`}
    >
      {STATE_LABELS[state]}
    </span>
  );
}
