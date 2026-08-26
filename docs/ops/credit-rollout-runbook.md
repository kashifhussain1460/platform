# Turning on real credit billing — the flag sequence

Credit system Phase 12, Task 12.2 (§36.2). This is the checklist for going
from "the credit system exists in the codebase" to "a real company can be
blocked for running out of credits" — one flag at a time, never a single
switch. A second engineer should be able to run this whole rollout from this
document alone, with no other context.

**Decision taken: promote company-by-company at the last step (enforcement),
everything before that is a global flag.** Only Phase 5 below has a
per-company canary mechanism (`Company.creditEnforcementEnabledAt`) — every
earlier phase is a plain env var, same as `WORKFLOW_EXECUTION_MODE` or
`QUEUE_WORKERS_ENABLED` elsewhere in this codebase.

---

## Plain-language version

Six flags, flipped one at a time, each one only building on top of the last:

1. Start quietly counting what things would cost (nobody sees this, nothing is blocked).
2. Give companies a free starter balance (they can see it now, still nothing is blocked).
3. Let companies buy more credits (real money moves, still nothing is blocked).
4. Give paying plans a monthly top-up (still nothing is blocked).
5. **Actually block a company that hits zero** — one company at a time first, then everyone.
6. Turn on the manual admin tool for special/enterprise deals.

Nothing in steps 1-4 can ever stop a real message, workflow run, or tool
call — the whole point of doing it in this order is to prove the numbers are
right for weeks before the first person can actually be blocked.

---

## Step 1 — Ledger + shadow mode

| | |
|---|---|
| Flag | `CREDIT_LEDGER_ENABLED=true` |
| What ships | `CreditLedger`/`CompanyCreditBalance`/`ProcessedWebhookEvent` tables; shadow-mode debit computation at chat, AI_STEP, and TOOL_ACTION — logged/metriced, **never thrown** |
| User-visible change | None |
| Exit criteria (before Step 2) | N days of shadow data collected across all companies; shadow-cost reconciles against `UsageEvent`'s existing cost basis; zero unhandled errors in shadow code paths in production |
| Rollback | `CREDIT_LEDGER_ENABLED=false` — zero user impact, nothing was ever gated |

## Step 2 — Free credits granted

| | |
|---|---|
| Flag | `CREDIT_GRANTS_ENABLED=true` |
| What ships | Onboarding-complete signup grant; `/billing` shows a real (informational) balance for the first time |
| User-visible change | Balance visible on `/billing`; "you have N free credits" messaging |
| Exit criteria | Grant transaction verified idempotent (no double-grant on a retried onboarding completion); displayed balance verified accurate against the ledger for a sample of companies |
| Rollback | `CREDIT_GRANTS_ENABLED=false` — new signups stop receiving grants; already-granted balances are **not** clawed back |

## Step 3 — PAYG credit purchases

| | |
|---|---|
| Flag | `CREDIT_PAYG_ENABLED=true` (+ existing `BILLING_PROVIDER=mock\|stripe`) |
| What ships | "Buy credits" UI + checkout; `ProcessedWebhookEvent` dedupe now load-bearing for real money |
| User-visible change | Purchased credits become spendable balance |
| Exit criteria | A real Stripe **test-mode** purchase verified end-to-end including duplicate-webhook-delivery dedupe, and one refund exercised |
| Rollback | `CREDIT_PAYG_ENABLED=false` hides the purchase UI; already-purchased credits remain spendable (never expire) |

## Step 4 — Subscription credits

| | |
|---|---|
| Flag | `CREDIT_SUBSCRIPTION_GRANTS_ENABLED=true` |
| Prerequisite | `includedCreditsPerMonth` populated in `PLAN_CATALOG` for every plan (founder-approved numbers) |
| What ships | `invoice.payment_succeeded` webhook handling; renewal `PLAN_ALLOTMENT` ledger entries begin |
| User-visible change | "N credits included in your plan, resets each period" |
| Exit criteria | At least one full real (or design-partner) billing-period renewal observed end-to-end with the correct grant amount and no double-grant on a redelivered webhook |
| Rollback | `CREDIT_SUBSCRIPTION_GRANTS_ENABLED=false` stops new renewal grants; already-granted credits remain spendable |

## Step 5 — Enforcement (the point of no return, done one company at a time)

| | |
|---|---|
| Flag | `CREDIT_ENFORCEMENT_ENABLED=true` (global) **+** per-company `Company.creditEnforcementEnabledAt` (the canary allowlist) |
| Admin surface | `PATCH /internal/platform-admin/companies/:companyId/credit-enforcement` (Task 12.1, `PlatformAdminGuard`-only) |
| What ships | Layer 1/2/3 checks flip from log-only to actually blocking, at the same insertion points as the shadow-mode checks from Step 1 |
| User-visible change | The Zero-state blocking modal; `/billing`'s amber banner becomes actionable |
| **Sequence — do NOT skip** | 1) Pick ONE low-risk company (internal test tenant or a real, low-volume, informed design partner). 2) `PATCH` that company's `creditEnforcementEnabledAt` on. 3) Watch it for the observation window below. 4) Only then flip the **global** `CREDIT_ENFORCEMENT_ENABLED=true` for everyone else. |
| Exit criteria (canary → global) | Task 12.3's canary-comparison report shows **zero discrepancies** between what the canary company's enforcement-on decisions were and what shadow mode would have logged for the same calls, over the whole observation window |
| Rollback | `CREDIT_ENFORCEMENT_ENABLED=false` (global) or remove one company from the allowlist (`PATCH .../credit-enforcement {enabled:false}`) — instant, zero data loss |

## Step 6 — Enterprise manual-adjustment tooling

| | |
|---|---|
| Flag | None required (RBAC-gated via `PlatformAdminGuard`, not a company role) |
| What ships | `POST /internal/platform-admin/companies/:companyId/credits/adjustments` (Task 10.2) made available to platform operators |
| Exit criteria | At least one real ENTERPRISE contract's terms provisioned and verified end-to-end via the tool before it is made available to all internal operators |
| Rollback | Revoke the operator's token / disable their `PlatformOperator` row (`status:'DISABLED'`) — already-written ledger entries remain (append-only) |

---

## The one rule that governs all of this

No company may reach `CREDIT_ENFORCEMENT_ENABLED=true` (Step 5) without
having first spent a real, observed window in Steps 1-4 for that same
company. Steps 1-4 are global flags — every company gets the SAME soak time
by construction. Step 5 is the only step with a per-company gate, and it
exists specifically so the first real block a customer ever sees is never a
surprise on a day nobody chose.
