import type { SlotStatus } from '@vaep/types';

/** Tailwind classes for the status badge, keyed by status. */
export const STATUS_STYLES: Record<SlotStatus, string> = {
  OPEN: 'bg-blue-500/15 text-blue-800',
  BOOKED: 'bg-green-500/15 text-green-800',
  CANCELLED: 'bg-app-raised text-app-ink-3',
};

/** "OPEN" → "Open". */
export function formatStatus(status: SlotStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}
