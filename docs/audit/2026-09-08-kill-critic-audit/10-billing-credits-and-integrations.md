# Cluster 10 — Billing/Credit Attribution Trace + Engine Integrations

Source: direct code read, 2026-09-09, one level deeper than cluster 01 §C (which established all 14 credit
tables have real writers but are feature-flag-dormant by default). This cluster traces the FULL attribution
chain end to end and audits the four third-party engine integrations (Postiz/Chatwoot/Plane/Twilio-WhatsApp).
All paths relative to `d:/Vertical AI/platform` unless noted. Evidence hierarchy: executable code > schema
comments > docs (schema/doc comments in this codebase have already been shown twice to be stale — cluster 01's
"deliberately INERT" comment, and this cluster's own maxCreditsPerExecution finding below).

---

## Part A — Billing / Credit / Usage full trace

### A.0 The real shape of the pipeline (correction to the assumed chain)

The brief's assumed chain is `... → Tokens → UsageEvent → CreditLedger → ...`. That is not how the code works.
`UsageEvent` (`usage.service.ts:56-101`) and `CreditLedger` (`credit-ledger.service.ts`) are **two independent,
parallel writers off the same token counts**, not a pipeline:

- `UsageService.record()` is **always on** (no flag), single-writer, computes its own flat-rate
  `estimateCostUsd()` (`usage-rates.ts`), and never throws (best-effort, like `AuditLogService`).
- `CreditLedgerService`/`CreditReservationService` are gated behind `CREDIT_LEDGER_ENABLED` and price via a
  completely separate mechanism, `CreditCostCalculatorService.priceLlmCall()`, which resolves a frozen
  `ModelCostRate`/`ToolCostRate` row (`credit-cost-calculator.service.ts:43-56`) — provider cost → +10% safety
  margin → × `creditsPerUsd`.

Nothing reads `UsageEvent` to produce a `CreditLedger` row or vice versa. They can and do disagree (different
rate models), and the customer-facing `/billing/usage` page (`billing.controller.ts:67,121,131`) reads
**only `CreditLedgerService.listEntries()`** — `UsageEvent` has no customer-facing surface at all except as an
aggregate input to `BillingService.usage()`'s legacy "tasks" count. See A.6 for the consequence.

### A.1 Full hop-by-hop trace

| Hop | Real? | Evidence |
|---|---|---|
| Employee → Workflow Run | Yes | `WorkflowRun.actingEmployeeId`, derived at creation by `engine/employee-references.ts` (first employee-bearing node in DEFINITION order). Confirmed **live**, not the "dead until 2026-09-03" column cluster 01 flagged — real FK + `[companyId,actingEmployeeId,createdAt]` index, shown in `/runs` and `/runs/[runId]`. |
| Workflow Run → AI Step / Tool Action → LLM call | Yes | `ai-step.handler.ts` and `agent-runtime.service.ts` (chat, reachable from AI_EMPLOYEE_STEP too) both call `CreditCostCalculatorService.priceLlmCall` before the real completion. `skills.service.ts:764` (`runTool`) prices every tool call via `priceToolCall`. |
| LLM call → Tokens → CreditLedger | **Yes, with real per-row attribution** | `CreditLedgerService.append()` (`credit-ledger.service.ts:70-136`) writes `employeeId`, `workflowRunId`, `workflowStepRunId`, `conversationId`, `reservationId` on every row. `workflowId` is **derived server-side** (`resolveWorkflowId`, `:125-136`) from `workflowRunId` if the caller didn't pass it explicitly — this exists specifically because `CreditLedger.workflowId` was "fully plumbed... and no caller ever passed it" until this fix (comment `:106-124`), which produced the exact "Credits 0" defect CLAUDE.md documents. **Confirmed present in the actual row-write path, not just the `WorkflowRun` table** — this was the crux of the brief's question and it checks out. |
| CreditLedger → CreditReservation / CompanyCreditBalance | Yes | `CreditReservationService.reserve/settle/release` (`credit-reservation.service.ts`) — reserve→settle→release state machine, advisory-locked per company, idempotent by construction (`sha256(companyId:workflowStepRunId)` or `sha256(companyId:conversationId:messageIdempotencyKey)`). `rollUpSpendOntoRun` (`:341-379`) writes `WorkflowStepRun.creditsCharged` (raw SQL `COALESCE` — Prisma's `increment` on a nullable column with no default silently no-ops, a real bug caught only by running it, per CLAUDE.md) and `WorkflowRun.totalCreditsCharged`. |
| Balance → Budget (`AiEmployee.budgetLimit`/`maxCreditsPerExecution`/`maxCreditsPerTask`) | **Yes — cluster 01's "inert" characterization is now stale** | See A.2. |
| Budget → Billing (Subscription/Stripe) | Partial | Subscription/plan seat ceilings enforced (A.3); Stripe webhooks land subscription state and `ProcessedWebhookEvent` dedup; but there is **no automated revenue-leg reconciliation against Stripe** (A.5) and **no PAYG purchase path is live by default** (`CREDIT_PAYG_ENABLED` defaults false — returns "not available yet"). |

### A.2 Budget enforcement is real, pre-flight, and multi-choke-point — but flag-gated

`schema.prisma:709-713` still comments `maxCreditsPerExecution`/`maxCreditsPerTask` as **"inert until [credit
enforcement] phase"**. This is **stale**, exactly like cluster 01's credit-table comment. `credit-limits.service.ts`
(`CreditLimitsService`) implements all three enforcement layers as a documented "kill-critic audit gap fix,
2026-08-20, Gap F":

- **Layer 1** (company balance floor) — `CreditLedgerService`'s guarded `updateMany` (`balance >= amount`),
  throws `InsufficientCreditsError`.
- **Layer 2** (`AiEmployee.budgetLimit`, monthly, credit-denominated via `EmployeeCreditPeriodCounter`) and the
  **execution/task ceilings** (`maxCreditsPerExecution`/`maxCreditsPerTask`) — `checkAndReserveEmployeeBudget`
  (`credit-limits.service.ts:96-175`), throwing `EmployeeBudgetExceededError` /
  `EmployeeExecutionCeilingExceededError` / `EmployeeTaskCeilingExceededError`.
- **Layer 3** (`WorkflowRun.creditLimit`, per-run cap) — `checkAndReserveWorkflowLimit` (`:183-207`), a guarded
  `updateMany` re-checked on **every node/tool call**, not just at run start — a `LOOP` node is "hard-stopped
  exactly at the cap, never over" (class doc `:177-181`).

All three checks are wired at **every real spend choke point found**: `agent-runtime.service.ts:420-461` (chat
turn, checked BEFORE the reservation, which is itself BEFORE the real LLM call — genuinely pre-flight, and
re-checked at the top of every loop iteration after the first via `assertUnderBudget`, `:505-509`),
`ai-step.handler.ts:168-181` (workflow AI_EMPLOYEE_STEP), and `skills.service.ts:779-793` (TOOL_ACTION/`runTool`,
which reports a blocked call as `ok:false` rather than throwing, matching that method's own "never throws"
contract). **This answers "does budget enforcement work mid-run, not just at start" affirmatively where the
flags are on**: Layer 3 is checked live per node, and Layer 2 is re-checked per chat-loop iteration.

**But every one of these paths is gated behind `companyEnforcementActive()`** (`credit-config.ts:82-86`), which
requires BOTH `CREDIT_ENFORCEMENT_ENABLED=true` (global) AND `Company.creditEnforcementEnabledAt` set
(per-company canary allowlist) — a genuinely deliberate two-key staged-rollout design, not an oversight. With
either false (today's default: both), every check above is skipped and the call proceeds unmetered.

### A.3 Role-based hiring plan seat/budget ceilings — enforced identically across all 3 hire paths, confirmed

`checkSeatFor()` (`billing.plans.ts:160-181`) is a single pure function. All three hire entry points funnel
into the **same** `EmployeesService.create()` (`employees.service.ts:83-134`), which reads the roster and calls
`checkSeatFor` **inside** a per-company Postgres advisory-locked transaction (`:95-112`) — closing the
count-then-create race a plain check would have:
1. Direct hire (`POST /employees` → `EmployeesService.create`).
2. Onboarding wizard (`onboarding.service.ts:360`, same `checkSeatFor` call, same plan/roster shape).
3. Marketplace employee-template install (`marketplace.service.ts:40` "Hire an employee from a template →
   EmployeesService.create", `marketplace.catalog.ts:9` — genuinely delegates rather than reimplementing).

CLAUDE.md's claim of "identical enforcement across all 3 hire paths" **checks out** — verified by tracing all
three call sites to the one shared `create()` method, not just by reading the doc's own claim.

### A.4 Default-deployment state: unmetered LLM/tool spend is real, and the codebase's own preflight names it a P0

With `CREDIT_LEDGER_ENABLED`/`CREDIT_GRANTS_ENABLED`/`CREDIT_ENFORCEMENT_ENABLED`/`CREDIT_PAYG_ENABLED` all
`false` (the shipped default per `credit-config.ts`), a company can chat with every AI Employee and run every
workflow with **zero credit reservation, zero balance check, zero budget check** — every credit call site is a
complete no-op (by design, for a "free beta/pilot" scenario per `preflight-env.mjs:235-237`).

`scripts/preflight-env.mjs:246-293` is explicit about this being a **named, surfaced** risk rather than a
silent gap: in production it WARNS (not blocks) `"CREDIT_LEDGER_ENABLED is not 'true' — ... All AI work is free
and unmetered."` and `"CREDIT_ENFORCEMENT_ENABLED is not 'true' — ... A company at zero balance keeps getting
unlimited AI."` This is the single clearest first-party admission in the repo that shipping today = unmetered
spend is a live possibility, not a hypothetical.

**There IS a real, always-on fallback safety net — but it caps concurrency, not spend.**
`CompanyConcurrencyGuardService` (`company-concurrency-guard.service.ts`) is a per-company in-flight execution
cap (`DEFAULT_MAX_CONCURRENT_EXECUTIONS = 10`, Redis INCR/DECR with an in-memory fallback and a 300s
self-healing TTL), wired into **all three** real spend entry points
(`agent-runtime.service.ts:141`, `ai-step.handler.ts:67`, `skills.service.ts:638`) — each call site's own
comment states it is "**Independent of the credit-enforcement flag hierarchy** (§26's abuse-prevention framing:
always-on, generous default, invisible unless a threshold is crossed)". This bounds concurrent abuse (10
simultaneous LLM/tool calls per company) but places **no ceiling at all on sequential, unlimited-volume spend
over time** — a company can run workflows back-to-back, one after another, forever, with real LLM/tool cost
and zero dollars ever debited from anything. **Verdict: P0 business risk in the literal sense the codebase's
own preflight names it, partially — not fully — mitigated by a concurrency cap that was never designed to be a
spend control.**

Separately, role-based hiring plan seat limits (A.3) cap **employee count**, not usage — they do not bound how
much any one hired employee can spend once credit flags are off.

### A.5 Reporting/analytics: `/billing/usage` "Credits 0" bug — genuinely fixed, but only observable when the ledger is on

The CLAUDE.md-documented bug (a run debited a real credit while the UI said "Credits 0 — No billable steps") is
fixed at the data layer: `RunCreditPanel.tsx:12,19,33` now reads `run.totalCreditsCharged` /
`step.creditsCharged`, and those columns are written by `rollUpSpendOntoRun` inside the same transaction as the
ledger DEBIT (A.1). `UsageLedgerTable.tsx` renders an honest `"No usage in this range."` empty state rather than
a fabricated zero.

**But** — because `CREDIT_LEDGER_ENABLED` defaults `false`, no reservation is ever created and `rollUpSpendOntoRun`
never runs in a default deployment, so **every run's credit panel and the whole Usage Ledger page show
empty/zero by default, indefinitely** — not because the display is broken, but because the underlying feature
is off. This is the correct, honest behavior for a flag that's off, but it means the fix is invisible in the
shipped default and cannot be distinguished from the original bug by a customer looking at the screen. No
messaging anywhere on `/billing/usage` (`page.tsx`) tells a company "credit tracking is not enabled for your
account" — the empty state looks identical to "credit tracking is on and you've spent nothing."

`internal/platform-admin/finance/rollup` (`finance-reporting.controller.ts`) is real (queries a real
pre-aggregated `CreditUsageDailyRollup`) but `PlatformAdminGuard`-only, curl-only — no operator UI, confirming
cluster 06's finding still holds.

**Reconciliation is real but partial**: `CreditReconciliationService.runDaily()` (`credit-reconciliation.service.ts`)
runs an automated internal-consistency leg and a cost leg (against manually-recorded `ProviderInvoice` rows
only), but **the revenue leg against Stripe is explicitly NOT implemented** — `StripeBillingProvider` only
reacts to webhooks, it never queries Stripe for a period total (class doc `:22-33`), so nothing here catches a
Stripe-side revenue discrepancy automatically.

### A.6 A concrete gap the brief didn't name but the trace surfaced: AI Assist sessions bypass the credit ledger entirely

`assist-agent.service.ts` (the AI Assist conversational workflow-builder's LLM loop) imports and calls
`UsageService.record()` (`:353`, tagged `ASSIST_USAGE_SOURCE` so its spend is "separable from chat spend") but
**never imports `CreditReservationService` or `CreditLimitsService` at all** (confirmed by grep — zero matches
in the file for either). Consequences:

- Assist LLM calls are metered in `UsageEvent` (visible only to the flat-rate USD estimate, no per-row
  customer surface) but **never reserved, debited, or budget-checked** in `CreditLedger` — even with every
  credit flag on and enforcement active for a company, AI Assist usage is completely unmetered and
  unenforceable, the one real gap in an otherwise consistently-wired three-choke-point design (chat/AI_STEP/TOOL_ACTION).
- Because `/billing/usage`'s `UsageLedgerTable` reads `useCreditLedger` (→ `CreditLedgerService.listEntries`),
  **Assist spend never appears on the customer-facing Usage page at all**, regardless of flag state — a real,
  independently-discovered attribution gap, not one CLAUDE.md or cluster 01 mention.

---

## Part B — Engine integrations (Postiz / Chatwoot / Plane / Twilio-WhatsApp)

| Engine | Code exists | Skill/tool wired | Connection/self-service path | Runtime (real HTTP vs stub) | E2E coverage | Deployed/reachable today | Production status |
|---|---|---|---|---|---|---|---|
| **Postiz** (marketing/social) | Yes, full (`postiz-client.service.ts`) | Yes — `postiz` skill, `schedule_post`/`list_connected_accounts` etc, `marketing.service.ts` | **Admin-assisted only** — `postizCustomerGroupId` is set via `PostizTenancyController` (`internal/platform-admin/companies/:id/postiz-group`, `PlatformAdminGuard`-only by design, since one shared Postiz instance means the group id IS the tenant-isolation boundary). Requires a manual step **inside Postiz itself** first (an operator tags the integration to the group — Postiz's own API can't do this via its public surface, `postiz-tenancy.controller.ts:32-37`). No company self-service exists or is intended to. | **Real** for connect-url/list-integrations/schedule-post/list-posts (`postiz-client.service.ts:100-165`, real `guardedFetch` HTTP, circuit-breaker+rate-limit wrapped). Analytics endpoints (`getIntegrationAnalytics`/`getPostAnalytics`) are explicitly commented **`IMPLEMENTED_UNVERIFIED`** — "has NOT been verified against a live Postiz instance... never present these numbers to a customer as fact before that pass runs" (`:37-49`). | `engines-marketing.e2e-spec.ts` (153 lines) — schema + catalog + one real chat-loop tool-call test via the mock executor, no live-instance test. | **No** — `infra/docker-compose.yml` defines only postgres/redis/minio/adminer (+ an opt-in observability profile); there is no `postiz` service anywhere in it. `.env.example:208` supplies `POSTIZ_BASE_URL=http://postiz:3000` — a Docker-network-internal hostname implying a container that was never added to compose. | **Code complete for the core publish path, verified against real Postiz source; UNREACHABLE in production** — no self-hosted instance exists anywhere in this repo's infra, so even a company with a fully assigned `postizCustomerGroupId` has nothing live to call. |
| **Chatwoot** (support) | Yes, mostly (`chatwoot-client.service.ts`) | Yes — `chatwoot` skill, `reply_to_conversation` tool | **None — genuinely absent.** `provisionAccount()` **throws `NOT YET IMPLEMENTED`** unconditionally (`chatwoot-client.service.ts:72-107`) — the 8-step sequence is fully documented (grounded in reading Chatwoot's actual Rails controllers, not guessed) but not coded. Grepping the whole backend for `chatwootAccount.create` returns **zero results** — no application code path, admin or self-service, can ever create a `ChatwootAccount` row. The only writers are `deleteMany` (`chatwoot-engine.adapter.ts:53`) and reads. | `sendReply` and `verifyWebhookSignature` are **real** (correct HMAC scheme, verified against Chatwoot's actual `lib/webhooks/trigger.rb`, including a documented fix to a previously-wrong signature scheme). `resolve_conversation` explicitly returns `ok:false` with **"NOT YET IMPLEMENTED against the real Chatwoot API"** rather than faking success (`real-skill-executor.ts:1325-1340`) — an honest stub, not a silent no-op. | `engines-support.e2e-spec.ts` (480 lines) — by far the deepest of the four: schema, catalog, a real chat-loop tool call, auto-pause-to-WAITING-with-no-APPROVAL-node behavior, and a low-confidence-forces-approval interaction test. All against the mock executor. | **No** — same docker-compose gap; `.env.example:211` gives `CHATWOOT_BASE_URL=http://chatwoot:3000`, again a container that doesn't exist in compose. | **The strongest-tested of the three self-hosted engines at the tool-call layer, but structurally UNREACHABLE end to end** — even with a live Chatwoot instance stood up tomorrow, there is no code path (self-service or ops) to link a company to an account. This is worse than Postiz: Postiz at least has an admin endpoint; Chatwoot has none. |
| **Plane** (PM/issue tracking) | Yes (`plane-client.service.ts`) | Yes — `plane` skill, `list_issues`/`create_issue`/`update_issue_status` tools | **None — same gap as Chatwoot.** `provisionWorkspace()` **throws `NOT YET IMPLEMENTED`** (`:123-140`) — again fully documented (Plane's session-cookie-only workspace/token-creation flow, grounded in reading Plane's actual Django views) but not coded. Zero `planeWorkspace.create` calls anywhere in application code (only `deleteMany` + reads). | `createIssue`/`listIssues`/`updateIssueStatus` are **real** (plain `fetch`, `X-Api-Key` auth) and `verifyWebhookSignature` is a real, source-grounded HMAC check (raw hex digest, no prefix — explicitly noted as a *different* scheme from Chatwoot's, verified against Plane's actual `webhook_task.py`). | `engines-pm.e2e-spec.ts` — **only 31 lines**: one test that creates a `PlaneWorkspace` row via **raw Prisma** (bypassing all application code, since none exists) and one that asserts the skill catalog registers the three tool names. **No tool-call test, no chat-loop test, no approval-gating test** — the thinnest e2e coverage of the four integrations by a wide margin. | **No** — same gap; `.env.example:214` gives `PLANE_BASE_URL=http://plane:8000`. | **Weakest of the four overall.** Real, source-grounded HTTP client code exists, but it has the least test depth AND the same total absence of a workspace-linking path as Chatwoot — UNREACHABLE in production, and the one integration where even the test suite quietly concedes there's no way to create the linking row through the app (hence testing it via raw Prisma). |
| **Twilio WhatsApp** (leads/whatsapp) | Yes (`twilio-whatsapp-client.service.ts`, `whatsapp-accounts.service.ts`) | Yes — real inbound lead capture (`modules/leads`) + skill/tool surface | **Full self-service, and the only one of the four that's genuinely usable by a real customer today.** `WhatsappAccountsService.connect()` (`whatsapp-accounts.service.ts:48-106`) is a dedicated connect form: takes a company's own Twilio Account SID/Auth Token, **verifies them with one real authenticated Twilio API read before writing `CONNECTED`** (`:63-67`, closing a documented prior "green badge on bad creds" bug), encrypts the auth token at rest, and upserts a per-company `WhatsAppAccount` row — no platform-operator or ops step required at all. | **Fully real** — genuine `twilio` npm SDK (not a hand-rolled HTTP wrapper), `client.messages.create` for send, `client.api.accounts(sid).fetch()` for verify, and Twilio's own `twilio.validateRequest` (not a custom implementation) for inbound webhook signatures — explicitly per Twilio's own guidance ("Do not implement your own"). Circuit breaker + rate limiter genuinely wired to record success/failure (a real prior bug — `guard()` was called but neither `recordSuccess` nor `recordFailure` ever was, so the breaker could never open — is fixed and documented in the class's own comment). | `whatsapp-lead-pipeline.e2e-spec.ts` exists (full lead-capture pipeline). | **Yes, functionally** — Twilio is a real external SaaS a customer signs up for directly (not a self-hosted service Orlixa must stand up), so there is no docker-compose/infra dependency at all. This is the one integration with **zero deployment gap**. | **The only one of the four actually usable by a real customer today**, contingent only on the customer having their own Twilio account (which is Twilio's own onboarding, outside this codebase) — no Orlixa-side infrastructure blocker exists. |

### B.1 The core distinction this cluster confirms

CLAUDE.md lists "Postiz/Chatwoot/Plane deployment" as **not started**, and this pass verifies exactly what that
means concretely: `infra/docker-compose.yml` (read in full) defines `postgres`, `redis`, `minio`, `adminer`, and
an opt-in `observability` profile (`jaeger`/`prometheus`/`grafana`) — **no `postiz`/`chatwoot`/`plane` service
exists in it at all**, while `apps/api/.env.example` supplies Docker-network-internal hostnames
(`http://postiz:3000`, `http://chatwoot:3000`, `http://plane:8000`) for exactly those three services as if
they were expected to run as sibling containers. The `.env.example` and the compose file disagree with each
other — the config was written assuming a deployment shape that was never built.

Layered on top of that missing infrastructure, **Chatwoot and Plane have a second, independent blocker**:
even if an operator stood up real self-hosted instances by hand tomorrow, there is **no code path anywhere in
the application — self-service or admin** — that can create the `ChatwootAccount`/`PlaneWorkspace` row linking
a company to that instance. `provisionAccount()`/`provisionWorkspace()` are honest, well-documented stubs that
throw rather than fabricate a working call against services nobody has run them against — a real, deliberate
engineering discipline (visible in the class doc comments), but it means these two integrations are two
independent "not started" steps away from customer-usable, not one.

Postiz is one step better (an admin endpoint exists for the tenancy mapping, `PostizTenancyController`), and
Twilio WhatsApp is the only integration of the four with **zero** infrastructure or provisioning gap — a real
customer can connect it today, contingent only on their own Twilio account.

---

## Top 5 most severe findings

1. **Chatwoot and Plane cannot ever be connected to a company by any code path that exists today, regardless of
   infrastructure.** `provisionAccount()`/`provisionWorkspace()` both throw `NOT YET IMPLEMENTED`, and a
   repo-wide grep for `chatwootAccount.create`/`planeWorkspace.create` in application code returns zero
   results — the only writers are `deleteMany` and reads. The Plane "e2e" test proves this inadvertently: it
   creates the linking row via **raw Prisma**, because there is no application code to call instead. This is a
   deeper, more absolute gap than "not deployed" — even a live instance changes nothing without new code.
2. **The credit system's own deploy preflight (`scripts/preflight-env.mjs:249-251`) states, in its own words,
   that the shipped default is "All AI work is free and unmetered"** — and the one safety net that IS always-on
   (`CompanyConcurrencyGuardService`, max 10 concurrent executions per company) caps concurrency, not volume or
   spend over time. A company can sequentially run unlimited workflows/chat turns with real LLM/tool cost and
   never be charged a credit, today, by default.
3. **AI Assist sessions are invisible to the entire credit system.** `assist-agent.service.ts` records
   `UsageEvent` but never calls `CreditReservationService`/`CreditLimitsService` — the one real LLM entry point
   that was never wired into the otherwise-consistent three-choke-point enforcement design (chat/AI_STEP/
   TOOL_ACTION). Consequence: Assist spend never appears on `/billing/usage` (which reads `CreditLedger`
   exclusively) and is never enforceable even with every credit flag on.
4. **`infra/docker-compose.yml` and `apps/api/.env.example` actively disagree about the deployment shape.**
   The env file supplies `postiz`/`chatwoot`/`plane` as Docker-network hostnames implying sibling containers;
   the compose file never defines them. This isn't merely "not deployed yet" — it's configuration written for
   an infrastructure shape that doesn't exist anywhere in the repo, a trap for anyone who assumes the
   `.env.example` describes what `docker compose up` actually produces.
5. **`maxCreditsPerExecution`/`maxCreditsPerTask` are real and enforced (2026-08-20 gap fix) despite
   `schema.prisma:709-713` still calling them "inert until [credit enforcement] phase."** This is the second
   confirmed instance (after cluster 01's credit-table comment) of this schema's own comments actively
   understating what the code does — a real risk for any future auditor or engineer who treats schema comments
   as ground truth in this repo without re-verifying against the service layer.
