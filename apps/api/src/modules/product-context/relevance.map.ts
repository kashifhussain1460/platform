import type {
  EmployeeRole,
  Plan,
  ProductArea,
  SkillCapability,
} from '@vaep/types';

/**
 * THE declarative relevance mappings. One file, pure data, no I/O, no `if`
 * chains anywhere else in the codebase.
 *
 * ## Why this file exists
 *
 * The 2026-08-22 audit found ZERO occurrences of `if (industry === …)` and zero
 * of `if (department === …)` in either app. That was not discipline — it was
 * the absence of the feature: a company told us its industry, its size, its
 * goals and its departments, and every one of those answers reached exactly
 * nothing. The product looked identical for a 12-person recruitment agency and
 * a 2,000-seat manufacturer.
 *
 * The fix is not a rule engine. It is these tables plus one pure function.
 *
 * ## The rules this file follows
 *
 * 1. **Relevance only.** Nothing here decides whether a user is ALLOWED to do
 *    something — `AuthorizationService` does that, and the resolver calls it.
 *    Confusing the two is how a "personalisation" layer quietly becomes a
 *    security control that nobody tested as one.
 *
 * 2. **Capabilities, not skills.** Recommendations resolve to
 *    `SkillCapability` values and are turned into concrete skills by the
 *    EXISTING `SkillCapabilities` registry. Add Outlook as an EMAIL_SEND
 *    provider tomorrow and every mapping here covers it for free.
 *
 * 3. **Additive, never subtractive.** Absent configuration widens the answer,
 *    it never narrows it. A company with no industry, no goals and no
 *    departments gets EVERYTHING as relevant — see `NO_CONFIGURATION` in the
 *    resolver. An existing tenant must not wake up to a smaller product.
 */

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

/**
 * Areas every company gets, regardless of configuration.
 *
 * These are the product, not a feature of it: you cannot hide Skills from a
 * company that has not told us its industry yet, because installing a skill is
 * how it stops being unconfigured.
 */
export const CORE_AREAS: readonly ProductArea[] = [
  'DASHBOARD',
  'EMPLOYEES',
  'SKILLS',
  'KNOWLEDGE',
  'WORKFLOWS',
  'RUNS',
  'SCHEDULES',
  'APPROVALS',
  'MARKETPLACE',
  'BILLING',
  'TEAM',
];

/**
 * Areas unlocked by hiring an AI Employee of a given role.
 *
 * `INTERVIEW_SCHEDULING` is the clearest example of the gap this closes: the
 * interview-slot screen is in every tenant's sidebar today, including companies
 * that have never hired a recruiter and never will.
 */
export const EMPLOYEE_ROLE_AREAS: Readonly<Record<EmployeeRole, readonly ProductArea[]>> = {
  RECRUITER: ['INTERVIEW_SCHEDULING'],
  HR: ['INTERVIEW_SCHEDULING'],
  // The marketing workspace is where a human sees what the Marketing AI has
  // queued and published on the company's real social accounts. It appears
  // only once such an employee is hired — a company with no Marketing AI has
  // nothing to show there, and an empty screen in the sidebar is the exact
  // noise this table exists to remove.
  MARKETING: ['MARKETING'],
  SUPPORT: [],
  SALES: [],
  ACCOUNTANT: [],
  PROJECT_MANAGER: [],
  // A CUSTOM employee is defined by its persona, not its role, so it unlocks
  // nothing on its own. Guessing here would surface screens at random.
  CUSTOM: [],
};

/**
 * Areas gated by subscription tier.
 *
 * Mirrors the server-side `@RequirePlan` decorators EXACTLY. The audit found
 * `plan === 'BUSINESS' || plan === 'ENTERPRISE'` copy-pasted into three
 * frontend files while the sidebar forgot it entirely — so every STARTER
 * customer saw "AI Assist" and got a 403 on click. One table, one answer.
 */
export const AREA_MIN_PLAN: Readonly<Partial<Record<ProductArea, Plan>>> = {
  ASSIST: 'BUSINESS',
};

/**
 * Areas that need a company role floor.
 *
 * Relevance cannot grant these — the resolver ANDs this with the real
 * `AuthorizationService` decision. It is here so the resolved navigation does
 * not offer a MEMBER a link that will 403, not to replace the guard that 403s.
 */
export const AREA_MIN_ROLE: Readonly<Partial<Record<ProductArea, 'ADMIN' | 'OWNER'>>> = {
  ORGANIZATION: 'ADMIN',
  ADMIN_HEALTH: 'ADMIN',
};

/**
 * Where each area lives, and how the shell groups it.
 *
 * Re-exported from `@vaep/types`, NOT defined here: the frontend needs the same
 * route table for the fallback it renders while `/product-context` is loading,
 * and two copies drift the first time a page moves.
 */
export { PRODUCT_AREA_NAV as AREA_NAV } from '@vaep/types';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What an AI Employee of each role actually needs to do its job.
 *
 * Sourced from the roles' own one-line scopes in `employees.constants.ts`
 * (`ROLE_SCOPE`) and the marketplace templates' `suggestedSkills`, expressed as
 * capabilities so a new provider is covered automatically.
 */
export const EMPLOYEE_ROLE_CAPABILITIES: Readonly<
  Record<EmployeeRole, readonly SkillCapability[]>
> = {
  RECRUITER: ['EMAIL_SEND', 'EMAIL_READ', 'CALENDAR_EVENT_CREATE', 'FILE_STORAGE_READ'],
  HR: ['EMAIL_SEND', 'CALENDAR_EVENT_CREATE', 'FILE_STORAGE_WRITE', 'FILE_STORAGE_READ'],
  MARKETING: ['SOCIAL_PUBLISH', 'EMAIL_SEND', 'FILE_STORAGE_READ'],
  SUPPORT: ['SUPPORT_REPLY', 'EMAIL_SEND', 'MESSAGING_SEND'],
  SALES: ['CRM_WRITE', 'EMAIL_SEND', 'CALENDAR_EVENT_CREATE'],
  ACCOUNTANT: ['PAYMENTS_READ', 'EMAIL_SEND', 'FILE_STORAGE_READ'],
  PROJECT_MANAGER: ['ISSUE_TRACKING_WRITE', 'ISSUE_TRACKING_READ', 'MESSAGING_SEND'],
  CUSTOM: [],
};

/**
 * Industry → capabilities that industry tends to need.
 *
 * Keys are NORMALISED (upper-case, non-alphanumerics collapsed to `_`) because
 * `Company.industry` is a free-text column: the wizard offers ten options but
 * the API accepts any string, and older rows predate the list entirely. An
 * unrecognised industry simply contributes nothing — it must never be an error
 * and never a narrowing.
 */
export const INDUSTRY_CAPABILITIES: Readonly<Record<string, readonly SkillCapability[]>> = {
  TECHNOLOGY: ['ISSUE_TRACKING_WRITE', 'MESSAGING_SEND'],
  HEALTHCARE: ['FILE_STORAGE_WRITE', 'CALENDAR_EVENT_CREATE'],
  FINANCE: ['PAYMENTS_READ', 'FILE_STORAGE_WRITE'],
  RETAIL_ECOMMERCE: ['PAYMENTS_WRITE', 'SUPPORT_REPLY', 'SOCIAL_PUBLISH'],
  EDUCATION: ['CALENDAR_EVENT_CREATE', 'FILE_STORAGE_READ'],
  PROFESSIONAL_SERVICES: ['CALENDAR_EVENT_CREATE', 'CRM_WRITE'],
  REAL_ESTATE: ['CRM_WRITE', 'CALENDAR_EVENT_CREATE'],
  MANUFACTURING: ['ISSUE_TRACKING_WRITE', 'FILE_STORAGE_READ'],
  HOSPITALITY: ['SUPPORT_REPLY', 'CALENDAR_EVENT_CREATE'],
  // 'Other' is a real choice in the wizard, and it means "assume nothing".
  OTHER: [],
};

/**
 * Business goal → capabilities.
 *
 * Keys are the exact strings in `EMPLOYEE_GOALS` (the only vocabulary the
 * wizard can produce), normalised the same way. This is the first thing in the
 * platform to read `Company.businessGoals` at all — before this the step-3
 * screen wrote a column nothing consumed.
 */
export const GOAL_CAPABILITIES: Readonly<Record<string, readonly SkillCapability[]>> = {
  // HR goals
  RECRUITMENT: ['EMAIL_SEND', 'EMAIL_READ', 'FILE_STORAGE_READ'],
  CANDIDATE_SCREENING: ['EMAIL_READ', 'FILE_STORAGE_READ'],
  INTERVIEW_SCHEDULING: ['CALENDAR_EVENT_CREATE', 'EMAIL_SEND'],
  EMPLOYEE_ONBOARDING: ['EMAIL_SEND', 'FILE_STORAGE_WRITE', 'MESSAGING_SEND'],
  HR_OPERATIONS: ['EMAIL_SEND', 'FILE_STORAGE_WRITE'],
  PERFORMANCE_REVIEWS: ['FILE_STORAGE_WRITE', 'CALENDAR_EVENT_CREATE'],
  EMPLOYEE_OFFBOARDING: ['EMAIL_SEND', 'ISSUE_TRACKING_WRITE'],
  // Marketing goals
  CONTENT_CREATION: ['FILE_STORAGE_WRITE'],
  SOCIAL_MEDIA: ['SOCIAL_PUBLISH'],
  CAMPAIGN_MANAGEMENT: ['SOCIAL_PUBLISH', 'EMAIL_SEND'],
  EMAIL_MARKETING: ['EMAIL_SEND'],
  SEO: ['HTTP_REQUEST'],
  LEAD_GENERATION: ['CRM_WRITE', 'EMAIL_SEND'],
  MARKETING_ANALYTICS: ['HTTP_REQUEST'],
};

/**
 * Department scope name → the AI Employee roles that department works with.
 *
 * Mirrors `ONBOARDING_CATALOG`'s own `departments` field, which has sat in the
 * codebase with ZERO consumers since it was written — its docstring even claims
 * "the wizard filters it by the departments the company selected", which the
 * wizard has never done. This is that consumer.
 *
 * Keys are department NAMES normalised the same way as scopes, so both the
 * Phase-2 presets ("Customer Support") and the enum values ("CUSTOMER_SUPPORT")
 * resolve to the same entry.
 */
export const DEPARTMENT_EMPLOYEE_ROLES: Readonly<Record<string, readonly EmployeeRole[]>> = {
  SALES: ['SALES'],
  MARKETING: ['MARKETING'],
  HR: ['HR', 'RECRUITER'],
  RECRUITMENT: ['RECRUITER'],
  CUSTOMER_SUPPORT: ['SUPPORT'],
  SUPPORT: ['SUPPORT'],
  FINANCE: ['ACCOUNTANT'],
  ENGINEERING: ['PROJECT_MANAGER'],
  OPERATIONS: ['PROJECT_MANAGER'],
  LEGAL: [],
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * `Retail / Ecommerce` → `RETAIL_ECOMMERCE`; `customer-support` →
 * `CUSTOMER_SUPPORT`.
 *
 * Same shape as `authorization.policy.normalizeScope`, kept separate on purpose:
 * that one is a security primitive whose behaviour must not drift because a
 * relevance table wanted a slightly different fold. Duplicating eight lines is
 * cheaper than coupling a personalisation feature to the authorization layer.
 */
export function normalizeKey(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Plan-tier comparison is NOT redefined here.
 *
 * `billing.plans.planMeetsMinimum` is the canonical one, and its own docstring
 * records that a private copy in `workflow-templates.service` was removed as a
 * kill-critic gap fix on 2026-08-20. Adding a second copy in a relevance table
 * would reintroduce exactly that bug.
 */
export { planMeetsMinimum } from '../billing/billing.plans';
