# Verify-05 — Credit enforcement rollout vs. a flag-independent safety ceiling

Read-only verification pass, 2026-09-09. Nothing in the repo was modified, no flag or config touched.
Verifying the hypotheses in `10-billing-credits-and-integrations.md` (Part A) and `01-monorepo-database.md` (§C).
All paths relative to `d:/Vertical AI/platform`. Evidence hierarchy: executable code > schema > docs.

**Headline corrections to the prior findings (both are load-bearing for the decision):**

1. 🔴 **The concurrency guard is NOT the only always-on safety net.** There is a second, completely
   flag-independent, always-on **per-employee monthly USD spend ceiling** — `assertUnderBudget`
   (`agent-runtime.service.ts:880-895`) and its copy in `ai-step.handler.ts:106-117`, comparing real
   `UsageEvent` spend against `AiEmployee.budgetLimit`, which every new employee is **stamped with at
   hire** as **$5/employee/month** (`employees.service.ts:114-131`). This materially changes the
   "unmetered AI spend" framing: chat, `AI_EMPLOYEE_STEP` and `AI_STEP` are *already* capped today at
   roughly $5 × seats per month. Cluster 10 §A.4's "no ceiling at all on sequential spend" is wrong for
   those three paths, and right only for the paths listed in §3.3 below.
2. 🔴 **`WorkflowRun.creditLimit` has no writer anywhere in the application.** Layer 3 is therefore a
   permanent no-op even with every flag on, not merely flag-gated. See §4.

---

## 1. The full flag architecture

### 1.1 `apps/api/src/common/config/credit-config.ts` — complete export list

The whole file is 87 lines; every export reads **raw `process.env`**, not `ConfigService`
(`credit-config.ts:1-6` states this is deliberate, mirroring `queueWorkersEnabled()`).
**Consequence for tests: the CLAUDE.md "ConfigModule snapshots env at import time" gotcha does NOT apply
to these four flags** — a spec's `beforeAll` mutation of `process.env.CREDIT_*` is honoured. It DOES apply
to `COMPANY_MAX_CONCURRENT_EXECUTIONS` (see §3.1).

| Export | File:line | Env key | Exact default | Semantics |
|---|---|---|---|---|
| `creditLedgerEnabled()` | `:16-18` | `CREDIT_LEDGER_ENABLED` | `false` (strict `=== 'true'`) | Master switch for the reserve/settle/release lifecycle |
| `creditGrantsEnabled()` | `:28-30` | `CREDIT_GRANTS_ENABLED` | `false` | Gates the one-time free-signup grant only |
| `freeGrantCredits()` | `:33-36` | `FREE_GRANT_CREDITS` | `1_000` | `// FOUNDER-PENDING` — signup grant size |
| `freeGrantExpiryDays()` | `:39-42` | `FREE_GRANT_EXPIRY_DAYS` | `30` | `// FOUNDER-PENDING` — lot expiry |
| `freeGrantDomainCap()` | `:45-48` | `FREE_GRANT_DOMAIN_CAP` | `3` | `// FOUNDER-PENDING` — grants per email domain / 24h |
| `creditPaygEnabled()` | `:56-58` | `CREDIT_PAYG_ENABLED` | `false` | Gates the credit-pack Checkout Session |
| `creditEnforcementEnabled()` | `:71-73` | `CREDIT_ENFORCEMENT_ENABLED` | `false` | The **global** half of the two-key design |
| `companyEnforcementActive(company)` | `:82-86` | — | — | The **AND** of both keys |

All three numeric getters use the same shape: `Number(raw)`, and fall back to the default unless
`Number.isFinite(raw) && raw > 0`. So `FREE_GRANT_CREDITS=0` silently becomes `1000`, and a
non-numeric value silently becomes the default — there is no boot-time validation of any of them.

### 1.2 `companyEnforcementActive()` — exact logic and every call site

```ts
// credit-config.ts:82-86
export function companyEnforcementActive(company: {
  creditEnforcementEnabledAt: Date | null;
}): boolean {
  return creditEnforcementEnabled() && company.creditEnforcementEnabledAt != null;
}
```

It takes a **structural** argument (only the one field), so every call site does its own narrow
`select: { creditEnforcementEnabledAt: true }` read. There are exactly **three** call sites, all inside
an outer `if (creditLedgerEnabled())` — so **enforcement is unreachable without the ledger flag,
enforced in code as well as in preflight**:

| # | Call site | The `select` read | The `companyEnforcementActive` call |
|---|---|---|---|
| 1 | Chat / `AI_EMPLOYEE_STEP` — `agent-runtime.service.ts` | `:398-401` | `:402` (inside `if (creditLedgerEnabled())` at `:393`) |
| 2 | Workflow `AI_STEP` — `ai-step.handler.ts` | `:147-150` | `:151` (inside `if (creditLedgerEnabled() && stepRunId)` at `:146`) |
| 3 | `TOOL_ACTION` / `runTool` — `skills.service.ts` | `:774-777` | `:778` (inside `if (creditLedgerEnabled() && priced.credits > 0)` at `:765`) |

A fourth site reads the column **directly**, not via the helper — the legacy-engine retry gate:
`workflows.service.ts:910-933` (`if (run.engineMode !== 'state_machine')` → `company?.creditEnforcementEnabledAt != null` → 409 if the workflow has any `AI_STEP`/`AI_EMPLOYEE_STEP`/`TOOL_ACTION` node). **This one ignores the global `CREDIT_ENFORCEMENT_ENABLED` flag entirely** — stamping `creditEnforcementEnabledAt` on a company blocks legacy-engine retries of billable runs for that company *even with the global flag off*. That is a real, immediate, customer-visible behaviour change from stamping the column alone, and the single most likely surprise in option (a).

### 1.3 What precisely becomes a no-op when each flag is `false`

**`CREDIT_LEDGER_ENABLED=false`** — five branches, all skipped:

| File:line | Branch | What is skipped |
|---|---|---|
| `agent-runtime.service.ts:393` | `if (creditLedgerEnabled())` | `priceLlmCall`, both `creditLimits` checks, `reservations.reserve`. The turn proceeds; `estimatedCredits`/`reservation` stay `null`, so the settle at the end of the turn is also skipped |
| `ai-step.handler.ts:146` | `if (creditLedgerEnabled() && stepRunId)` | Same, plus `settleReservation`/`releaseReservation` (both guarded on `reservationId`, which stays `null`) |
| `skills.service.ts:765` | `if (creditLedgerEnabled() && priced.credits > 0)` | `enforcementBlockedError` stays `null` → the tool always executes. Note `priceToolCall` still runs unconditionally at `:764` so `SkillExecution.creditsUsed` is still written |
| `run-state-writer.service.ts:292` | `if (creditLedgerEnabled() && RESERVATION_RESOLVING_STATUSES.has(input.to))` | `resolveStepReservation` — the crash-recovery reservation resolver |
| `reaper.service.ts:188` | `if (creditLedgerEnabled())` | The `PENDING → EXPIRED_UNKNOWN` flip on lease expiry |

Net effect: no `CreditReservation`, no `CreditLedger` DEBIT, no `CompanyCreditBalance` movement, and
therefore **no `rollUpSpendOntoRun`** — so `WorkflowRun.totalCreditsCharged` and
`WorkflowStepRun.creditsCharged` stay at 0/null and the whole `/billing/usage` page and `RunCreditPanel`
are empty by construction. `UsageEvent` writes are **unaffected** (`usage.service.ts:56-101`, no flag).

**`CREDIT_GRANTS_ENABLED=false`** — exactly **one** branch: `onboarding.service.ts:408-410`
(`if (creditGrantsEnabled()) grantedCredits = await this.grantFreeSignupCredits(companyId)`).
`grantFreeSignupCredits` (`:461-522`) is otherwise unreachable. Nothing else in the repo reads this flag.
**It does NOT gate the recurring plan allotment** — see §2.2, this is important.

**`CREDIT_PAYG_ENABLED=false`** — exactly **one** branch: `billing.service.ts:204-206`
(`if (!creditPaygEnabled() || !this.provider.createCreditCheckoutSession) return { checkoutUrl: null }`).
The endpoint still 200s (via `POST /billing/credits/purchase`, `billing.controller.ts:89`) and still
validates the pack id at `:201-203`; it just returns a null url, so a customer who runs out has no
self-serve top-up path.

**`CREDIT_ENFORCEMENT_ENABLED=false`** — the three `if (enforcementActive)` blocks at
`agent-runtime.service.ts:420-461`, `ai-step.handler.ts:168-182`, `skills.service.ts:779-809`
(Layers 2 and 3), **plus** the Layer-1 rethrows at `agent-runtime.service.ts:481-485`,
`ai-step.handler.ts:208-226` and `skills.service.ts:833-835`. With enforcement off, an
`InsufficientCreditsError` from the guarded balance `updateMany`
(`credit-ledger.service.ts:182-189`) is **swallowed and logged as a "shadow mode" warning** — the work
proceeds. That is the literal mechanism behind preflight's "a company at zero balance keeps getting
unlimited AI".

---

## 2. What "enable for new tenants" would actually require

### 2.1 🔴 A brand-new company gets ZERO credits today, and would get zero even with grants on unless it finishes the onboarding wizard

Traced end to end:

- `AuthService.register` (`auth.service.ts:85-159`) creates `Company` + owner `User` in one transaction
  (`:95-120`), then calls `billing.ensureDefaultSubscription` (`:126`). **No credit grant, no
  `CompanyCreditBalance` row, no `creditEnforcementEnabledAt` stamp** anywhere in this method.
- `BillingService.ensureDefaultSubscription` (`billing.service.ts:69-108`) creates a `STARTER`/`ACTIVE`
  subscription with `currentPeriodEnd = now + 1 month` (`:91`). **No credit effect.**
- `OnboardingService.complete` is the **only** signup-path grant: `:408-410`, gated by
  `creditGrantsEnabled()`, calling `grantFreeSignupCredits` → a `FREE_SIGNUP` `CreditLedger` CREDIT of
  `freeGrantCredits()` (1,000) + a matching `CreditLot` expiring in 30 days, in one transaction,
  idempotent on `free-grant:{companyId}` (`:487-511`). Three gates can silently return `0`: no owner
  email (`:468-471`), disposable domain (`:472-475`), domain-velocity cap (`:476-484`).
- `CompanyCreditBalance` is created lazily, **only** by `CreditLedgerService.appendWithin`'s self-heal
  upsert (`credit-ledger.service.ts:170-174`) or `CreditBalanceService.balance`'s upsert
  (`credit-balance.service.ts:20`) — i.e. only once something already touches credits.

**Verifying the naive-flip danger precisely — CONFIRMED, and worse than the brief assumed:**

`CREDIT_ENFORCEMENT_ENABLED=true` alone would change nothing (no company is on the allowlist — the
two-key design holds). But `CREDIT_LEDGER_ENABLED=true` + `CREDIT_ENFORCEMENT_ENABLED=true` + any
company stamped, with `CREDIT_GRANTS_ENABLED=false`, means:

1. Balance is 0 (nothing ever granted).
2. First AI call → `reserve()` → `credit-ledger.service.ts:182-189` guarded `updateMany` finds
   `balance >= amount` false → `InsufficientCreditsError`.
3. `enforcementActive` is true → the error is **rethrown** as
   `ConflictException('This company has run out of credits…')` (`agent-runtime.service.ts:481-485`).

→ **Total AI outage for that company on its first message.** Confirmed.

And critically, **turning grants on does not fix it for existing or paid tenants either**, because:
- `grantFreeSignupCredits` is idempotent on `free-grant:{companyId}` and only reachable from
  `OnboardingService.complete`, which early-returns once `onboardedAt` is stamped
  (`onboarding.service.ts:401-406` documents the ordering). **An already-onboarded company can never
  receive the signup grant** — no backfill path exists in the product (only the one-off
  `src/scripts/backfill-credit-balances.ts`).
- STARTER's `includedCreditsPerMonth` is `null` (`billing.plans.ts:51`), so the free tier gets **no**
  recurring allotment ever.
- PRO/BUSINESS get their allotment only on a **renewal**, not the first period (§2.2) — so even a
  paying company is at 0 for its first month.

### 2.2 The plan-credit / allowance model

`billing.plans.ts:34-112`, cross-checked against `docs/product/2026-09-04-role-based-hiring-plans.md`:

| Plan (enum) | Display | Price | Seats | `creditsPerEmployeePerMonth` | `includedCreditsPerMonth` |
|---|---|---|---|---|---|
| `STARTER` | Free | $0 | 2 roles × 1 = 2 | 500 | **`null`** — one-time 1,000 grant only (`:49-51` cites §35.4 Option C) |
| `PRO` | Starter | $20 | 2 × 1 = 2 | 500 | 1,000 |
| `BUSINESS` | Growth | $40 | 2 × 2 = 4 | 500 | 2,000 |
| `ENTERPRISE` | Enterprise | custom | ∞ | **`null`** | **`null`** (own mechanism: `EnterpriseCreditAgreement`, `:107-110`) |

**How `budgetLimit` relates to it** — `employees.service.ts:114-131`, inside the advisory-locked hire
transaction:

```ts
const defaultCredits = creditsPerEmployeeFor(plan);          // 500, or null for ENTERPRISE
const budgetLimit =
  defaultCredits === null ? null : Math.ceil(defaultCredits / DEFAULT_CREDITS_PER_USD);
```

`DEFAULT_CREDITS_PER_USD = 100` (`credit-rates.defaults.ts:19`, `// FOUNDER-PENDING`), so
**`budgetLimit = 5` (USD, an Int)** on every non-Enterprise hire. `budget-limit.e2e-spec.ts:48` pins
this: `expect(emp.body.budgetLimit).toBe(5)`. `assertBudgetWithinPlan`
(`employees.service.ts:553-565`) refuses `null` or anything above `maxUsd`, so a customer cannot
self-serve unlimited. Note the mixed denomination: the column is USD, the plan speaks credits, and the
two enforcement paths read it differently — `assertUnderBudget` compares it to USD
(`agent-runtime.service.ts:889`), `CreditLimitsService` re-multiplies by 100 back to credits
(`credit-limits.service.ts:134`). Both are self-consistent; the coexistence is worth stating in the plan.

**Aggregate check:** 4 BUSINESS seats × 500 = 2,000 credits = exactly `includedCreditsPerMonth`. So
per-employee ceilings and the company allowance are coherent by design, and `billing.plans.spec.ts:59`
guards the margin (`includedCreditsPerMonth <= priceInCredits * 0.5`).

**Who performs the monthly renewal — two independent writers, NEITHER flag-gated:**

1. `SubscriptionCreditRenewalService.grantDuePeriods()`
   (`subscription-credit-renewal.service.ts:34-94`) — the `subscription-credit-renewal` sweep. Filters
   `provider:'mock', status:'ACTIVE', currentPeriodEnd <= asOf` (`:35-38`), advances the period first
   (`:51-55`), then grants `includedCreditsPerMonth` with `idempotencyKey =
   alloc:{companyId}:{newPeriodEnd}` + a `CreditLot` expiring at period end (`:57-82`).
   `if (!included) return` at `:59` → STARTER/ENTERPRISE no-op.
2. `BillingService.applySubscriptionRenewal` (`billing.service.ts:384-438`) — the Stripe
   `invoice.payment_succeeded` path, same idempotency key (`:424`), same `if (!included) return`
   (`:413-415`). The provider filters `subscription_create` before this is reached
   (`billing.provider.ts:141`, `stripe-billing.provider.ts:189`) → **first period is never granted**.

Both are wired: HTTP `POST /admin/cron/subscription-credit-renewal` (`cron.controller.ts:95`, delegated)
→ `platform-sweeps.service.ts:70-73`, and a BullMQ driver in `platform-sweeps.constants.ts:76`.
🟡 **UNDETERMINED:** whether either driver actually fires in the current production deployment.
CLAUDE.md records "Hobby-plan crons parked" and "worker deploy is the only thing left", and
`platform-sweeps.constants.ts:26` names this exact job as the one where "PAYING customers never receive
their credits". This must be verified against the live deployment before any rollout — it is a
prerequisite, not a detail.

### 2.3 Every hard-fail combination `scripts/preflight-env.mjs` already enforces

Flags read at `:241-244`. Production **WARN**s (not blocking) at `:246-264`:
`!ledgerOn` (`:247-252`, the "All AI work is free and unmetered" line), `ledgerOn && !enforcementOn`
(`:253-258`), `!paygOn` (`:259-263`).

Three **hard failures** (`errors.push` → non-zero exit), which any rollout must satisfy:

| Line | Condition | Message gist |
|---|---|---|
| `:269-275` | `enforcementOn && !ledgerOn` | "nothing to enforce against… Enable the ledger first." Applies in **all** environments |
| `:279-284` | `paygOn && !ledgerOn` | "customers could buy credits that are never consumed" |
| `:288-293` | `isProduction && grantsOn && !mailEnabled` | Mirrors the runtime `require-mail-enabled.ts` boot guard, which already refuses to boot |

So the **only** valid production flag set for enforcement is
`CREDIT_LEDGER_ENABLED=true` + `CREDIT_ENFORCEMENT_ENABLED=true` + `MAIL_ENABLED=true` (required as
soon as `CREDIT_GRANTS_ENABLED=true`), with `CREDIT_PAYG_ENABLED=true` strongly implied by the `:259`
warning — enforcing a limit with no way to buy more is a support incident by construction.

🟡 **None of the four `CREDIT_*` keys, nor `FREE_GRANT_*`, nor `COMPANY_MAX_CONCURRENT_EXECUTIONS`,
appears in `apps/api/.env.example`, `turbo.json`'s `globalEnv` (which lists only 9 keys,
`turbo.json:3-13`), `apps/api/vercel.json`, or `.github/workflows/api-ci.yml`.** They exist only in
code, tests and `preflight-env.mjs`. Any rollout must add them to `.env.example` (documentation) — and
remember CLAUDE.md's turbo gotcha: `FOO=bar pnpm dev` from the repo root is silently dropped.

### 2.4 Can `creditEnforcementEnabledAt` be set through an endpoint? Yes — one, platform-admin only

**`PATCH /internal/platform-admin/companies/:companyId/credit-enforcement`** —
`EnforcementCohortController.set` (`enforcement-cohort.controller.ts:19-55`).

- **Guard:** `@UseGuards(PlatformAdminGuard)` at `:20` — a separate JWT-secret identity axis
  (`PlatformOperator` table, `platform-admin.guard.ts:46`), not a tenant role.
- **Body:** `SetCreditEnforcementDto { enabled: boolean }` (`dto/set-credit-enforcement.dto.ts:5`).
- **Effect:** `creditEnforcementEnabledAt: dto.enabled ? new Date() : null` (`:37`) + an audit row
  with `actorType: 'PLATFORM_OPERATOR'` (`:41-48`).
- **No UI** — grep of `apps/web/src` for `credit-enforcement` returns nothing (consistent with
  cluster 06's "no operator UI"); curl-only. Tested by `credits-phase12.e2e-spec.ts:84-104`.

**Nothing sets it automatically at signup.** The only other writers are three test files
(`credits-phase8.e2e-spec.ts:63`, `credits-gap-fixes.e2e-spec.ts:80`) writing via raw Prisma.

---

## 3. Existing safety nets, precisely

### 3.1 `CompanyConcurrencyGuardService` — `apps/api/src/modules/credits/company-concurrency-guard.service.ts`

- **Cap constant:** `DEFAULT_MAX_CONCURRENT_EXECUTIONS = 10` (`:12`, `// FOUNDER-PENDING`), overridable
  by **`COMPANY_MAX_CONCURRENT_EXECUTIONS`** read via `ConfigService` in the constructor (`:40-42`),
  validated `Number.isFinite(raw) && raw > 0`. 🔴 Because it is a **`ConfigService` read in a
  constructor**, this key IS subject to CLAUDE.md's import-time-snapshot gotcha — it must be set in
  `test/setup-e2e-env.ts`, never in a spec's `beforeAll`.
- **Keying:** `vaep:concurrency:company:${companyId}` (`:44-46`) — strictly per-company, never global.
- **Redis path:** `INCR` → `EXPIRE` → if `count > maxConcurrent`, `DECR` and return `false` (`:51-60`).
  The rejected attempt is explicitly not counted.
- **In-memory fallback:** a plain `Map<string, number>` (`:33`) used when `redis` is null (the provider
  is `@Optional()`, `:37`) **or on any Redis throw** (`:61-67`, logged at `debug`).
  🔴 The fallback is **per-process**, so on a multi-instance deployment with Redis down the effective
  cap becomes 10 × instances, silently.
- **TTL self-healing:** `COUNTER_TTL_SECONDS = 300` (`:15`) re-applied on every `tryAcquire`, so a
  crashed process that never calls `release()` cannot lock a company out for more than 5 min.
  `release` also floors the counter at 0 (`:81`, `:92`).
- **Exactly three call sites**, each acquiring before any spend and releasing in a `finally`:

| # | Call site | Rejection shape |
|---|---|---|
| 1 | `agent-runtime.service.ts:141-150` | `ConflictException('Too many requests are already in flight…')` — before the user turn is persisted |
| 2 | `ai-step.handler.ts:67-76` | plain `Error` (goes through `RetryPolicyService`) |
| 3 | `skills.service.ts:638-652` | `{ ok: false, error: 'Too many requests…' }` — matching `runTool`'s never-throws contract |

Each call site's comment states it is "Independent of the credit-enforcement flag hierarchy". Unit
coverage: `company-concurrency-guard.service.spec.ts` (4 tests: N+1 rejected, release frees a slot,
per-company isolation, never below zero).

### 3.2 The always-on spend ceiling the prior audit missed

**`AgentRuntimeService.assertUnderBudget`** (`agent-runtime.service.ts:880-895`):

```ts
if (employee.budgetLimit == null) return;
const spent = await this.usage.totalCostForEmployee(
  employee.companyId, employee.id, startOfCurrentMonthUtc());
if (spent >= employee.budgetLimit) throw new ConflictException(
  `${employee.name} has reached its monthly budget limit — raise the limit or wait for next month…`);
```

- **No flag anywhere in this path.** `UsageService.record` is unconditional
  (`usage.service.ts:56-101`) and `totalCostForEmployee` aggregates `UsageEvent.estimatedCostUsd`
  since the start of the UTC calendar month (`:124-134`).
- Called at `agent-runtime.service.ts:172` (before the turn is persisted) **and re-checked at `:509`
  at the top of every ACT-loop iteration after the first**.
- **Duplicated, flag-free, in `ai-step.handler.ts:106-117`** for `AI_STEP` (same message text).
- Reaches `AI_EMPLOYEE_STEP` too, because that handler delegates the whole turn to
  `AgentRuntimeService.run` (`ai-employee-step.handler.ts:124-137`).
- Weakness the code itself names: it is a **SUM-then-compare race**
  (`credit-limits.service.ts:81-82` calls it out explicitly), so two concurrent turns can both pass.
  Bounded in practice by the 10-concurrency cap.
- Proven live by `budget-limit.e2e-spec.ts` (3 tests) with **all credit flags off**.

**Effective always-on ceiling today: ≈ $5/employee/month for chat + `AI_STEP` + `AI_EMPLOYEE_STEP`**
(2 seats on Free/Starter → ~$10/month; 4 on Growth → ~$20/month; **unlimited on Enterprise**, where
`creditsPerEmployeeFor` is `null` → `budgetLimit` null → `assertUnderBudget` returns immediately).
Migration `20260904120000` backfilled existing employees' `budgetLimit`, so this applies to existing
tenants too — but any employee hired **before** that whose `budgetLimit` was left `null`, or any
`ENTERPRISE` tenant, is uncapped.

### 3.3 Exhaustive exists / does-not-exist table

| Control | Verdict | Evidence |
|---|---|---|
| Per-company in-flight execution cap | **EXISTS** — 10, configurable | `company-concurrency-guard.service.ts:12,40-42`; 3 call sites (§3.1) |
| Per-employee monthly USD spend ceiling, flag-independent | **EXISTS** — $5 default | `agent-runtime.service.ts:880-895`, `:172`, `:509`; `ai-step.handler.ts:106-117`; stamped `employees.service.ts:114-131` |
| Per-**node** wall-clock timeout | **EXISTS** — 30 s default, `WORKFLOW_NODE_TIMEOUT_MS` | `workflow-runtime.constants.ts:67-86`; `AbortController` at `node-attempt.processor.ts:51`; `signal` threaded into `llm.complete` (`ai-step.handler.ts:245`) and the chat turn (`ai-employee-step.handler.ts:136`) |
| Per-**run** wall-clock/duration limit | **PARTIAL, legacy engine only, and it is a sweep not a limit** | `workflow-engine.service.ts:281-333` fails PENDING/RUNNING runs older than `WORKFLOW_RUN_STUCK_TIMEOUT_MS = 10 min` (`workflows.constants.ts:33`) — but it **explicitly excludes durable-engine runs** (`:296` `attempts: { none: {} }`, `:316-318` engine-mode filter), where `ReaperService` *recovers* rather than kills. It also only runs when the `workflow-watchdog` cron fires. **There is no in-band per-run deadline in either engine.** |
| Max nodes / steps per run | **EXISTS in both engines** — 50 | Legacy: `MAX_WORKFLOW_NODES = 50` (`workflows.constants.ts:123-127`), enforced `workflow-engine.service.ts:924-929` with a **shared** budget across nested loops (`:893-905`). Durable: `MAX_STEPS_PER_RUN = 50` (`run-advance.processor.ts:524`), enforced `:274-288` → `FAILED` / `failureClass: 'BUDGET_EXCEEDED'` |
| Max loop iterations | **EXISTS** — mandatory, no default | `LOOP` requires a positive `maxIterations` at validation (`definition-validator.ts:346-352`) and at execution (`logic.handlers.ts:160-171`); over-long item arrays are truncated with a warning (`:187-201`) |
| Max tool-calls per turn / step | **EXISTS** — 3 (chat ACT loop `MAX_ACT_ITERATIONS`); `AI_EMPLOYEE_STEP` caps config at 10 but only **warns** after the fact (`ai-employee-step.handler.ts:139-148,215-220`) |
| Max graph size at author time | **EXISTS** — 50 nodes | `definition-validator.ts:138-142` |
| `WAIT` node upper bound | **EXISTS** — 10 s | `MAX_WAIT_MS` (`workflows.constants.ts:133`) |
| Minimum SCHEDULE interval | **EXISTS** — 15 s | `MIN_SCHEDULE_MS` (`workflows.constants.ts:85`), used in `scheduleSlotKey` (`:111-121`) |
| Per-company HTTP rate limit | **EXISTS** — 300 req / 60 s | `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])` (`app.module.ts:53`), keyed per company by `TenantAwareThrottlerGuard.getTracker` (`tenant-throttler.guard.ts:91-100`) with **verified** JWT signature. Tighter overrides: `POST /workflows/generate` 10/min (`workflows.controller.ts:166`), `POST /billing/credits/purchase` 10/min (`billing.controller.ts:91`), `POST /assist/sessions/:id/turns` 20 per 5 min (`assist.controller.ts:102,123`). 🔴 **`POST /workflows/:id/run` and `POST /conversations/:id/messages` have no override** — they get the generous 300/min |
| Per-company **daily or monthly** token/cost ceiling, independent of credit flags | **DOES NOT EXIST** | Grep for `runsPerMonth\|dailyLimit\|monthlyLimit\|costCeiling\|spendCap\|tokenCeiling\|maxTokensPerDay` across `apps/api/src` → **zero matches**. `UsageService` has `totalsForCompany` (`usage.service.ts:104-121`) but **no caller compares it to any limit** |
| Plan-level runs-per-month limit | **DOES NOT EXIST** | `PlanDto` (`billing.plans.ts:34-112`) has no run/usage field at all — only seats, roles, per-employee credits, monthly credits |
| Per-run credit cap actually in force | **DOES NOT EXIST in practice** | See §4 |
| Per-company in-flight **attempt** cap | **DECLARED BUT DEAD** | `MAX_INFLIGHT_ATTEMPTS_PER_COMPANY = 50` (`workflow-runtime.constants.ts:93-94`) — repo-wide grep finds **no reader**. A documented doc-16 §14 fairness control that does nothing |
| `TOOL_ACTION` flag-independent budget check | **DOES NOT EXIST** | `skills.service.ts:655-850` has the concurrency guard but no `assertUnderBudget` equivalent — the only spend path of the three without one |
| AI Assist metering/enforcement | **DOES NOT EXIST** — confirms cluster 10 §A.6 | Grep of `modules/assist/` for `CreditReservation\|CreditLimits\|creditLedgerEnabled\|ConcurrencyGuard` → **zero matches**. Only `usage.record` (`assist-agent.service.ts:353`). No concurrency guard either |
| `POST /workflows/generate` metering/enforcement | **DOES NOT EXIST — new finding, not in cluster 10** | `workflow-generator.service.ts` imports only `UsageService` (`:18,68,96-101`); no credit service, **no concurrency guard**. Bounded only by `GENERATION_MAX_ATTEMPTS` / `GENERATION_MAX_QUESTION_ROUNDS` and the 10/min throttle |

---

## 4. The per-run credit limit — `WorkflowRun.creditLimit`

**Prior finding confirmed on the read side, refuted on the write side.**

- Schema: `creditLimit Decimal? @db.Decimal(18,6)` (`schema.prisma:1043`), no default, nullable.
  Comment `:1038-1042` calls it "the per-run rollup + override ceiling… inert until then".
- Enforced per node by `CreditLimitsService.checkAndReserveWorkflowLimit`
  (`credit-limits.service.ts:183-207`): `if (run.creditLimit == null) return` at `:192`, else a guarded
  `updateMany` on `totalCreditsCharged: { lte: limit - cost }` → `WorkflowLimitExceededError`.
  Called from all three spend paths (`agent-runtime.service.ts:449`, `ai-step.handler.ts:177`,
  `skills.service.ts:790`) — but **only inside `if (enforcementActive)`**.
- 🔴 **Who sets it at run creation: nobody.** `WorkflowsService.enqueueRun`'s
  `prisma.workflowRun.create({ data: {…} })` (`workflows.service.ts:1012-1040`) never mentions
  `creditLimit`. A repo-wide grep for `creditLimit` across all `.ts` returns: the Prisma schema, the
  read in `credit-limits.service.ts:190-195`, the read in `credit-reconciliation.service.ts:202,223`,
  the anti-double-bill `where` in `credit-reservation.service.ts:375`, the mapper
  (`workflows.mapper.ts:129`), the DTO/zod (`packages/types/src/index.ts:2161`,
  `response-schemas.ts:329`), the display-only frontend branch (`RunCreditPanel.tsx:20-21`), and
  **four test files that set it via raw Prisma**. **No endpoint, no DTO field, no UI input, no
  default.** So `creditLimit` is `null` on 100 % of production runs, Layer 3 never fires, and
  `RunCreditPanel`'s "/ N limit" text can never render.
- **Could it become the vehicle for a flag-independent ceiling? Yes, with two caveats:**
  1. The `checkAndReserveWorkflowLimit` call sites are all inside `if (enforcementActive)`, so the
     check would have to be hoisted out of the flag gate (or a second, unconditional call added).
  2. 🔴 **Setting it non-null changes existing accounting.** `rollUpSpendOntoRun` deliberately skips
     capped runs — `where: { id, creditLimit: null }` (`credit-reservation.service.ts:374-377`,
     rationale at `:331-339`). So the moment every run has a `creditLimit`, `totalCreditsCharged`
     silently switches from the **settled actual** figure to the **reserved** (conservative,
     over-stated) figure, which is what the customer's `RunCreditPanel` displays. That is a real,
     user-visible change and must be a deliberate decision, not a side effect.

---

## 5. Recommendation

### **(c) Both — but strictly in this order: (b) first, then (a) behind it.**

**Why (b) must come first.** Option (a)'s prerequisites are not all code. Enforcement is only real if
`subscription-credit-renewal` actually runs in production (§2.2 — currently 🟡 undetermined, and
CLAUDE.md says crons are parked), and PAYG must be on or a blocked customer has no way out
(preflight `:259-263`). Those are deployment decisions with a lead time. Option (b) needs no cron, no
Stripe, no grant, no balance, and no founder pricing decision — it is pure code with safe defaults, and
it is what actually bounds the exposure while (a) is being sequenced.

**Why (a) is still needed.** (b) bounds *volume*; it does not create *revenue*, and it does not fix the
fact that `/billing/usage` is permanently empty. Only (a) does that.

**Why not (a) alone.** Beyond the sequencing above: (a) grandfathers existing tenants by design, so the
largest cohort — including the biggest spenders — stays on today's uncapped `TOOL_ACTION`/Assist/
generator paths (§3.3) indefinitely. (b) is the only option that covers them.

**Why not (b) alone.** It leaves the shipped default as "no revenue", which preflight itself calls a
revenue outage, and leaves 14 built credit tables dormant.

### 5.1 Option (b) — files to change and exact new config keys

**New config keys (safe defaults = today's behaviour where possible):**

| Key | Default | Semantics | Read via |
|---|---|---|---|
| `COMPANY_MAX_CONCURRENT_EXECUTIONS` | `10` (**exists already**) | Just document it in `.env.example`; no code change | ConfigService (already) |
| `WORKFLOW_RUN_MAX_DURATION_MS` | `600000` (10 min — matches `WORKFLOW_RUN_STUCK_TIMEOUT_MS`, so the default is behaviour-neutral for legacy and *adds* the bound to durable) | In-band per-run deadline, checked on every advance | **raw `process.env`, per call** — copy `nodeTimeoutMs()`'s pattern (`workflow-runtime.constants.ts:83-86`), so tests can set it in `beforeAll` |
| `COMPANY_MONTHLY_COST_CEILING_USD` | `0` = **disabled** (behaviour-neutral until deliberately set) | Per-company rolling monthly USD ceiling from `UsageEvent`, independent of every credit flag | raw `process.env`, per call |
| `COMPANY_DAILY_COST_CEILING_USD` | `0` = disabled | Same, per UTC day — catches a runaway inside one day rather than at month end | raw `process.env`, per call |

**Files that must change (option b):**

| File | Change |
|---|---|
| `apps/api/src/common/config/credit-config.ts` **or** a new `apps/api/src/common/config/safety-limits.ts` | The three new getters. **Recommend a new file** — these are deliberately *not* credit flags, and putting them in `credit-config.ts` invites exactly the "it's off because credits are off" confusion this whole exercise is about |
| `apps/api/src/modules/credits/company-spend-guard.service.ts` (**new**) | `assertUnderCompanyCeiling(companyId)` — reuses `UsageService.totalsForCompany` (`usage.service.ts:104-121`, already exists, currently has no caller) for month-to-date and a new day-to-date variant. Returns immediately when both ceilings are `0` (zero DB cost when disabled). **Put it in `CreditsModule`** next to the concurrency guard, which is already imported by all three spend paths — no new module edges, no cycle risk |
| `apps/api/src/modules/usage/usage.service.ts` | Add `totalCostForCompany(companyId, sinceDate)` (a 6-line aggregate mirroring `totalCostForEmployee`, `:124-134`). Requires a `[companyId, createdAt]` index on `UsageEvent` — **verify it exists before adding the caller**; the codebase has a documented history of a missing index on a hot polled table (`WorkflowStepRun.runId`) |
| `apps/api/src/modules/employees/runtime/agent-runtime.service.ts` | Call the company guard immediately after `concurrencyGuard.tryAcquire` (`:141`) and beside the existing `assertUnderBudget` re-check (`:509`) |
| `apps/api/src/modules/workflows/engine/nodes/ai-step.handler.ts` | Same, next to `:106-117` |
| `apps/api/src/modules/skills/skills.service.ts` | Same, in `runToolWithinConcurrencyLimit` — **and this closes the §3.3 gap that `TOOL_ACTION` has no budget check at all**. Must return `{ ok: false, error }`, never throw (`runTool`'s contract, `:624-626`) |
| `apps/api/src/modules/assist/agent/assist-agent.service.ts` | Add the concurrency guard **and** the company guard. Currently has neither |
| `apps/api/src/modules/workflows/engine/workflow-generator.service.ts` | Same |
| `apps/api/src/modules/workflow-runtime/run-advance.processor.ts` | Enforce `WORKFLOW_RUN_MAX_DURATION_MS` next to the existing `MAX_STEPS_PER_RUN` check (`:274-288`) — same `transitionRun` → `FAILED` shape, reuse `failureClass: 'BUDGET_EXCEEDED'` so `RetryPolicyService` already classifies it non-retryable |
| `apps/api/src/modules/workflows/engine/workflow-engine.service.ts` | The legacy-engine equivalent, next to the `MAX_WORKFLOW_NODES` check (`:924-929`) — the two engines must agree or one run in two proves nothing (CLAUDE.md's both-modes rule) |
| `apps/api/src/modules/workflow-runtime/workflow-runtime.constants.ts` | Either wire `MAX_INFLIGHT_ATTEMPTS_PER_COMPANY` (`:93-94`) up, or delete it. A declared cap with no reader is the "silent-success" defect class this repo's own convention treats as a bug |
| `apps/api/.env.example` | Document the three new keys **plus** the four `CREDIT_*` flags, `FREE_GRANT_*` and `COMPANY_MAX_CONCURRENT_EXECUTIONS`, all currently absent (§2.3) |
| `scripts/preflight-env.mjs` | A production WARN when both cost ceilings are `0` **and** `CREDIT_ENFORCEMENT_ENABLED` is not `true` — i.e. "nothing anywhere bounds cumulative spend". This is the honest counterpart to the existing `:247-252` warning |
| `apps/api/test/setup-e2e-env.ts` | **Only** if a test needs `COMPANY_MAX_CONCURRENT_EXECUTIONS` (ConfigService, import-time). The three new raw-`process.env` keys must **not** go here — defaulting them here would repeat the `SKILL_EXECUTOR` mistake documented at `setup-e2e-env.ts:89-100` |

**Exact failure mode a customer sees when they hit the ceiling:**

- Chat: **HTTP 409** with `"Your company has reached its monthly AI spend limit — …"`. Thrown *before*
  the user turn is persisted (matching the concurrency guard's placement at
  `agent-runtime.service.ts:141-145`), so no orphan message is left in the thread.
- `AI_STEP` / `AI_EMPLOYEE_STEP`: the run goes **`FAILED`** with that message on
  `WorkflowRun.error` and rendered by `RunFailureCard`. Must be classified non-retryable, or
  `RetryPolicyService` will retry into the same wall 3 times.
- `TOOL_ACTION`: `{ ok: false, error }` → the run fails with the message (per
  `tool-action.handler.ts`'s `!ok` wrap), and the tool call is visible in the run timeline.
- Run-duration: **`FAILED`**, `"Exceeded the maximum run duration (Nm)"`,
  `failureClass: 'BUDGET_EXCEEDED'`. Already-completed steps' side effects **stay done** — there is no
  compensation in this system (`workflow-runtime.constants.ts:44-56` is explicit), so the message must
  not imply a rollback.
- 🔴 **Required in all four cases:** name the ceiling and who can raise it. A bare "limit reached" with
  no self-serve path and no operator surface is the exact failure the `credit-enforcement` endpoint
  already has (no UI, §2.4). At minimum the message must say "ask your Orlixa contact to raise it".

### 5.2 Option (a) — files to change

| File | Change |
|---|---|
| `apps/api/src/modules/auth/auth.service.ts` | Stamp `creditEnforcementEnabledAt` in the register transaction (`:95-120`). 🔴 **Do NOT do this without §5.3 step 3 first** — see the retry-gate trap below |
| `apps/api/src/modules/onboarding/onboarding.service.ts` | The grant at `:408-410` must become **unconditional for newly-created companies** (or gated on the company's own stamp rather than the global `CREDIT_GRANTS_ENABLED`), or a stamped company with zero balance is bricked. Also: move the grant so it is reachable for a company that never finishes the wizard, or accept that such companies must not be stamped |
| `apps/api/src/common/config/credit-config.ts` | A new `creditEnforcementForNewCompanies()` getter (`CREDIT_ENFORCE_NEW_COMPANIES`, default `false`) so the stamping itself is revertible without a code deploy |
| `apps/api/src/modules/billing/platform-admin/enforcement-cohort.controller.ts` | No change needed (already the revert path) — but a `GET` to *list* the cohort would make the rollout observable. Currently there is no way to ask "who is enrolled?" over HTTP |
| `apps/web` | 🔴 **A balance/ceiling surface is a hard prerequisite, not a nice-to-have.** `GET /billing/credits` exists (`billing.controller.ts:67`) and `/billing/usage` renders the ledger, but per cluster 10 §A.5 there is **no messaging distinguishing "credits off" from "you've spent nothing"**. Enforcing a limit a customer cannot see is a support incident |

### 5.3 How each option could break existing tenants or the e2e suite

**Option (b) — low risk, three specific traps:**

1. **Behaviour-neutral defaults are essential.** `COMPANY_*_COST_CEILING_USD` defaulting to `0`
   (disabled) means the e2e suite, all 745 tests, and every existing tenant are untouched until an
   operator opts in. If instead a non-zero default shipped, the fixtures that hire many employees and
   run many turns (`employees-seats.e2e-spec.ts`, the golden-journey browser tests) would start
   failing on cumulative spend — and CLAUDE.md already records that such fixtures had to be lifted to
   `ENTERPRISE`. **Do not default these on.**
2. **`WORKFLOW_RUN_MAX_DURATION_MS` is the one that can break existing tenants.** Defaulting to
   600 000 ms matches what the legacy watchdog already does, so legacy behaviour is unchanged — but it
   *adds* a bound to durable runs that currently have none, and a durable run with a long `WAIT`, a
   slow provider, or a retry with `RETRY_CAP_MS = 300_000` backoff (`workflow-runtime.constants.ts:90`)
   can legitimately exceed 10 minutes. 🔴 **The deadline must exclude time spent in `WAITING`
   (approval) and `RETRYING`**, or a run legitimately parked on a human approval will be killed. This
   is the single highest-risk detail in option (b).
3. **The company-ceiling read is a new query on every spend call.** Guard it with a
   "both ceilings are 0 → return immediately" fast path *before* any DB access, and confirm the
   `UsageEvent` index. Otherwise the offline suite (which runs thousands of mock LLM calls) pays for it.

**Option (a) — high risk, five specific traps:**

1. 🔴 **The `retryRun` gate ignores the global flag.** `workflows.service.ts:910-933` keys off
   `creditEnforcementEnabledAt != null` **alone**. Stamping the column at signup therefore makes
   "Retry" return a **409** for every billable workflow run on the legacy engine, immediately, before
   any credit flag is on. Mitigation: either add `creditEnforcementEnabled() &&` to that condition, or
   confirm `WORKFLOW_ENGINE_MODE` puts all new companies on `state_machine` — and note
   `GET /admin/runtime` exists precisely because `WORKFLOW_EXECUTION_MODE=inline` **silently forces
   `legacy_walk`** (CLAUDE.md). On a Vercel-only deploy, inline is the mode, so `engineMode` would be
   `legacy_walk` for **every** run and this gate would fire universally.
2. 🔴 **Grant-before-stamp ordering.** If a company is stamped and the grant path is skipped for any of
   `grantFreeSignupCredits`'s three silent-`0` reasons (no owner email, disposable domain, domain
   velocity cap — `onboarding.service.ts:468-484`), that company is **bricked at zero balance with
   enforcement on**. The velocity cap (3/domain/24h) will hit real design partners onboarding several
   test tenants from one company domain. Mitigation: stamp only *after* a confirmed non-zero grant, in
   the same transaction.
3. **`MAIL_ENABLED=true` becomes mandatory.** `preflight-env.mjs:288-293` plus the runtime
   `require-mail-enabled.ts` guard mean `CREDIT_GRANTS_ENABLED=true` in production **refuses to boot**
   without mail. That is a genuine deploy-order dependency.
4. **e2e blast radius.** `credits-phase3/4/8/10/12` and `credits-gap-fixes` all assume the flags are
   **off** at module init and turn them on per-test. They set `creditEnforcementEnabledAt` via raw
   Prisma on companies created through `POST /auth/register`. If register starts stamping it
   automatically, `credits-phase8.e2e-spec.ts:101-113`'s "enforcement-OFF regression guard" test
   **inverts and fails**, and `credits-phase12.e2e-spec.ts:84` (`expect(before?.creditEnforcementEnabledAt).toBeNull()`)
   fails outright. Mitigation: gate the stamping behind `CREDIT_ENFORCE_NEW_COMPANIES`, default
   `false`, and let those two suites keep the default.
5. **Do not assert global counts.** CLAUDE.md records `credits-phase2` failing ~1 run in 3 for exactly
   this reason, and `cross-tenant-sweeps-in-tests` records 44 tenants with real retention policies in
   the shared dev DB. Every new test must scope by `companyId` and clean up per-company in `afterAll`,
   as `credits-phase3.e2e-spec.ts:112-128` does (Convention-B tables first, then `company.deleteMany`),
   and must **never** call a cross-tenant sweep — including `SubscriptionCreditRenewalService.grantDuePeriods()`,
   which has no `companyId` filter (`subscription-credit-renewal.service.ts:35-38`) and would grant
   credits to every due mock subscription in the dev DB.

---

## 6. Test inventory

### 6.1 e2e (`apps/api/test/`) — all gated `describeIfDb = process.env.DATABASE_URL ? describe : describe.skip`

| File | What it asserts | Breaks under (a)? | Breaks under (b)? |
|---|---|---|---|
| `budget-limit.e2e-spec.ts` (144 ln, 3 tests) | The **flag-independent** ceiling: new employee `budgetLimit === 5` (`:48`), `monthToDateCostUsd > 0` after one message (`:78`), `PATCH budgetLimit: 999999` → **400** (`:93`), `budgetLimit: 0` → next message **409 "budget limit"** (`:116-117`), a fresh employee with an unspent limit can chat | No | Only if a company ceiling defaults on |
| `credits-phase2.e2e-spec.ts` | Ledger append / balance math / idempotency. Historically flaky from a global count against a cross-tenant sweep; fixed 2026-09-03 | No | No |
| `credits-phase3.e2e-spec.ts` (16 flag toggles) | Shadow-mode wiring at all three call sites: **flag OFF → zero `CreditReservation` rows, "byte-identical to pre-Phase-3"** (`:140-149`); flag ON → reserve+settle from real usage | No | No |
| `credits-phase4.e2e-spec.ts` (203 ln) | Grants: **flag OFF → onboarding grants nothing** (`:84-91`); ON → exactly one `FREE_SIGNUP` visible at `GET /billing/credits`; double-complete grants once; disposable domain and domain-velocity cap each complete onboarding with **no** grant; Task 4.5 approval-gate expansion for credit-only companies | 🔴 **Yes** if the grant becomes unconditional — `:84-91` inverts | No |
| `credits-phase5.e2e-spec.ts` | PAYG: flag off → `{checkoutUrl: null}` | No | No |
| `credits-phase6.e2e-spec.ts` | Stripe webhook dedup (`ProcessedWebhookEvent`) | No | No |
| `credits-phase7.e2e-spec.ts` | Plan-allotment renewal + `alloc:` idempotency (both paths) | No | No |
| `credits-phase8.e2e-spec.ts` (Layers 1–3) | **The enforcement-OFF regression guard** (`:102-112`: not-enrolled company at zero balance is never blocked); Layer 1 blocks chat/`AI_STEP`/`TOOL_ACTION` with distinct messages; Layer 2 `maxCreditsPerExecution` (`:199`) + concurrent double-spend (`:210-211`); Layer 3 `creditLimit: null` never blocks (`:221-230`); **a LOOP against `creditLimit: 100` stops exactly at the cap** (`:234-247`); Task 8.4 legacy retry gate | 🔴 **Yes** — `:102-112` and the raw-Prisma enrolment assume register leaves the column null | No |
| `credits-phase9-backend.e2e-spec.ts` | Customer-facing credit endpoints | No | No |
| `credits-phase10.e2e-spec.ts` / `-abuse` / `-reconciliation` / `-rollup` | Sweeps, abuse controls, reconciliation legs, finance rollup | No | No |
| `credits-phase12.e2e-spec.ts` | The canary endpoint: `expect(before?.creditEnforcementEnabledAt).toBeNull()` (`:84`) → enroll → **not null** (`:91,94`) → revert → **null** (`:101,104`) | 🔴 **Yes** — `:84` fails immediately if register stamps | No |
| `credits-phase12-canary.e2e-spec.ts` (146 ln, 3 tests) | Canary reconciliation: an `INSUFFICIENT_CREDITS` block against a genuinely-zero balance has zero discrepancies; a block against a **positive** balance is flagged | No | No |
| `credits-gap-fixes.e2e-spec.ts` | Enrols via raw Prisma (`:80`); a tight `creditLimit` blocks a chat turn driven by **`AI_EMPLOYEE_STEP`**, not just `AI_STEP`/`TOOL_ACTION` (`:92-101`); flags a `WORKFLOW_LIMIT_EXCEEDED` block recorded against a **null** `creditLimit` as a discrepancy (`:141-161`) | Low | No |
| `employees-seats.e2e-spec.ts` | Role-based seat rules across all 3 hire paths | No | Only if ceilings default on |
| `billing.e2e-spec.ts` | Plans, default subscription, plan change, portal | No | No |
| `workflow-runtime-concurrency.e2e-spec.ts` (250 ln, 10 tests) | **Run-advance locking and attempt leases — NOT the company concurrency cap.** Per-run advisory lock (commit + rollback release), lease claim/expiry/steal/renew, idempotency-key stability | No | 🟡 Possibly — if a run-duration deadline interacts with lease expiry |

### 6.2 Unit (`apps/api/src/**/*.spec.ts`)

| File | What it asserts |
|---|---|
| `credits/company-concurrency-guard.service.spec.ts` (48 ln, 4 tests) | N+1 rejected while N run; release frees a slot; **per-company, never global**; release never goes below zero |
| `credits/credit-limits.service.spec.ts` | `budgetLimit: null` → unlimited (3 cases); `budgetLimit: 1` → "$1 → 100 credits at `DEFAULT_CREDITS_PER_USD`" (`:93`) — the unit-conversion pin |
| `credits/credit-reservation-sweep.service.spec.ts` | The leak sweep, excluding `workflowStepRunId IS NOT NULL` rows |
| `billing/billing.plans.spec.ts` | `maxEmployees === maxRoles × maxPerRole` for every plan; exact per-plan credit numbers (`:36,40,44`); **`includedCreditsPerMonth <= priceInCredits * 0.5`** margin guard (`:59`) |
| `billing/billing.service.spec.ts`, `billing/plan.guard.spec.ts` | Subscription lifecycle; plan gating |
| `common/resilience/tenant-throttler.guard.spec.ts` | Per-company throttle key derivation, including `alg: none` rejection |
| `admin/cron-schedule-coverage.spec.ts` | **Every cron job has a driver in BOTH the HTTP and BullMQ shapes** — names `subscription-credit-renewal` explicitly (`:18,124`). Any new sweep must satisfy this |

### 6.3 Representative snippet — how these tests toggle the flags (house style)

Because `credit-config.ts` reads raw `process.env` (not `ConfigService`), mutation in
`beforeAll`/`it` **does** take effect. Two patterns are in use:

```ts
// A) Whole-suite: credits-phase8.e2e-spec.ts:67-99
beforeAll(async () => {
  process.env.CREDIT_LEDGER_ENABLED = 'true';
  process.env.CREDIT_ENFORCEMENT_ENABLED = 'true';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
});
afterAll(async () => {
  delete process.env.CREDIT_LEDGER_ENABLED;
  delete process.env.CREDIT_ENFORCEMENT_ENABLED;
  // Per-company cleanup, "Convention B tables first (no cascade from Company)":
  await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.creditReservation.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.companyCreditBalance.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.employeeCreditPeriodCounter.deleteMany({ where: { companyId: { in: companyIds } } });
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } });   // cascades the rest
  await app?.close();
});

// B) Per-test: credits-phase3.e2e-spec.ts:141,152 and credits-phase4.e2e-spec.ts:85,93
it('flag OFF (default): a chat turn creates zero CreditReservation rows', async () => {
  delete process.env.CREDIT_LEDGER_ENABLED;
  /* … */
  const rows = await prisma.creditReservation.count({ where: { conversationId: conversation.id } });
  expect(rows).toBe(0);   // scoped by conversationId — never a global count
});

// Per-company enrolment (there is no public endpoint; phase 12's is platform-admin only):
await prisma.company.update({ where: { id: companyId }, data: { creditEnforcementEnabledAt: new Date() } });
```

Every assertion is scoped by `companyId`/`conversationId`/`runId` — never a global `count()`. New tests
must match this exactly (see §5.3 trap 5).

---

## What the implementation plan must do

**Phase 0 — verify, change nothing (half a day).**
1. Run `node scripts/preflight-env.mjs` against the real production env and record the four
   `CREDIT_*` values and `MAIL_ENABLED` as they actually are. Do not infer them from `.env.example` —
   none of them is in it (§2.3).
2. `GET /admin/runtime` on production: record whether `durableExecution` is true. If
   `WORKFLOW_EXECUTION_MODE=inline`, every run is `legacy_walk` and §5.3 trap 1 is live.
3. Determine whether `subscription-credit-renewal` has fired in production even once (audit rows /
   `CreditLedger` `grantKind: 'PLAN_ALLOTMENT'` count). 🟡 Currently undetermined and a hard
   prerequisite for option (a).
4. Confirm a `[companyId, createdAt]` index exists on `UsageEvent` before adding any company-wide
   aggregate to the hot path.

**Phase 1 — the flag-independent ceiling (option b). Ship this first; it is behaviour-neutral by default.**
5. New `apps/api/src/common/config/safety-limits.ts` with `workflowRunMaxDurationMs()` (default
   `600000`), `companyMonthlyCostCeilingUsd()` (default `0` = off), `companyDailyCostCeilingUsd()`
   (default `0` = off) — all raw `process.env`, read per call, copying `nodeTimeoutMs()`'s pattern
   verbatim (`workflow-runtime.constants.ts:83-86`) and its "never capture at import" comment.
6. Add `UsageService.totalCostForCompany` (mirror `:124-134`).
7. New `CompanySpendGuardService` in `CreditsModule` with a zero-DB-cost fast path when both
   ceilings are `0`.
8. Wire it at the three existing choke points (`agent-runtime.service.ts:141`/`:509`,
   `ai-step.handler.ts:106`, `skills.service.ts` in `runToolWithinConcurrencyLimit`) **plus the two
   that have nothing today**: `assist-agent.service.ts` and `workflow-generator.service.ts` — those
   two also need `CompanyConcurrencyGuardService`, which they currently lack entirely.
9. Enforce `WORKFLOW_RUN_MAX_DURATION_MS` in **both** engines (`run-advance.processor.ts:274-288`
   and `workflow-engine.service.ts:924-929`), **excluding time in `WAITING` and `RETRYING`**
   (§5.3 trap 2 — this is the detail most likely to break a real tenant).
10. Resolve `MAX_INFLIGHT_ATTEMPTS_PER_COMPANY` (`workflow-runtime.constants.ts:93-94`): wire it or
    delete it. Do not leave a declared cap with no reader.
11. Document all of `CREDIT_LEDGER_ENABLED`, `CREDIT_GRANTS_ENABLED`, `CREDIT_PAYG_ENABLED`,
    `CREDIT_ENFORCEMENT_ENABLED`, `FREE_GRANT_CREDITS`, `FREE_GRANT_EXPIRY_DAYS`,
    `FREE_GRANT_DOMAIN_CAP`, `COMPANY_MAX_CONCURRENT_EXECUTIONS` and the three new keys in
    `apps/api/.env.example`.
12. Add the preflight WARN for "no cumulative-spend bound anywhere"
    (`scripts/preflight-env.mjs`, beside `:247-252`).
13. Tests, in house style (§6.3): unit tests for the three getters and the spend guard; e2e that sets
    a tiny `COMPANY_DAILY_COST_CEILING_USD` in `beforeAll`, proves 409 / `ok:false` / run-`FAILED` at
    each of the five entry points, and proves the **default-off** case leaves behaviour unchanged.
    Then **one** verification pass — CLAUDE.md's "implement fully, then typecheck", and run e2e in
    **both** engine modes.

**Phase 2 — enforcement for new tenants (option a). Only after Phase 0 item 3 is green.**
14. Fix `workflows.service.ts:910-933` to require `creditEnforcementEnabled() &&`, or accept and
    document that stamping alone blocks legacy retries.
15. Make the grant reachable and unconditional for a stamped company, and **stamp only inside the same
    transaction as a confirmed non-zero grant** (§5.3 trap 2). Add
    `CREDIT_ENFORCE_NEW_COMPANIES=false` as the kill switch so no existing test's default changes.
16. Set the production flags in the only order preflight permits: `MAIL_ENABLED=true` →
    `CREDIT_LEDGER_ENABLED=true` (ledger-only shadow mode; watch a full week) →
    `CREDIT_PAYG_ENABLED=true` → `CREDIT_ENFORCEMENT_ENABLED=true` with **zero** companies stamped →
    stamp one internal throwaway tenant via `PATCH /internal/platform-admin/companies/:id/credit-enforcement`
    → observe → then `CREDIT_ENFORCE_NEW_COMPANIES=true`. This is `docs/ops/credit-rollout-runbook.md:79-83`'s
    own sequence; follow it, do not compress it. **Never stamp the real Kashif Recruiting tenant.**
17. Ship the customer-facing balance/ceiling surface **in the same release** as step 16's final flip.
18. Update the two stale schema comments this pass re-confirmed:
    `schema.prisma:709-713` (`maxCreditsPerExecution`/`maxCreditsPerTask` "inert") and
    `:1038-1042` (`totalCreditsCharged` "inert until then"). Both are false.

**Decisions that still need a human — do not let the plan guess:**

- **Founder/pricing:** `FREE_GRANT_CREDITS` (1,000), `FREE_GRANT_EXPIRY_DAYS` (30),
  `FREE_GRANT_DOMAIN_CAP` (3), `DEFAULT_CREDITS_PER_USD` (100) and
  `DEFAULT_MAX_CONCURRENT_EXECUTIONS` (10) are all marked `// FOUNDER-PENDING` in code and are all
  still at their illustrative defaults. The two new cost ceilings are the same class of number.
- **Business:** do existing tenants stay grandfathered forever, or is there a migration date? The
  code has no concept of a scheduled cohort — only a manual per-company `PATCH`.
- **Business:** does a customer who hits a ceiling get a self-serve top-up (needs
  `CREDIT_PAYG_ENABLED=true` + real Stripe prices for every `CreditPack`) or a "contact us" wall?
- **Product:** are `ENTERPRISE` tenants exempt from the company cost ceiling? They are already exempt
  from `budgetLimit` (`creditsPerEmployeeFor('ENTERPRISE') === null`), so today they have **no**
  spend bound of any kind.
- **Product:** accept the `totalCreditsCharged` semantic switch from *settled* to *reserved* if
  `WorkflowRun.creditLimit` is ever populated (§4 caveat 2), since that is what the customer sees on
  the run page.

**Flagged as undetermined rather than guessed:** whether `subscription-credit-renewal` runs in
production; whether production is `inline`/`legacy_walk`; whether `UsageEvent` has a
`[companyId, createdAt]` index; and the current production values of all four `CREDIT_*` flags (they
are absent from every checked-in env file, so the repo cannot answer this).
