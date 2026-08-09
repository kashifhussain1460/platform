import type { ApprovalStatus } from '@vaep/types';

/** Tailwind classes for the status badge, keyed by status. */
export const STATUS_STYLES: Record<ApprovalStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-400',
  APPROVED: 'bg-green-500/15 text-green-400',
  REJECTED: 'bg-red-500/15 text-red-400',
  ESCALATED: 'bg-orange-500/15 text-orange-400',
  EXPIRED: 'bg-slate-500/15 text-slate-400',
};

/** "PENDING" → "Pending". */
export function formatStatus(status: ApprovalStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}
