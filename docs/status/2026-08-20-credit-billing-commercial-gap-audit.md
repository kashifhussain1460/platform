# Credit Billing — Commercial Gap Audit (2026-08-20)

Verified against the actual code in `apps/api/src`, `apps/api/prisma/schema.prisma`, and
`apps/web/src` — not against the Phase 1-13 completion claim in
`docs/architecture/orlixa-ai-credit-usage-billing-plan.md`. Every row below cites the file:line
that was actually read.

## GAP matrix

| # | Gap | Evidence | Status | Decision |
|---|-----|----------|--------|----------|
| 1 | Credit economics ($/credit, margin, plan allotments, pack prices) locked | `credit-rates.defaults.ts:18` (`DEFAULT_CREDITS_PER_USD=100`), `:22` (10% margin), `credit-config.ts:32/38/44` (signup grant/expiry/domain cap), `billing.plans.ts:36/52` (PRO/BUSINESS allotments), `credit-packs.ts:16/27` (pack sizes/prices) — all real defaults, all still `FOUNDER-PENDING` | PARTIAL — architecture (versioned `ModelCostRate`/`ToolCostRate`/`CreditPack` tables) is DONE; the **numbers** are not founder-locked | **FOUNDER DECISION**, not engineering. No runtime guard blocks enforcement while pending (confirmed: no code greps `FOUNDER-PENDING` at boot) — this has been a deliberate manual/process gate since Phase 12, not a bug |
| 2 | Unified Plan → Entitlement → Enforcement layer | No `Plan`/`Entitlement` Prisma model (`Subscription.plan` is a bare enum, `schema.prisma:1153-1175`); `PlanGuard` (`plan.guard.ts:26-56`) checks tier only, used on 2 routes; own doc-comment admits "every other plan limit today is informational only" (`plan.guard.ts:21-24`); **3 independent plan-tier implementations**: `PlanGuard`, `workflow-templates.service.ts:35,381-390` (`PLAN_RANK`), `subscription-credit-renewal.service.ts:58` (reads `PLAN_CATALOG` directly); employee-cap enforcement (`employees.service.ts:64-86`) bypasses all of them; credit enforcement (3-layer engine) is a fully separate code path from plan/tier gating; **`PlanGuard` never checks `subscription.status`** — a PAST_DUE company still passes tier checks on Assist/AI-draft routes, while `employees.service.ts:65-69` does check status. No team/seat (human) limit exists at all | SCATTERED, confirmed | **FIX NOW** (bug: status-blind PlanGuard; duplication: 3 plan-rank implementations). Do NOT build a new `EntitlementsService` — extend `billing.plans.ts` with one canonical helper and fix `PlanGuard` in place. Team/seat limits: **DEFER**, no evidence of urgent need |
| 3a | Phantom per-execution/per-task credit ceilings | `AiEmployee.maxCreditsPerExecution`/`maxCreditsPerTask` (`schema.prisma:694-695`) are stored and settable in the Employee Settings UI; `EmployeeExecutionCeilingExceededError`/`EmployeeTaskCeilingExceededError` (`credit-limits.service.ts:50-75`) exist with a comment claiming a "Kill-critic audit gap fix, 2026-08-20" — but **zero call sites** throw them; the only real enforcement is `checkAndReserveEmployeeBudget`'s monthly-budget check (`credit-limits.service.ts:96-151`) | CONFIRMED LIVE BUG — a customer sets a ceiling, sees it saved, and it silently does nothing (this codebase's own "silent-success defect class") | **FIX NOW** — Task 1 below |
| 3b | Customer usage transparency | `GET /billing/credits` (`billing.controller.ts:67-81`) has no included-vs-purchased split; `GET /billing/credits/usage` (`:121-158`) returns flat filterable rows, no grouped totals by employee/workflow; no cost/margin leakage found (clean); no forecasting ("credits will last ~N days") anywhere in `apps/web/src` | PARTIAL — balance + flat ledger exist; no split, no grouped summary, no forecast | Included/purchased split + grouped summary = **FIX NOW** (basic transparency). Forecasting = **DEFER** (not opaque today — per-action estimate already exists in `ChatPanel.tsx:91-103`) |
| 4 | Immutable pricing snapshot per charge | `CreditLedger.modelCostRateId`/`toolCostRateId` (`schema.prisma:1240-1245`) freeze the rate-version FK on every DEBIT/RESERVATION; `ModelCostRate`/`ToolCostRate` are effective-dated and closed via `effectiveTo`, never mutated; `CreditRollupService`/`FinanceReportingController` read only stored `amount`, never re-price historically | CONFIRMED, already correct | **NO ACTION.** This is the one gap candidate that's genuinely done |
| 5 | Task-level estimated credit ranges ("simple task ~5-10cr") | Grep for `estimatedRange`/`costCategory`/`taskComplexity` across `apps/web/src` and `apps/api/src`: zero matches. Plan doc has no such concept either | NOT FOUND — greenfield | **DEFER** (USEFUL_LATER). Product-layer work, not a defect; per-action estimate already covers the acute confusion case |
| 6 | Enterprise department/AI-employee budget governance | `Department`/`Team` models exist (`schema.prisma:1561,1590`) but are used only by HR/org-chart/approval-routing — zero references inside `apps/api/src/modules/credits/*`; `AiEmployee` has no `departmentId` FK (confirmed already-known deferred item, `platform/CLAUDE.md` "Deferred" list); no company-level $ spend cap distinct from balance-hits-zero | NOT FOUND, and its prerequisite (`AiEmployee.departmentId`) is separately deferred elsewhere | **DEFER.** Building this now means building the missing FK first — out of scope for a credit-billing gap fix, no enterprise contract requires it yet |

## Kill-critic verdict

The credit **engine** (ledger, reservation, settlement, idempotency, lot/batch expiry, refunds,
concurrency guard) is not touched by this audit and is not being reopened — all of that verified
CONFIRMED in a separate pass and matches the Phase 1-13 claim.

What's actually left is: one live bug (#3a), one enforcement gap that's really a fragmentation
problem, not a missing feature (#2), and one transparency gap that's additive, not architectural
(#3b). #1 is a business decision this document surfaces evidence for but cannot make. #4 needs
nothing. #5 and #6 are correctly deferred — implementing either now would be
`UNNECESSARY_COMPLEXITY` per the audit's own kill-critic rule (no enterprise contract, no acute
customer confusion driving them).

**FINAL VERDICT: B — READY WITH FOLLOW-UP ITEMS.** The follow-ups are Tasks 1-5 in
`docs/superpowers/plans/2026-08-20-credit-billing-commercial-gaps-plan.md`, plus a founder
sign-off on Gap 1's numbers (unchanged from the Phase 13 gate — still not granted).

**NEXT PRIORITY outside credit billing:** the realtime WS gateway (P5-01/02/03, deferred per doc
29) — every other Phase-13-adjacent system (workflow runs, approvals) still polls at 1s, and it's
the one deferred item on the CTO hardening roadmap with no credit-billing dependency blocking it.
