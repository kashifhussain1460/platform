import type { Plan, SubscriptionStatus } from '@vaep/types';

/** Compact number formatter (e.g. 1234 → "1,234"). */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

/** Monthly price → display string. null = custom (ENTERPRISE); 0 = "Free". */
export function formatPrice(priceMonthlyUsd: number | null): string {
  if (priceMonthlyUsd === null) return 'Custom';
  if (priceMonthlyUsd === 0) return 'Free';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(priceMonthlyUsd);
}

/** Soft employee cap → display string. null = "Unlimited". */
export function formatLimit(maxEmployees: number | null): string {
  return maxEmployees === null ? 'Unlimited' : formatNumber(maxEmployees);
}

/** Human label for a subscription status. */
export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: 'Active',
  PAST_DUE: 'Past due',
  CANCELLED: 'Cancelled',
  // Legacy single-L rows (D4) still need a label.
  CANCELED: 'Cancelled',
};

/** Tailwind badge classes per status. */
export const STATUS_BADGE: Record<SubscriptionStatus, string> = {
  ACTIVE: 'bg-green-500/15 text-green-400',
  PAST_DUE: 'bg-amber-500/15 text-amber-400',
  CANCELLED: 'bg-white/[0.06] text-zinc-500',
  CANCELED: 'bg-white/[0.06] text-zinc-500',
};

/** Ordering used for the "Upgrade / Downgrade / Current" button label. */
const PLAN_RANK: Record<Plan, number> = {
  STARTER: 0,
  PRO: 1,
  BUSINESS: 2,
  ENTERPRISE: 3,
};

/** Action label for switching from `current` to `target`. */
export function changeLabel(current: Plan, target: Plan): string {
  if (current === target) return 'Current plan';
  return PLAN_RANK[target] > PLAN_RANK[current] ? 'Upgrade' : 'Downgrade';
}
