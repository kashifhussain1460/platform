# Credit billing — founder sign-off checklist

Credit system Phase 13, Task 13.5. This is the gate: **`CREDIT_ENFORCEMENT_ENABLED` must never be flipped to `true` for a real, non-canary company while any item below is still open.** The check is mechanical, not a judgment call — grep the codebase for the `// FOUNDER-PENDING:` marker; every hit below must be resolved (a real number or policy chosen, the marker and its placeholder deleted) before this gate passes.

**Current status: GATE NOT PASSED.** As of this writing, `grep -rn "FOUNDER-PENDING" apps/api/src apps/web/src packages/types/src` returns the items below — every one of them ships today as a clearly-labeled, illustrative placeholder rather than a real business decision, per this project's own rule against inventing numbers on the founder's behalf.

---

## Open items (grep results, one row per marker)

| # | File | What it decides | Current placeholder | Plan reference | Recommended option |
|---|---|---|---|---|---|
| 1 | `apps/api/src/common/config/credit-config.ts` (`freeGrantCredits`) | One-time signup credit grant size | 1,000 credits | §7.2 | A (fixed one-time block) |
| 2 | `apps/api/src/common/config/credit-config.ts` (`freeGrantExpiryDays`) | How long the signup grant stays claimable | 30 days | §7.2 | — |
| 3 | `apps/api/src/common/config/credit-config.ts` (`freeGrantDomainCap`) | Max free grants per email domain per 24h | 3 | §26 (kill-critic Q11) | Option A conservative fixed |
| 4 | `apps/api/src/modules/billing/billing.plans.ts` (PRO) | PRO plan's `includedCreditsPerMonth` | 4,000 | §17.4/§35.4 | Option C structure (STARTER excluded), Option B numbers open |
| 5 | `apps/api/src/modules/billing/billing.plans.ts` (BUSINESS) | BUSINESS plan's `includedCreditsPerMonth` | 18,000 | §17.4/§35.4 | same as #4 |
| 6 | `apps/api/src/modules/billing/credit-packs.ts` (SMALL/MEDIUM/LARGE) | Credit-pack sizes, bonus %, USD prices | $10/1,000cr, $50/5,500cr(+10%), $100/12,000cr(+20%) | §18 | Option A fixed catalog + Option A flat per-tier bonus |
| 7 | `apps/api/src/modules/credits/credit-cost-calculator.service.ts` (`safetyMarginPct`) | Safety margin added atop the raw LLM-cost estimate | 10% | §5 worked example | — |
| 8 | `apps/api/src/modules/credits/credit-rates.defaults.ts` (`DEFAULT_CREDITS_PER_USD`) | The USD → credit conversion rate ("1 credit = $X") | 100 credits/USD ($0.01/credit) | §4/§28.2.1 | Option A ($0.01/credit) |
| 9 | `apps/api/src/modules/credits/credit-rates.defaults.ts` (`DEFAULT_SAFETY_MARGIN_PCT`) | Same as #7, the seeded DB-row default | 10% | §5 | — |
| 10 | `apps/api/src/modules/credits/credit-reconciliation.service.ts` (cost-leg tolerance) | Reconciliation mismatch tolerance (flat $ / %) | $5 flat or 2%, whichever is greater | §25.3 | Option B |
| 11 | `apps/api/src/modules/credits/company-concurrency-guard.service.ts` (`COMPANY_MAX_CONCURRENT_EXECUTIONS`) | Per-company in-flight execution cap | 10 | §26/§27 | Option A conservative fixed |
| 12 | `apps/web/src/components/app-shell/CreditBadge.tsx` (`LOW_THRESHOLD_PCT`/`CRITICAL_THRESHOLD_PCT`) | Low/Critical balance-warning thresholds | 25% / 10% of trailing monthly spend | §17/§21 | Option B (25%/10%) |
| 13 | `packages/types/src/credits.ts` (`DEFAULT_CREDITS_PER_USD`) | Frontend mirror of #8 — must always match it exactly | 100 credits/USD | §4 | same as #8 |

Every placeholder above already carries its **recommended** option inline in the code comment — the founder's job is to confirm or override each one, not derive it from scratch. Items #8 and #13 are the SAME number in two places (backend source of truth, frontend illustrative mirror) and must be changed together or they silently drift.

## Items already resolved this implementation (NOT open)

These appeared as "PROPOSED, REQUIRES FOUNDER APPROVAL" in the architecture document but were resolved as explicit **structural/architectural** decisions during implementation (confirmed via in-session sign-off, not business numbers):

- §18 refund design — follows §40.7 + the already-built schema (confirmed 2026-08-19, Phase 6).
- §35.3 migration-welcome-grant mechanism — Option B (reuse the `PLAN_ALLOTMENT` ledger mechanic), implemented in Phase 11.
- §35.4 STARTER/ENTERPRISE recurring-grant structure — Option C (no recurring allotment for STARTER; the *numbers* for PRO/BUSINESS remain open, see #4/#5 above).
- §35.5 `AiEmployee.budgetLimit` unit — Option A (adopt as-is, no backfill), implemented across Phases 1-8.
- §9.7 credit pool model — Option A (single fungible credit type), `creditType` column kept for future extension.

## What "resolving" an item means in practice

For each numbered row above: pick a value (the recommended option, or a different one), then:
1. Replace the placeholder constant/default with the chosen value.
2. Delete the `// FOUNDER-PENDING:` comment (or replace it with a plain comment citing the decision date/source — the marker itself must not remain).
3. Re-run `grep -rn "FOUNDER-PENDING" apps/api/src apps/web/src packages/types/src` — it must return nothing.

Only once that grep is empty does this gate pass, and only then may `docs/ops/credit-rollout-runbook.md`'s Step 5 (enforcement) proceed past its own canary-first sequencing for a real, non-canary company.
