'use client';

import { useSeatAvailability } from '@/features/product-context/hooks';
import { formatRole } from '../labels';

/**
 * "2 of 4 seats · HR 2/2 · Marketing 0/2 · 2 of 2 roles" under the roster heading.
 *
 * Role-based hiring (2026-09-04): the plan sells roles × per-role, so a
 * customer needs to see WHICH role is full, not just that "the plan" is. Read
 * from the resolver's entitlements — the same numbers the hire form greys
 * options from and the server enforces.
 */
export function SeatSummary() {
  const { seats } = useSeatAvailability();
  if (!seats || seats.max === null) return null;
  return (
    <p className="mt-1 text-sm text-app-ink-2">
      {seats.used} of {seats.max} seats
      {seats.perRole.map((r) => (
        <span key={r.role}>
          {' · '}
          {formatRole(r.role)} {r.used}
          {r.max !== null ? `/${r.max}` : ''}
        </span>
      ))}
      {seats.maxRoles !== null && (
        <span className="text-app-ink-3">
          {' · '}
          {seats.rolesUsed} of {seats.maxRoles} roles
        </span>
      )}
    </p>
  );
}
