'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  EmployeeRole,
  EntitlementsDto,
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
 *
 * 🔴 **That last clause was false until 2026-09-09.** `productContextKeys.all`
 * had ZERO `invalidateQueries` callers anywhere in the app, so hiring your last
 * seat left the counter reading "1 of 2" for up to 60s — and TanStack's prefix
 * matching does NOT help, because invalidating the child
 * `['product-context','dashboard']` never matches the parent
 * `['product-context']`. `refetchOnWindowFocus` is off globally, so there was no
 * self-heal either. A Playwright run failed on exactly this.
 *
 * **The invariant, for anyone adding a mutation:** if it writes any of the six
 * things `product-context.service.ts` resolves from — `Company`
 * (industry/size/businessGoals), `Subscription.plan`, `Department` (incl.
 * `scopes`), `AiEmployee` (role/status/archivedAt), `InstalledSkill`
 * (skillKey/connectionStatus/enabled), or `WorkflowTemplate` — it must
 * invalidate `productContextKeys.all` alongside its own key. Pinned by
 * `e2e/tests/06-plan-seats-journey.spec.ts`.
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

/**
 * Role-based hiring (docs/product/2026-09-04-role-based-hiring-plans.md).
 *
 * Answers, from the server-resolved entitlements, whether THIS role can still
 * be hired and why not. The hire form and the onboarding wizard grey a role
 * from this; `EmployeesService.create()` is the real control and applies the
 * identical rule, so what is greyed out is exactly what would be refused.
 *
 * Unknown (context not loaded) → allowed, for the same reason as the other
 * hooks here: fail toward the product working and let the server say no.
 *
 * `reasonBlocked`'s optional second argument, `pendingRoles`, is for a
 * multi-select picker (the onboarding wizard's Select Employees step) where
 * several roles are chosen BEFORE any of them is actually hired — `seats`
 * only reflects what the server already has, so a picker checking each card
 * in isolation would let a Starter plan (`maxRoles: 2`) select all 8 roles
 * with nothing greyed out. Pass the OTHER roles already selected in this same
 * picker session (not including the one being asked about) so the total/role
 * caps are checked against "already hired + about to be hired," not just
 * "already hired." The single-role hire form omits it and gets the original,
 * unaffected behavior.
 */
export function useSeatAvailability(): {
  isLoading: boolean;
  seats: EntitlementsDto['seats'] | null;
  creditsPerEmployeePerMonth: number | null;
  /** null = hireable; otherwise the plain-language reason it is not. */
  reasonBlocked: (role: EmployeeRole, pendingRoles?: EmployeeRole[]) => string | null;
} {
  const { data, isLoading } = useProductContext();
  const seats = data?.entitlements.seats ?? null;
  return {
    isLoading,
    seats,
    creditsPerEmployeePerMonth: data?.entitlements.creditsPerEmployeePerMonth ?? null,
    reasonBlocked: (role, pendingRoles = []) => {
      if (!seats) return null;
      const pendingCount = pendingRoles.length;
      const effectiveUsed = seats.used + pendingCount;
      if (seats.max !== null && effectiveUsed >= seats.max) {
        return pendingCount > 0
          ? `Your plan allows ${seats.max} AI employees in total, including the ${pendingCount} you've already selected.`
          : `All ${seats.max} seats on your plan are taken.`;
      }

      // Live-discovered gap (fixed here): `pendingRoles` can now contain the
      // SAME role more than once (the Select Employees screen supports
      // picking e.g. 2 Sales on a plan with maxPerRole: 2) — the per-role
      // check used to only compare against `inRole.used` (already hired,
      // server-side), so a user could select past the cap with nothing
      // greying out, since neither pending occurrence was counted here.
      const inRole = seats.perRole.find((r) => r.role === role);
      const pendingSameRole = pendingRoles.filter((r) => r === role).length;
      const perRoleUsed = (inRole?.used ?? 0) + pendingSameRole;
      if (seats.maxPerRole !== null && perRoleUsed >= seats.maxPerRole) {
        return pendingSameRole > 0
          ? `Your plan includes ${seats.maxPerRole} per role — you've already selected ${perRoleUsed} for this role.`
          : `Your plan includes ${seats.maxPerRole} per role and you already have ${inRole?.used ?? 0}.`;
      }

      // Distinct NEW roles pending (excluding the role being asked about, and
      // de-duplicated) — two pending copies of the SAME new role must not
      // each count as a separate role against `maxRoles`.
      const pendingDistinctNewRoles = new Set(
        pendingRoles.filter((r) => r !== role && !seats.perRole.some((pr) => pr.role === r)),
      ).size;
      const isAlreadyUsedRole = Boolean(inRole) || pendingSameRole > 0;
      const effectiveRolesUsed = seats.rolesUsed + pendingDistinctNewRoles;
      if (seats.maxRoles !== null && !isAlreadyUsedRole && effectiveRolesUsed >= seats.maxRoles) {
        return pendingCount > 0
          ? `Your plan includes ${seats.maxRoles} roles and your current selection already uses ${effectiveRolesUsed}.`
          : `Your plan includes ${seats.maxRoles} roles and you already use ${seats.rolesUsed}.`;
      }
      return null;
    },
  };
}
