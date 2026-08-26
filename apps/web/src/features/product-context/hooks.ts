'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  DashboardCompositionDto,
  Plan,
  ProductArea,
  ProductContextDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import { getDashboardComposition, getProductContext } from './api';

export const productContextKeys = {
  all: ['product-context'] as const,
  dashboard: ['product-context', 'dashboard'] as const,
};

/**
 * The resolved product context for the current company AND the current user.
 *
 * Cached for a minute: it changes when someone hires an employee, installs a
 * skill, changes plan or is moved between departments — none of which happen
 * mid-click, and all of which invalidate through their own mutations.
 */
export function useProductContext() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<ProductContextDto, NormalizedApiError>({
    queryKey: productContextKeys.all,
    queryFn: getProductContext,
    enabled: Boolean(accessToken),
    staleTime: 60_000,
  });
}

/**
 * Is this product area available to the current user?
 *
 * Available means the server said RELEVANT ∧ ENTITLED ∧ AUTHORIZED. Replaces
 * every page-local guess about what to show.
 *
 * **This is a display hint, not a security control.** The endpoint behind the
 * area keeps its own guard; hiding a link has never stopped anyone typing a
 * URL, and treating this as protection is how a hidden button becomes a
 * vulnerability.
 *
 * Defaults to `true` while loading, and `true` when the request fails. A
 * transient network error must not blank out the customer's navigation — the
 * old static arrays never disappeared, and neither should these.
 */
export function useHasArea(area: ProductArea): boolean {
  const { data, isLoading, isError } = useProductContext();
  if (isLoading || isError || !data) return true;
  return data.productAreas.includes(area);
}

/**
 * Plan entitlements, resolved once.
 *
 * Replaces `subscription?.plan === 'BUSINESS' || subscription?.plan === 'ENTERPRISE'`,
 * which the audit found copy-pasted into three files — and MISSING from the
 * sidebar, so every STARTER customer was shown an "AI Assist" link that
 * answered 403. One rule, one place, matching the server's `@RequirePlan`.
 */
export function useEntitlements(): {
  plan: Plan | null;
  isLoading: boolean;
  /** True when the plan includes this area. */
  includes: (area: ProductArea) => boolean;
  /** The tier that would unlock it, or null when it is already included. */
  upgradeRequiredFor: (area: ProductArea) => Plan | null;
} {
  const { data, isLoading } = useProductContext();
  const locked = data?.entitlements.lockedAreas ?? [];
  return {
    plan: data?.entitlements.plan ?? null,
    isLoading,
    // Unknown → assume included, for the same reason as `useHasArea`: fail
    // toward the product still working, and let the server's own guard be the
    // thing that says no.
    includes: (area) => (data ? !locked.some((l) => l.area === area) : true),
    upgradeRequiredFor: (area) =>
      locked.find((l) => l.area === area)?.requiresPlan ?? null,
  };
}

/**
 * The composed dashboard.
 *
 * Shorter stale time than the context itself: these are live counts (pending
 * approvals, escalated conversations) that a customer expects to move, whereas
 * "which areas exist" changes only when they reconfigure something.
 */
export function useDashboardComposition() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<DashboardCompositionDto, NormalizedApiError>({
    queryKey: productContextKeys.dashboard,
    queryFn: getDashboardComposition,
    enabled: Boolean(accessToken),
    staleTime: 15_000,
  });
}
