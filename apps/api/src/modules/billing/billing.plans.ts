import type { Plan, PlanDto } from '@vaep/types';

/**
 * Code-defined plan catalog — the source of truth for plan names, ILLUSTRATIVE
 * prices, SOFT employee limits and feature lists (from the proposal pricing).
 * Prices are illustrative only (0/49/199/custom); ENTERPRISE is custom (null).
 * `maxEmployees: null` means unlimited. Limits are informational — never
 * enforced (see BillingService / UsageDto.overEmployeeLimit).
 */
export const PLAN_CATALOG: Readonly<Record<Plan, PlanDto>> = {
  STARTER: {
    plan: 'STARTER',
    name: 'Starter',
    priceMonthlyUsd: 0,
    maxEmployees: 2,
    features: [
      'Up to 2 AI employees',
      'Limited tasks per month',
      'Community support',
    ],
    // §35.4/Master List #15 Option C: a $0 tier does not get a recurring
    // trickle on top of its one-time signup grant (Phase 4).
    includedCreditsPerMonth: null,
  },
  PRO: {
    plan: 'PRO',
    name: 'Pro',
    priceMonthlyUsd: 49,
    maxEmployees: 10,
    features: [
      'Up to 10 AI employees',
      'Shared knowledge base',
      'Basic automations',
      'Email support',
    ],
    // FOUNDER-PENDING: illustrative — roughly the plan's own $/credit peg
    // applied to the plan price, pending founder approval (§18/§40).
    includedCreditsPerMonth: 4_000,
  },
  BUSINESS: {
    plan: 'BUSINESS',
    name: 'Business',
    priceMonthlyUsd: 199,
    maxEmployees: null,
    features: [
      'Unlimited AI employees',
      'Workflow builder',
      'Integrations',
      'Analytics dashboard',
      'Priority support',
    ],
    // FOUNDER-PENDING: illustrative.
    includedCreditsPerMonth: 18_000,
  },
  ENTERPRISE: {
    plan: 'ENTERPRISE',
    name: 'Enterprise',
    priceMonthlyUsd: null,
    maxEmployees: null,
    features: [
      'Unlimited AI employees',
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

/** Soft employee cap for a plan (null = unlimited). */
export function maxEmployeesFor(plan: Plan): number | null {
  return PLAN_CATALOG[plan].maxEmployees;
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
