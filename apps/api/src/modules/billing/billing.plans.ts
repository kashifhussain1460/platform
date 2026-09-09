import type { EmployeeRole, Plan, PlanDto } from '@vaep/types';

/**
 * Code-defined plan catalog — the source of truth for plan names, prices,
 * seat rules, per-employee credit ceilings and feature lists.
 *
 * ## Role-based hiring (2026-09-04, founder-approved)
 *
 * A plan buys `maxRoles` DISTINCT roles with `maxPerRole` employees in each.
 * The customer picks which roles. `maxEmployees` is derived and only kept so
 * existing consumers (usage bar, product-context) keep working:
 *
 *   Free    (STARTER)  $0   2 roles × 1  = 2 seats   one-time 1,000 grant, no monthly
 *   Starter (PRO)      $20  2 roles × 1  = 2 seats   1,000 credits / month
 *   Growth  (BUSINESS) $40  2 roles × 2  = 4 seats   2,000 credits / month
 *   Enterprise         custom, unlimited, EnterpriseCreditAgreement
 *
 * The enum values are unchanged on purpose: renaming them is a migration plus
 * every `PLAN_RANK` consumer, for nothing a customer can see. Display names and
 * prices are what changed.
 *
 * `creditsPerEmployeePerMonth` (500 on every tier) is stamped onto each new
 * employee's `budgetLimit` at hire and is the MAXIMUM a customer may set it to.
 * At the $0.01/credit peg (provider cost + 10 % margin), a fully-used Starter
 * costs ≈ $9 to serve against $20 revenue; Growth ≈ $18 against $40 — the
 * ~55 % margin the plan doc records. Extra usage goes through PAYG packs.
 *
 * Every number here is enforced: seats and roles atomically in
 * `EmployeesService.create()` (all three hire entry points), ceilings in
 * `CreditLimitsService` once the credit flags are on. `billing.plans.spec.ts`
 * asserts `maxEmployees === maxRoles × maxPerRole` for every plan so the
 * derived value can never disagree with the rule.
 */
export const PLAN_CATALOG: Readonly<Record<Plan, PlanDto>> = {
  STARTER: {
    plan: 'STARTER',
    name: 'Free',
    priceMonthlyUsd: 0,
    maxRoles: 2,
    maxPerRole: 1,
    maxEmployees: 2,
    creditsPerEmployeePerMonth: 500,
    features: [
      '2 AI employees — any 2 roles, 1 each',
      '1,000 credits to start (one-time)',
      'Workflow templates',
      'Community support',
    ],
    // §35.4/Master List #15 Option C: a $0 tier does not get a recurring
    // trickle on top of its one-time signup grant (Phase 4).
    includedCreditsPerMonth: null,
  },
  PRO: {
    plan: 'PRO',
    name: 'Starter',
    priceMonthlyUsd: 20,
    maxRoles: 2,
    maxPerRole: 1,
    maxEmployees: 2,
    creditsPerEmployeePerMonth: 500,
    features: [
      '2 AI employees — any 2 roles, 1 each',
      '1,000 credits every month',
      'Up to 500 credits per employee per month',
      'Workflow templates',
      'Email support',
    ],
    includedCreditsPerMonth: 1_000,
  },
  BUSINESS: {
    plan: 'BUSINESS',
    name: 'Growth',
    priceMonthlyUsd: 40,
    maxRoles: 2,
    maxPerRole: 2,
    maxEmployees: 4,
    creditsPerEmployeePerMonth: 500,
    features: [
      '4 AI employees — any 2 roles, 2 each',
      '2,000 credits every month',
      'Up to 500 credits per employee per month',
      'AI Assist (conversational builder)',
      'Analytics dashboard',
      'Priority support',
    ],
    includedCreditsPerMonth: 2_000,
  },
  ENTERPRISE: {
    plan: 'ENTERPRISE',
    name: 'Enterprise',
    priceMonthlyUsd: null,
    maxRoles: null,
    maxPerRole: null,
    maxEmployees: null,
    creditsPerEmployeePerMonth: null,
    features: [
      'Unlimited AI employees and roles',
      'Private deployment',
      'Custom AI employees',
      'SLA',
      'Audit logs',
      // SSO removed (founder-market-readiness-audit.md §3/§4): it was sold
      // here with zero implementation anywhere in the codebase. Re-add once
      // it's actually built, or once a specific Enterprise deal is asking
      // for it and paying to fund building it.
    ],
    // Enterprise's recurring allotment is its own mechanism
    // (EnterpriseCreditAgreement, Task 7.4) — never this flat per-plan
    // number, which is why it is null here regardless of the custom price.
    includedCreditsPerMonth: null,
  },
};

/** The catalog as an ordered list (display order = tier order). */
export const PLAN_LIST: readonly PlanDto[] = [
  PLAN_CATALOG.STARTER,
  PLAN_CATALOG.PRO,
  PLAN_CATALOG.BUSINESS,
  PLAN_CATALOG.ENTERPRISE,
];

/** Total seat cap for a plan (null = unlimited). Derived: roles × per-role. */
export function maxEmployeesFor(plan: Plan): number | null {
  return PLAN_CATALOG[plan].maxEmployees;
}

/** Distinct roles a plan allows (null = unlimited). */
export function maxRolesFor(plan: Plan): number | null {
  return PLAN_CATALOG[plan].maxRoles;
}

/** Employees allowed per role (null = unlimited). */
export function maxPerRoleFor(plan: Plan): number | null {
  return PLAN_CATALOG[plan].maxPerRole;
}

/** Default + maximum monthly credit ceiling per employee (null = none). */
export function creditsPerEmployeeFor(plan: Plan): number | null {
  return PLAN_CATALOG[plan].creditsPerEmployeePerMonth;
}

/**
 * The seat rules, applied to a roster. Pure so `EmployeesService.create()`,
 * `BillingService.usage()` and the product-context resolver all call the SAME
 * function — three copies of "count per role and compare" is how the old
 * total-only cap ended up informational in one place and enforced in another.
 *
 * Only ACTIVE and PAUSED employees occupy a seat. A DISABLED (retired) or
 * archived employee frees both its seat and its role slot, so "retire one to
 * hire another" is a real path out, not a dead end.
 */
export interface SeatCheck {
  /** Would hiring `role` exceed the plan? Null = allowed. */
  reason: 'TOTAL' | 'PER_ROLE' | 'NEW_ROLE' | null;
  total: number;
  inRole: number;
  rolesUsed: number;
}

export function checkSeatFor(
  plan: Plan,
  roster: ReadonlyArray<{ role: EmployeeRole; status: string }>,
  role: EmployeeRole,
): SeatCheck {
  const occupying = roster.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED');
  const total = occupying.length;
  const inRole = occupying.filter((e) => e.role === role).length;
  const rolesInUse = new Set(occupying.map((e) => e.role));
  const rolesUsed = rolesInUse.size;

  const maxTotal = maxEmployeesFor(plan);
  const maxPerRole = maxPerRoleFor(plan);
  const maxRoles = maxRolesFor(plan);

  let reason: SeatCheck['reason'] = null;
  if (maxTotal !== null && total >= maxTotal) reason = 'TOTAL';
  else if (maxPerRole !== null && inRole >= maxPerRole) reason = 'PER_ROLE';
  else if (maxRoles !== null && !rolesInUse.has(role) && rolesUsed >= maxRoles) reason = 'NEW_ROLE';

  return { reason, total, inRole, rolesUsed };
}

const PLAN_RANK: Record<Plan, number> = {
  STARTER: 0,
  PRO: 1,
  BUSINESS: 2,
  ENTERPRISE: 3,
};

/**
 * The single canonical plan-tier comparison — kill-critic gap fix (2026-08-20):
 * `workflow-templates.service.ts` previously kept its own copy of this exact
 * table (`PLAN_RANK`) rather than importing from here, the source of truth
 * for plan tier order.
 */
export function planMeetsMinimum(plan: Plan, minPlan: Plan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[minPlan];
}
