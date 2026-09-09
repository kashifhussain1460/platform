# Role-Based Hiring Plans — Flow & Implementation Plan

**Date:** 2026-09-04 · **Status:** APPROVED 2026-09-04 (Q1 roles × per-role · Q2 reprice existing enum · Q3–Q5 recommended credit numbers · Q6 grandfather · Q7 Assist at Growth+) — **IMPLEMENTED** the same day, see §10
**Builds on:** `docs/specs/hiring-and-subscription-linkage.md` (2026-07-11),
`docs/product/2026-08-20-credit-economics-decision.md`, `billing.plans.ts`, `credit-limits.service.ts`

---

## 1. What we are changing, in one paragraph

Today a plan says "up to N AI employees" and nothing about *which roles*. The new model says a plan
buys **a number of roles** and **a headcount per role**, plus **a monthly credit allowance per
employee**. So a $20 plan buys 2 roles × 1 employee each (e.g. 1 HR + 1 Marketing); $40 buys
2 roles × 2 each (2 HR + 2 Marketing); the free plan buys 2 roles × 1 each with a smaller, one-time
credit grant. Everything a customer can do — the onboarding wizard, the Hire button, the marketplace
install, the employee's credit ceiling — is driven from that one plan definition.

**We are not building a new billing system.** The seat cap, the subscription gate, the per-employee
credit ceiling, the monthly allotment and the Stripe plan-change flow already exist. This plan adds
two numbers to the plan definition (`maxRoles`, `maxPerRole`), one default (`creditsPerEmployeePerMonth`),
and enforces them at the single choke point every hire already passes through.

---

## 2. The plan matrix (recommended — ⚑ every number is a founder decision)

| | **Free** | **Starter** | **Growth** | **Enterprise** |
|---|---|---|---|---|
| Enum value (unchanged) | `STARTER` | `PRO` | `BUSINESS` | `ENTERPRISE` |
| Price / month | $0 | **$20** ⚑ | **$40** ⚑ | custom |
| Distinct roles allowed (`maxRoles`) | 2 | 2 | 2 | unlimited |
| Employees per role (`maxPerRole`) | 1 | 1 | 2 | unlimited |
| Total seats (derived = roles × per-role) | **2** | **2** | **4** | unlimited |
| Credits per employee / month (`creditsPerEmployeePerMonth`) | 500 ⚑ (from the one-time grant) | 500 ⚑ | 500 ⚑ | per agreement |
| Company monthly allowance (`includedCreditsPerMonth`) | none — one-time 1,000 grant, 30-day expiry (already built) | **1,000** ⚑ | **2,000** ⚑ | `EnterpriseCreditAgreement` (already built) |
| Buy more credits (PAYG packs) | ✅ | ✅ | ✅ | ✅ |
| AI Assist (conversational builder) | ✗ | ✗ | ✅ | ✅ |
| Workflow templates | ✅ | ✅ | ✅ | ✅ |

### Why these credit numbers

1 credit = $0.01 of price, and covers provider cost **plus a 10 % safety margin** (`credit-rates.defaults.ts`).
So the provider cost behind 1 credit is ≈ $0.009.

| Plan | Included credits | Worst-case provider cost if fully used | Revenue | Gross margin at full use |
|---|---:|---:|---:|---:|
| Starter $20 | 1,000 | ≈ $9 | $20 | ≈ 55 % |
| Growth $40 | 2,000 | ≈ $18 | $40 | ≈ 55 % |

If a customer needs more, they buy a credit pack (already built: $10 / 1,000, $50 / 5,500,
$100 / 12,000). Included credits are deliberately *not* set to the plan's face value — that would
be ~0 % margin at full use.

### Why "roles × per-role" and not a fixed bundle

Your example ($20 = 1 HR + 1 Marketing) works, **and so does 1 Sales + 1 Support** for a company
that has no HR. A fixed bundle would force the wrong roles on the wrong company. "2 roles, 1 each"
gives every customer the same value and lets them pick. If you specifically want plans that are
locked to named roles (an "HR pack"), that is a different product decision — see §9 Q1.

### Where the free plan sits

Free = the existing `STARTER` row: 2 seats, the existing one-time 1,000-credit signup grant, no
monthly top-up (already decided as "Option C" in `billing.plans.ts`). New: each free employee gets
a **500-credit monthly ceiling** so one employee cannot burn the whole grant in a day. Free stays
useful for a real trial and useless for free-riding.

---

## 3. The rules, stated once

These are the rules the code enforces. Every one is checked **server-side** inside the existing
advisory-locked transaction in `EmployeesService.create()`, so all three entry points (Hire
button, onboarding wizard, marketplace install) get them for free, and two simultaneous hires
cannot both slip past a limit.

| # | Rule | Plain-English error the customer sees |
|---|---|---|
| R1 | Total ACTIVE+PAUSED employees < `maxRoles × maxPerRole` (existing rule, kept) | "Your Starter plan includes 2 AI employees. Upgrade, or retire one to hire another." |
| R2 | ACTIVE+PAUSED employees **in this role** < `maxPerRole` | "Your Starter plan includes 1 Marketing employee. Upgrade to Growth for 2 per role." |
| R3 | If this role is new to the company, distinct roles in use < `maxRoles` | "Your plan includes 2 roles and you already use HR and Marketing. Upgrade, or retire one role to add Sales." |
| R4 | Subscription `status === ACTIVE` (existing, kept) | "Your subscription is past due — resolve billing before hiring." |
| R5 | New employee's `budgetLimit` defaults to the plan's `creditsPerEmployeePerMonth`; a customer may lower it, never raise it above the plan value | Settings field shows "up to 500 on your plan" |
| R6 | **Disabled and archived employees free their seat and their role slot** (already how the count works — DISABLED is excluded) | — |
| R7 | Changing an employee's role counts as leaving one role and joining another → R2 + R3 apply | same errors as hire |

### Downgrade policy — **recommended: grandfather**

When a Growth company (4 seats) downgrades to Starter (2 seats) with 4 employees hired:
nothing is deleted or paused; **new hires are blocked until they are back under the limits**, and
the employees page shows "4 of 2 seats — retire 2 to hire again". Per-employee credit ceilings are
**capped down** to the new plan's value on downgrade (a $20 customer should not keep $40 ceilings).
This is the least surprising behaviour and matches the recommendation already recorded in the
2026-07-11 spec (Part F, option c).

---

## 4. The customer flow

```
Sign up (free)                 ──►  Onboarding wizard
                                      ├─ "Your free plan includes 2 AI employees, 1 per role"
                                      ├─ picks HR + Marketing  ✅   (2 roles, 1 each)
                                      ├─ tries to add Sales     ✗   "That's a 3rd role — upgrade to add it"
                                      └─ Complete → 2 employees hired, each budgetLimit = 500 credits/mo
                                                    company gets one-time 1,000-credit grant (existing)
                                    ──►  Employees page
                                      ├─ header: "2 of 2 seats · HR 1/1 · Marketing 1/1"
                                      └─ Hire button disabled → "Upgrade to hire more"
                                    ──►  Billing → choose Growth ($40)
                                      ├─ mock provider: switches now; Stripe: checkout → webhook → switch (existing)
                                      └─ on switch: plan allowance 2,000/mo granted by subscription-credit-renewal (existing)
                                    ──►  Employees page now "2 of 4 seats · HR 1/2 · Marketing 1/2"
                                      └─ Hire 2nd Marketing ✅ · Hire Sales ✗ (3rd role) — Growth is still 2 roles
                                    ──►  Each employee's Settings shows "Monthly credits: 500 (plan maximum 500)"
                                    ──►  Run out of credits → "Buy credits" (PAYG, existing) or upgrade
```

---

## 5. Changes by layer

### 5.1 Shared contract (`packages/types`)

```ts
export interface PlanDto {
  plan: Plan; name: string; priceMonthlyUsd: number | null;
  /** Distinct roles the plan allows. null = unlimited. */
  maxRoles: number | null;                    // NEW
  /** Employees allowed per role. null = unlimited. */
  maxPerRole: number | null;                  // NEW
  /** Derived: maxRoles × maxPerRole. Kept for every existing consumer. */
  maxEmployees: number | null;
  /** Default monthly credit ceiling applied to each new employee. null = no default. */
  creditsPerEmployeePerMonth: number | null;  // NEW
  includedCreditsPerMonth: number | null;
  features: string[];
}
```

`UsageDto` gains `perRole: { role: EmployeeRole; used: number; max: number | null }[]` and
`rolesUsed: number`, `maxRoles: number | null`. `ProductContextDto.entitlements` gains the same,
so the resolver — not the page — decides what to show.

### 5.2 API

| Where | Change |
|---|---|
| `billing.plans.ts` | Add the three fields to each `PLAN_CATALOG` row; add `maxPerRoleFor(plan)`, `maxRolesFor(plan)`, `defaultEmployeeCreditsFor(plan)`. `maxEmployeesFor` becomes derived. New unit test asserts `maxEmployees === maxRoles × maxPerRole` for every plan so the two can never disagree. |
| `employees.service.ts` `create()` | Inside the existing transaction, after the total check: count ACTIVE+PAUSED **by role** (R2) and distinct roles (R3). Apply `budgetLimit` default (R5). Same for the role-change path in `update()` (R7). |
| `employees.service.ts` `update()` | Reject `budgetLimit` above the plan default with a 400 naming the ceiling (R5). |
| `billing.service.ts` `usage()` | Add per-role usage. |
| `billing.service.ts` `changePlan()` / webhook apply | On downgrade: cap each employee's `budgetLimit` to the new plan default (one `updateMany` with `WHERE budgetLimit > default`). No pausing, no deleting. Audit-log it. |
| `onboarding.service.ts` `complete()` | It already loops `employees.create()`; nothing to add server-side — R1-R3 apply. Add a friendlier pre-check so the wizard gets one 422 listing *all* violations instead of failing on the first hire. |
| `marketplace.service.ts` | Nothing — uses `create()`. |
| `product-context.service.ts` | Expose `maxRoles`, `maxPerRole`, `perRole` in entitlements. |
| `credit-limits.service.ts` | Nothing — `budgetLimit` already enforced when `CREDIT_ENFORCEMENT_ENABLED` + company enrolled. |
| Preflight | Nothing new; the credit flags are already gated (v2 audit). |

No new tables. No migration — `budgetLimit`, `Plan`, `Subscription` all exist. One data script:
backfill `budgetLimit` for existing employees that have none, to their plan's default.

### 5.3 Web

| Where | Change |
|---|---|
| `/onboarding` wizard | Seat/role counter from `entitlements`; disable a role once its slot is full; explain the limit inline; show "upgrade" link rather than letting the server 422 |
| `/employees` header | "N of M seats · HR 1/1 · Marketing 0/1"; Hire button disabled with the exact reason and an upgrade CTA |
| `EmployeeForm` (Hire dialog) | Role dropdown greys out roles whose slot is full, with the reason |
| `EmployeeSettings` | "Monthly credits" field shows the plan maximum; values above it rejected client-side too |
| `/billing` `PlanCatalog` | Show roles × per-role, credits/employee, allowance per plan (the matrix in §2) |
| `/billing` `UsageSummary` | Per-role bars |
| Dashboard "Your AI workforce" | seat usage line |

### 5.4 Billing / Stripe

- Two Stripe prices already have env slots: `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`. Set them to
  $20 and $40 products. No code change.
- Monthly allowance on paid plans uses the existing `subscription-credit-renewal` (worker driver
  shipped 2026-09-03).
- **None of the credit rules bite until `CREDIT_LEDGER_ENABLED` + `CREDIT_ENFORCEMENT_ENABLED`
  are on** — that is the sign-off in `2026-08-20-credit-economics-decision.md`. Seat/role rules
  (R1-R4, R6-R7) are independent of the credit flags and bite immediately.

---

## 6. Edge cases (each gets an e2e test)

| Case | Behaviour |
|---|---|
| Two concurrent hires at 1-of-1 Marketing | one succeeds, one 403 (advisory lock, existing) |
| Retire (disable) the only HR, hire a Sales | ✅ — the role slot is freed |
| Archive an employee | frees seat + role slot (archived excluded from counts) |
| Change an HR employee's role to Sales on a 2-role plan already using HR + Marketing | ✗ R3 (would be a 3rd role) |
| Change role within the same role | no-op, no checks |
| Downgrade Growth → Starter with 4 employees | allowed; hires blocked; `budgetLimit` capped to 500 for all four; audit row |
| Upgrade Starter → Growth | allowed; existing `budgetLimit`s untouched; second slot per role opens |
| Onboarding picks 3 roles on a 2-role plan | one 422 listing the problem; nothing partially hired |
| Marketplace "install HR Assistant" when HR slot is full | 403 with the same R2 message |
| PAST_DUE subscription | hire blocked (existing) |
| Employee `budgetLimit` set to 800 on a 500 plan via direct API | 400 |
| Plan value `null` (Enterprise) | every check skipped |

---

## 7. Rollout

1. Types + catalog + unit test (`maxEmployees === maxRoles × maxPerRole`).
2. Server rules R2/R3/R5/R7 + downgrade cap + e2e tests. **Ship behind nothing** — these are
   correctness rules and Starter's numbers equal today's (2 seats), so no existing tenant is
   affected except one that already has >1 of a role on Free/Starter (grandfathered by R6 policy).
3. Backfill `budgetLimit` defaults (script, idempotent).
4. Web: entitlements → wizard → employees header → hire dialog → billing pages.
5. Browser spec: onboarding hits the role limit; hire dialog greys the full role; billing shows the
   matrix.
6. Stripe prices set; `STRIPE_PRICE_*` env in production.
7. Founder signs off the credit-economics record → flip credit flags → per-employee ceilings bite.

Estimated size: ~2 days API + tests, ~2 days web + browser specs.

---

## 8. What this deliberately does NOT do

- No new `Plan` enum values (a migration + every `PLAN_RANK` consumer for nothing — the four
  existing values cover the four tiers; only names and prices change).
- No per-role *pricing* (an "HR add-on seat" SKU). Everything is priced at the plan level.
- No pausing or deleting employees on downgrade.
- No trial period — Free is the trial (already decided in the 2026-07-11 spec).
- No change to how credits are priced or settled.

---

## 9. Founder decisions needed before code (⚑)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Plans = "N roles × M per role, customer picks the roles" — or fixed named bundles ("HR + Marketing pack")? | **Roles × per-role.** Same value for every customer, no wrong-role lock-in. |
| Q2 | Prices: $20 / $40 for Starter / Growth, replacing today's illustrative $49 / $199? | **Yes** — rename PRO→"Starter", BUSINESS→"Growth" in the catalog; enum unchanged. |
| Q3 | Credits per employee per month | **500** on every tier (≈ $4.50 provider cost each) |
| Q4 | Monthly allowance | **Starter 1,000 / Growth 2,000** (≈ 55 % margin at full use) — replaces today's 4,000 / 18,000 |
| Q5 | Free tier: keep one-time 1,000 grant with no monthly top-up? | **Yes** (already the decided Option C) + 500/employee ceiling |
| Q6 | Downgrade policy | **Grandfather** (block new hires; cap ceilings; never pause/delete) |
| Q7 | AI Assist stays a Growth+ feature? | **Yes** — it is the most expensive thing to run |

---

## 10. Implementation record (2026-09-04)

Everything in §5 shipped in one change set; nothing in §8 was built.

| Layer | What landed |
|---|---|
| `packages/types` | `RoleSeatUsageDto`, `SeatUsageDto`; `PlanDto.{maxRoles,maxPerRole,creditsPerEmployeePerMonth}`; `UsageDto.seats`; `EntitlementsDto.{seats,creditsPerEmployeePerMonth}` |
| `billing.plans.ts` | Free $0 2×1 · Starter $20 2×1 · Growth $40 2×2 · Enterprise ∞; 500 credits/employee; 1,000 / 2,000 monthly; pure `checkSeatFor()` — the ONE seat rule |
| `employees.service.ts` | R1–R3 inside the existing advisory-locked transaction (all three hire entry points); R5 stamps the default at hire and refuses a higher `budgetLimit` on update, naming the ceiling |
| `billing.service.ts` | `usage().seats`; downgrade → `applyDowngradeCeilings` (grandfather: nothing paused, ceilings capped, audited) on both the immediate mock switch and the Stripe webhook path |
| `product-context` | `entitlements.seats` from the same roster/rule, so the UI greys exactly what the server refuses |
| `onboarding.service.ts` | one 422 for the whole selection, nothing partially hired |
| Migration `20260904120000` | backfills `budgetLimit` for existing employees to the plan ceiling |
| Web | `useSeatAvailability()`; hire form greys full roles + shows "N of M seats · roles"; roster `SeatSummary`; wizard step 2 disables roles the plan cannot take; Settings shows "up to $5 on your plan"; billing catalog shows roles × per-role + credits; usage shows per-role bars |
| Tests | `billing.plans.spec.ts` (13, incl. `maxEmployees === maxRoles × maxPerRole` and the 50 %-of-price margin guard); `employees-seats.e2e-spec.ts` (13, incl. retire-frees-slot, downgrade caps ceilings, onboarding 422); fixtures that hire many employees moved from BUSINESS to ENTERPRISE |

**Not done, on purpose:** R7 (role change re-check) — `role` is not editable after hire, so there is no code path; Stripe prices are env values (`STRIPE_PRICE_PRO`/`_BUSINESS`) the founder sets; the credit ceilings bite only once the credit flags are on.
