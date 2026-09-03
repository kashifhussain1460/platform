# ORLIXA — FINAL DEEP PRODUCTION AUDIT

**Date:** 2026-09-02
**Commit:** `00552e4` (master). Working tree clean except `.claude/worktrees/`.
**Roles applied:** principal SaaS architect · CTO · staff backend · staff frontend · product
architect · QA lead · browser E2E · security · reliability · FinOps · kill critic.
**Companion:** [current-system-inventory.md](current-system-inventory.md)

## REMEDIATION STATUS — 2026-09-03

Three waves have shipped against this report. **The findings below are preserved
as written** — they are the evidence, and rewriting them would destroy the record
of what was actually wrong. This section is the delta.

| Measure | At audit (2026-09-02) | Now | Ceiling once the worker is deployed |
|---|---:|---:|---:|
| Product Concept Completion | 66% | **78%** | — |
| Production Readiness | 52% | **71%** | ~86% today, 100% with the worker |
| Architectural Integration | 62% | **83%** | — |
| **Verdict** | **C** | **C — closing** | **D** once P0-B lands |

### Founder decisions taken
- **Always-on worker: APPROVED.** 100% Production Readiness is therefore reachable.
- **AI Employee category/subcategory: DROPPED.** Eight roles are enough; the rubric
  is reweighted rather than a second taxonomy being built (§12, §14).

### Closed, with the commit that did it

| Finding | Commit | Evidence |
|---|---|---|
| **P0-1** account takeover | `7c11e95` | `NODE_ENV=production` boot now dies with the reason; guard no longer waits on `CREDIT_GRANTS_ENABLED` |
| **P0-C** (worker half) | `7c11e95` | 8 of 18 cron jobs had NO BullMQ driver — the audit understated this. New `platform-sweeps` queue; 8 schedulers verified in Redis |
| **P0-B** verifiability | `7c11e95` | `GET /admin/runtime` reports the engine ACTUALLY in use, not the configured one |
| **P1-A** run attribution | `7c11e95` | `actingEmployeeId` derived at run creation + FK + index + history backfilled; shown in the runs table and run page |
| **P1-B / P1-9** credit truth | `7c11e95` | The page that read "Credits 0 — No billable steps" now reads "Run by Cassie Credits · Credits 1 · ai (AI_EMPLOYEE_STEP) 1" |
| **P2-1** flaky credit test | `7c11e95` | 4/4 green, was 1-in-3 red |
| **P1-D** approval routing UI | `9b20814` | Full routing editor + queue badges + "Waiting on me" |
| **P1-E** fake-capable skills | `9b20814` | OAuth refused server-side for skills with no executor |
| **P1-F / P2-2** per-employee model | `9b20814` | Ledger rate row is now the employee's model, not the env default |
| **P1-4** HR UI | `83162a8` | `/hr` — roster, time off, onboarding; resolver-gated, admin-only |
| **P1-C / P1-11** deploy gates | `83162a8` | Preflight now covers all four credit flags, OTel and alerts |
| **P1-10 / P1-G** browser coverage | `83162a8` | **13 tests, was 8** — added cross-tenant and 4 failure journeys |

### Still open

**P0-B and P0-C's other half are infrastructure, not code:** the always-on worker
must actually be deployed, and the 18 crons registered (or made redundant by that
worker). Until then `GET /admin/runtime` will keep reporting
`durableExecution: false` in production, which is now the single check that
matters.

Also open: real executors for stripe/github/hubspot/jira (**gated**, so no longer
dangerous — just absent), Postiz/Chatwoot/Plane deployment, an OTel collector
(now **warned about** at deploy time), HR documents/reviews/attendance UI,
tenant deletion, and the remaining P2 cleanups. The credit flags need a founder
pricing decision before they can be switched on — the gate that stops that being
forgotten now exists.

### Two corrections to this report

1. **§26 P0-2 understated the cron problem.** It said deploying a worker fixes the
   parked crons "for free". True for 10 of 18 jobs; the other eight —
   including `subscription-credit-renewal`, which is how paying customers get
   their monthly credits — existed only as HTTP switch cases and would have run
   on *no* deployment shape. Fixed in `7c11e95`.
2. **§10 wrongly slated `GET /workflows/node-types` for deletion.** The stated
   evidence (zero web references) was true; the conclusion was not. Its consumer
   is `workflow-p2-nodes.e2e-spec.ts`, asserting the runtime registry against
   what the engine claims to support — an assertion `node-definitions` cannot
   make, because it serves a static hand-authored catalog. Kept.

---

## Changes made during this audit

**No source code, schema, migration or configuration file was modified.** `git status` shows
only two new untracked files — this report and the inventory beside it (plus one evidence
screenshot).

What I did change, and why:

- **Created 4 throwaway test tenants** (`audit-victim2-…`, `audit-marketingco-…`,
  `audit-hrco-…`, `audit-creditco2-…`) in the local dev database. No real tenant was touched.
- **Set `Company.creditEnforcementEnabledAt`** on two of those throwaway tenants, to prove the
  credit-enforcement path blocks. Reverting is not needed; they are test rows.
- **Set `permissions.makePayments = false`** on one throwaway employee, to prove permission
  enforcement survives a human approval.
- **Ran the API and web dev servers** with provider env vars pinned, then stopped them. Redis
  is back to its 1-client idle baseline.
- **Ran the Playwright suite**, which deleted stale failure artefacts committed under
  `e2e/test-results/`. I restored them with `git checkout`. Side note: `e2e/test-results/`
  should be gitignored — it is regenerated by every run and will keep producing spurious diffs.

## How to read this

Nothing here is scored on a file existing. Every claim below is backed by one of:

- a file/line citation,
- a command I ran and its output,
- a live HTTP request/response against a running stack,
- a SQL query against the live database,
- a Playwright run that actually executed in Chromium.

Where I could not get evidence I say so. **Previous audits were treated as history, not
truth** — several of their headline findings are now fixed, and several are still open
exactly as written.

### What I actually ran

| Check | Result |
|---|---|
| Docker infra (postgres 5433, redis 6380, minio, adminer) | up |
| Migrations on disk vs applied | 64 / 64 — no drift |
| API + web dev servers | booted, `/health` 200, web 200 |
| API unit suite | **103 suites, 1015 tests, all pass** (13 s) |
| API e2e, durable engine | **101 suites, 745 tests, all pass** (207 s) |
| API e2e, legacy engine (the production path) | **744 pass, 1 fail** (194 s) — see §25 |
| Playwright browser suite | **8 / 8 pass** (66 s) |
| Live account-takeover attempt | **succeeded** — see P0-1 |
| Live cross-tenant attack sweep (10 endpoints) | all denied |
| Live MEMBER privilege sweep (18 endpoints) | all correctly denied |
| Live end-to-end credit loop (grant → reserve → settle → release) | works |
| Live employee-permission enforcement after human approval | correctly blocked |
| Two differently-configured tenants compared | configuration genuinely changes the product |

### One correction to the repo's own documentation

`platform/CLAUDE.md` says: *"The suite is 100% green — there are NO known-failing tests. If one
fails, it is a real regression; do not dismiss it as environmental."* That absolute is now
wrong in two ways, and both cost me time:

1. Running the e2e suite **without pinning provider env vars** produces 78 failures that are
   pure configuration (`apps/api/.env` carries `LLM_PROVIDER=openai`, and
   `test/setup-e2e-env.ts` deliberately blanks the key). The documented run command must be
   used or the result is meaningless.
2. One test **is** environmentally flaky by construction (§25).

---

# Executive Verdict

> ### Product Concept Completion: **66%**
> ### Production Readiness: **52%**
> ### Architectural Integration: **62%**
>
> ## Overall Verdict: **C — CORRECT ARCHITECTURE, MAJOR PRODUCTION GAPS REMAIN**

### The one-paragraph version

Orlixa is on the **right architectural path** and the engine underneath it is genuinely good:
a real capability resolver that makes a Marketing tenant's product different from an HR
tenant's, a pure-function authorization policy that holds up under direct API attack, AES-GCM
encryption on HR PII that I confirmed as ciphertext in the database, a credit ledger whose
full grant → reserve → settle → release loop I watched execute correctly, per-employee tool
permissions that a human approval cannot override, and 1,760 tests that I watched pass. That
is not a prototype and it is not the wrong design.

What stops it being production-ready is not the architecture — it is that **the production
deployment shape switches off most of what was built.** In the documented, CI-gated Vercel
configuration: all 18 scheduled jobs are parked in a sidecar file Vercel never reads, so
nothing scheduled ever runs; `WORKFLOW_EXECUTION_MODE=inline` forces every workflow run onto
the legacy walker, so the entire durable execution engine is dead code in production; and the
credit system's four flags all default off, so the product currently charges nothing and
blocks nothing. On top of that sits one genuine security defect I reproduced end to end: with
`MAIL_ENABLED` at its default, any account can be taken over from its email address alone.

The concept gap is narrower than the readiness gap. The biggest single one is the platform's
own headline claim: **a workflow run is still not attributed to an AI Employee.**
`WorkflowRun.actingEmployeeId` appears in exactly one place in the entire repository — the
schema that declares it.

---

# 1. What Orlixa Was Intended To Be

From `docs/product/2026-08-01-orlixa-prd.md` and the workflow-system architecture set: a SaaS
where a company **hires AI Employees** that behave like digital staff — each with a role,
department, manager, responsibilities, skills, tools, knowledge, memory, model configuration,
workflows, permissions, approvals, credit budget, KPIs and execution history.

The company configures its organisation once, and that configuration drives the product:

```
Company Configuration → Product Context (plan, industry, departments, user role, hired employees)
   → Capability Resolution → Dashboard / Navigation / Skills / Workflows / Knowledge / Connections
   → AI Execution → Usage & Credits → Audit / Analytics / Realtime
```

The AI Employee is meant to be the **primary abstraction**; a workflow is something an
employee *does*.

# 2. Current Architecture

A pnpm/Turborepo monorepo: `apps/api` (NestJS + Prisma + Postgres/pgvector + BullMQ + Redis),
`apps/web` (Next.js App Router), `packages/types` as the shared DTO contract. 82 models,
64 migrations, 41 modules, 217 routes, 48 pages, 15 workers, 18 cron endpoints.

The target flow above **does exist as code**, and it is not a bolted-on afterthought:

- `modules/product-context/capability-resolver.ts` (526 lines, pure) is the resolver. It takes
  industry, size, business goals, departments, hired employees, installed skills, plan and the
  caller's role, and returns product areas, navigation, dashboard capabilities, relevant and
  recommended skills, and template readiness.
- `product-context.service.ts` is the I/O shell; it defers to `AuthorizationService` rather
  than re-implementing policy, and it deliberately refuses to advertise restrictions the
  endpoints do not actually enforce (see its `AREA_AUTHZ_ACTION` comment — a rare piece of
  honest engineering).
- Seven real UI surfaces consume it: the sidebar, dashboard, workflows page, marketing page,
  skill catalog, workflow chooser, onboarding wizard.

**No new giant abstraction is needed.** The resolver the target model describes is already
here and already working. Almost every gap in this report is a *wiring* or *deployment*
problem, not a design problem.

The one genuine architectural problem is that **two execution engines still both exist in
production code paths**, and which one runs is decided by an environment variable that the
production deployment sets to the wrong value for the good engine (§16).

# 3. Completed

Each of these I verified through the full stack, not by reading a file.

| Capability | Evidence |
|---|---|
| **Multi-tenant isolation** | 10-endpoint cross-tenant attack sweep from tenant A against tenant B's employee, workflow, department, HR staff record and installed skill — every one returned 404. B's data intact afterwards. |
| **Role authorization** | 18-endpoint MEMBER sweep: `403` on HR read *and* write, user creation, audit log, audit export, skill install, DLQ, metrics, retention preview/run, department create. `200` only on the reads members are documented to have. |
| **HR PII encryption at rest** | `select left("personalEmail",30) …` returns `v1:H7pHTgv99Wm+4K5c:aDOeUZD1zK` — ciphertext, plaintext only through the API. |
| **Capability resolution actually drives the product** | Marketing tenant → `MARKETING` area (reason `HIRED_EMPLOYEE`), `EMPLOYEE_MARKETING` widget, recommends `email/gdrive/postiz`. HR tenant → `INTERVIEW_SCHEDULING`, `EMPLOYEE_HR` widget, recommends `calendar/gmail/email/gdrive`, and **no** Marketing area. Same code, different output. |
| **Departments are real** | The old `departments: []` defect is fixed — departments are a first-class onboarding step, persisted, and feed the resolver and the authorization scope. Browser test "department isolation holds in the browser, both directions" passes. |
| **Employee tool permissions are enforced, and approval does not widen them** | Set `makePayments:false`, granted the stripe skill, ran a workflow with `stripe.create_payment_link`, approved it as an owner in the Approval Center — the run **FAILED**: *"Blocked by this AI employee's permissions: 'Make payments' is turned off…"*. Two `SkillExecution` rows, both `ERROR`. Nothing reached Stripe. |
| **High-risk approval gate** | Golden-journey browser test: run pauses `WAITING`, zero tool calls while waiting, approve in the real UI, tool executes **exactly once**. |
| **Credit loop correctness** | Live ledger for one run: `CREDIT +1000` (signup grant) → `RESERVATION −30` → `DEBIT −1` → `RELEASE +29`, balance `1000 → 999`, reservation `SETTLED`, all three spend rows employee-attributed. |
| **Credit enforcement blocks when armed** | Enforcement on + zero balance → run `FAILED`, `failureClass=INSUFFICIENT_CREDITS`, message *"This company has run out of credits…"*. |
| **Knowledge, end to end and role-scoped** | pgvector 384/HNSW; role scoping applies in chat retrieval **and** in the workflow `RETRIEVE` node (`retrieve.handler.ts` resolves scope from node employee → workflow category → shared-only, and records `scope` in the run log rather than assuming). |
| **Audit trail with a verifiable hash chain** | Golden journey asserts `approval.approved` is present and `GET /audit-log/verify` returns `valid: true`. UI exists at `/organization`. |
| **Workflow versioning + publish/readiness** | Publish works from the draft version; `GET /:id/readiness` is non-mutating and shares the validator publish uses. |
| **Honest labelling of what is simulated** | `real-execution-support.ts` is a declared registry of the 26 `(skill,tool)` pairs that reach a live provider, guarded by a spec that reads the executor's own `switch`. In production the `default:` branch **refuses** instead of answering from the sandbox. |
| **Honest labelling of estimated metrics** | Dashboard renders `EST.` badges with `~10 min/task` and `@ $25/hr` beside Hours Saved and Cost Savings. |
| **Production config gate** | `scripts/preflight-env.mjs` hard-fails a deploy on `MAIL_ENABLED != true`, `DEV_OTP_CODE` present, mock providers, missing `CRON_SECRET`, and worker/execution-mode mismatch. |
| **Test suites** | 1015 unit + 745 e2e (durable) + 8 browser, all green, run by me today. |

# 4. Partially Implemented

| Capability | What works | What does not |
|---|---|---|
| **AI Employee identity in execution** | node-level `employeeId` drives persona, budget, permissions, memory, usage rows and credit ledger attribution | run-level attribution does not exist (§13) |
| **Credit system** | the whole loop, proven | off by default at 4 flags; run/step credit columns never written; ledger `workflowId` always null |
| **Approvals** | the gate, the decision, the audit, `canDecide` | routing, SLA, escalation and multi-level chains are unreachable from the UI (§19) |
| **Skills** | 11 of 15 have at least one real executor | 4 have none; 3 engines have code but no deployment; only 5 have verify-before-connect adapters |
| **Observability** | real OpenTelemetry SDK, real metrics registry, structured logs with correlation ids | inert without `OTEL_EXPORTER_OTLP_ENDPOINT`, which the preflight never checks; the `alerts` cron is parked |
| **Retention / GDPR** | 10 data classes, legal hold, proven backup restore | the retention cron is parked; no company-delete endpoint exists at all |
| **Marketing domain** | new campaign planning UI + state machine + 11 templates | its `campaign-generation` cron is parked, so a campaign never advances in production; Postiz not deployed |
| **Realtime** | outbox → relay → SSE endpoint, sink registered | no frontend consumer; and no producer at all in the production engine mode (§21) |

# 5. Broken

| # | Item | Evidence |
|---|---|---|
| B1 | **Password reset accepts a fixed constant** when `MAIL_ENABLED` is not exactly `"true"` (the default) | Reproduced live, §26 P0-1 |
| B2 | **No scheduled job runs in production** | `apps/api/vercel.json` has no `crons` key; all 18 live in `vercel.crons.json`, a sidecar Vercel does not read. `docs/runbooks/deployment.md:289` confirms the last production deploy had "**zero** crons in `vercel.json`" |
| B3 | **The durable engine cannot run in production** | `engine-mode.ts:84` — `if (isInlineExecution()) return 'legacy_walk';` and `deployment.md:128` mandates `WORKFLOW_EXECUTION_MODE=inline` |
| B4 | **Run detail page reports 0 credits for a run that was billed** | Browser: `Credits 0` / "No billable steps in this run yet." while the ledger shows `DEBIT −1`. Screenshot: [evidence-run-credits-zero.png](evidence-run-credits-zero.png) |
| B5 | **Orphaned BullMQ repeatables fire forever** | Fresh dev boot logged hundreds of `Scheduled workflow <id> not found; skipping`. The handler skips safely but never removes the repeatable |

# 6. Disconnected

Columns and settings that are written or offered but never consumed.

| Item | Status | Proof |
|---|---|---|
| `WorkflowRun.actingEmployeeId` | **DEAD** | `grep -rn actingEmployeeId apps packages e2e` → 1 hit, `schema.prisma:1017`. On a real run whose only node was an `AI_EMPLOYEE_STEP` bound to an employee, the column was `NULL` |
| `WorkflowStepRun.creditsCharged` | **DEAD** | no writer anywhere; `NULL` on both steps of a run that cost 1 credit |
| `WorkflowRun.totalCreditsCharged` | **EFFECTIVELY DEAD** | only incremented inside `checkAndReserveWorkflowLimit`, which returns early when `creditLimit == null` — the default. So it is 0 for every ordinary run |
| `CreditLedger.workflowId` | **DEAD** | `NULL` on all 4 rows of a workflow-driven spend, so the "Workflow" column on `/billing/usage` always shows `—` |
| `AiEmployee.model` | **TRIPLE-DISCONNECTED** | `LlmCompletionInput` has no `model` field; both providers read `LLM_MODEL` from config; and the Settings panel has **no Model control at all** — only a read-only "Model —" line on the Overview tab |
| APPROVAL node `routing` config | **DISCONNECTED** | declared in `node-catalog.ts:532` but `NodeEditor.tsx` renders only `message` and `autoApprove` |
| `GET /workflows/runs/:id/events` (SSE) | **NO CONSUMER** | `EventSource` appears in exactly one web file, `useAssistStream.ts` — AI Assist, not runs |
| `GET /workflows/node-types` | **SUPERSEDED** | zero web references; `node-definitions` is the live one (5 references) |

# 7. Backend-Only

Complete, migrated, tested backends with **no product surface at all**.

| Domain | Routes with no frontend caller |
|---|---:|
| **HR** (`StaffMember` + 5 satellites, PII encryption, retention sweep) | **20** |
| Legal holds | 3 |
| Platform-operator credit admin / finance rollup / enforcement cohort | 5 |
| Retention preview + run-now | 2 |
| Support conversations (Chatwoot model) | — (only the handoff queue has UI) |

`apps/web/src/features/` has folders for 22 areas. There is **no `hr` folder**. The entire
advertised HR AI Employee domain is reachable only by writing your own HTTP client.

Correctly not called from the browser (not defects): inbound webhooks (`/connectors/:id/webhook`,
`/engines/*/webhook`, `/billing/webhook`), `/skills/oauth/callback`, `/admin/cron/:job`.

# 8. Frontend-Only

I found **no** case of a UI calling an endpoint that does not exist. The `@vaep/types` shared
contract plus the response-schema tests appear to be doing their job.

The nearest thing: `/assist` renders its full interface for a STARTER tenant even though
`product-context` returns `lockedAreas: [{area:'ASSIST', requiresPlan:'BUSINESS'}]`, and the
suggestions panel shows a generic *"Couldn't load ideas right now — you can still describe
your own"* when the real cause is a `403 This feature requires the BUSINESS or ENTERPRISE
plan`. Clicking **Generate plan** *does* surface the correct plan message, so the outcome is
truthful; the pre-click state is misleading. P3.

# 9. Mocked / Fake Success

The good news first: **the "fake success" class has largely been closed.**

- `RealSkillExecutor`'s `default:` branch refuses in production instead of delegating to the
  mock, and says exactly what did not happen.
- `SkillDefinitionDto.executionSupport` exposes `REAL` / `PARTIAL` / `SIMULATED` to the UI, and
  a drift test fails the build if the registry and the executor's `switch` disagree.
- `skills.module.ts` refuses to boot on `SKILL_EXECUTOR=mock` in production.
- `NOTIFY` no longer claims `notified:true` without sending.

What remains:

| Item | Severity |
|---|---|
| **Run detail shows `Credits 0`** for a billed run (B4) — a customer-visible billing misstatement | P1 |
| **4 skills with no real executor at all**: `stripe`, `github`, `hubspot`, `jira`. Two of them (`hubspot`, `jira`) have working OAuth, so a customer can authorise a live account and see CONNECTED | P1 |
| **3 engines with real client code and no deployment**: `POSTIZ_BASE_URL=http://postiz:3000`, `CHATWOOT_BASE_URL=http://chatwoot:3000`, `PLANE_BASE_URL=http://plane:8000` — hostnames that resolve to nothing, with empty API keys, and not present in `docker-compose.yml`. The catalog nonetheless labels their 12 tools `REAL` | P1 |
| **Credit shadow mode fails open**: with `CREDIT_ENFORCEMENT_ENABLED` off, an `InsufficientCreditsError` is caught, logged as `credit reservation failed (shadow mode, ignored)`, and the AI work proceeds free with **no ledger row at all**. I observed exactly this: `Company … has insufficient credits (needs 30 more)` followed by a `COMPLETED` run and zero ledger entries | P1 |
| **Pricing model mismatch**: `ai-step.handler.ts:145` prices with `process.env.LLM_MODEL ?? 'default'` while the provider calls `config.get('LLM_MODEL') \|\| 'gpt-5.6-terra'`. With `LLM_MODEL` unset, spend is priced against a generic `default` rate, not the model actually invoked | P2 |

# 10. Dead / Irrelevant Services

| Item | Size | Verdict |
|---|---|---|
| `poc/workflow-sdk` | **302 MB** | **DELETE.** Evaluated, verdict recorded as "do not adopt". Dead weight in every clone |
| `GET /workflows/node-types` | 1 route | **DELETE.** Superseded by `node-definitions` |
| `RunEventOutbox` + `OutboxRelayService` + SSE run endpoint | 3 files, 1 table | **KEEP but recognise it as inert**: durable-engine-only producer, no frontend consumer. In production it writes nothing because the durable engine never runs |
| `marketplace` vs `workflow-templates` | — | **Already resolved.** Marketplace now only installs employees (`POST /marketplace/employees/:key/install`); templates come from the DB-backed system. The prior audit's P2-5 is genuinely closed |
| `WorkflowVersion` `PARALLEL`/`JOIN`/`LOOP` handlers | 3 files | Registered but rejected by publish validation. Honest placeholder, not dead |

# 11. Role / Department Dependency Audit

The hierarchy `Company → Department → Team → User → Role → AI Employee → Skill → Tool →
Workflow → External Action` exists and is enforced at both layers.

| Test | Expected | Actual |
|---|---|---|
| Marketing tenant → Marketing area | ALLOW | ALLOW (`areaReasons.MARKETING = HIRED_EMPLOYEE`) |
| Marketing tenant → HR area | DENY | not in `productAreas`; no HR nav item |
| HR tenant → HR data | ALLOW | ALLOW (`INTERVIEW_SCHEDULING`, `EMPLOYEE_HR`) |
| HR tenant → Marketing-only data | DENY | `areaReasons.MARKETING = None` |
| Department isolation, both directions, in the browser | DENY across | **passes** (`02-security-journey.spec.ts:37`) |
| MEMBER → HR area, in the browser | DENY | **passes** (`02-security-journey.spec.ts:209`) |
| MEMBER → 18 privileged endpoints by direct API | DENY | 403 on all mutations |
| DISABLED user → uses the app | DENY | **passes** (`02-security-journey.spec.ts:151`) |
| Employee with `makePayments:false` → payment tool, even after approval | DENY | **blocked at execution** |
| Tenant A → 10 of tenant B's resources by direct API | DENY | 404 on all |

Two observations, neither a defect:

- `GET /users` returns `200` to a MEMBER. That is deliberate (the `/team` roster) and matches
  the controller's stated intent.
- `AiEmployee.department` is a **free-text string**, not a foreign key to `Department`. So the
  employee's department cannot be joined to the department the authorization engine scopes on.
  Listed as deferred in `CLAUDE.md` ("AiEmployee.departmentId FK"). P2.

# 12. Onboarding Dependency Audit

`POST /onboarding/complete` accepts exactly three things: `business{industry,size,description}`,
`departments[]`, `employees[{role,name}]`. Plus `PATCH /onboarding/goals` for business goals.

| Onboarding input | Stored | Consumed | Runtime effect | UI effect | Editable later | Status |
|---|---|---|---|---|---|---|
| Company name | `Company.name` | yes | — | header, everywhere | yes (`PATCH /companies/current`) | IMPLEMENTED |
| Industry | `Company.industry` | resolver | — | resolver output | yes | IMPLEMENTED |
| Size | `Company.size` | resolver | — | resolver output | yes | IMPLEMENTED |
| Business goals | `Company.businessGoals` | resolver | — | recommended skills | yes | IMPLEMENTED |
| Departments | `Department` rows | resolver + authz | authorization scope | nav, dashboard, approvals scope | yes (`/organization`) | IMPLEMENTED |
| User role | `User.role` | resolver + guards | every guard | nav, visible areas | yes (`/team`) | IMPLEMENTED |
| AI Employees (role + name) | `AiEmployee` | resolver, dashboard, retrieval | persona, knowledge scope, budget | nav, widgets, templates | partly — **role is not editable after hire** | PARTIAL |
| Plan / entitlements | `Subscription` | resolver | `PlanGuard` | `lockedAreas` | via `/billing` | IMPLEMENTED |
| Free credits | `CreditLot` + balance | ledger | spend | `/billing/usage` | — | IMPLEMENTED (flag-gated) |
| **AI Employee category** | — | — | — | — | — | **NOT IMPLEMENTED** |
| **AI Employee subcategory** | — | — | — | — | — | **NOT IMPLEMENTED** |
| **Skills** | not collected | — | — | — | `/skills` afterwards | **NOT IN ONBOARDING** |
| **Connections** | not collected | — | — | — | `/skills` afterwards | **NOT IN ONBOARDING** |
| **Knowledge** | not collected | — | — | — | `/knowledge` afterwards | **NOT IN ONBOARDING** |
| **AI model** | not collected | — | ignored anyway | — | **no UI control** | **DEAD** |

Two hard facts:

- `grep -rc "subcategory\|subCategory"` across `apps/api/src` and `apps/web/src` returns
  **nothing**. Category and subcategory do not exist in this product in any form.
- `EmployeeRole` has exactly 8 values: `SUPPORT SALES RECRUITER HR ACCOUNTANT PROJECT_MANAGER
  CUSTOM MARKETING`. That is the whole taxonomy.

One inconsistency worth fixing in an afternoon: the repo's own default fake-email domain is
`yopmail.com` (commit `721c996`), and `yopmail.com` is on the disposable-domain blocklist that
suppresses the free-credit grant. Every internal demo tenant therefore gets zero credits, which
is how I initially mis-read the grant path as broken.

# 13. AI Employee Audit

This is where the concept is thinnest.

| PRD question | Answer | Evidence |
|---|---|---|
| Is every workflow run attributed to an AI Employee? | **No** | `actingEmployeeId` has one reference in the repo: the schema line that declares it |
| Is `actingEmployeeId` populated? | **Never** | `NULL` on a real run whose only node was an `AI_EMPLOYEE_STEP` |
| Is employee identity preserved through async execution? | **At node level, yes** | `ai-employee-step.handler.ts:124` threads `employeeId`, `workflowRunId`, `workflowStepRunId` and `source:'workflow_employee_step'` into the runtime |
| Does tool execution know which employee is acting? | **Yes** | the permission block I triggered names the employee and its denied flag |
| Does credit usage attribute to the employee? | **Yes** | all 3 spend ledger rows carried `employeeId` |
| Does analytics attribute activity to the employee? | **Yes** | dashboard "AI Employee Performance" row: `Cassie Credits · MARKETING · active · 1 task · 2 tool actions` |
| Does the dashboard aggregate per employee? | **Yes**, and it is scoped to the employees the caller may see |
| Can one employee use another's skills? | **No** | `EmployeeSkill` grant is checked at execution, not at listing — the golden journey proved it by failing until the grant was added |
| Can a disabled employee execute? | **No** | paused/disabled → 409 |
| Does employee configuration affect runtime? | **Mostly** | persona ✅, budget ✅, `knowledgeAccess` ✅, permissions ✅, **model ❌** |

**There is no link at all between `Workflow` and `AiEmployee` in the schema.** `Workflow` has
`ownerUserId`, `sourceTemplateId`, `assistSessionId` — no employee. The association exists only
inside a node's `config.employeeId`. So "which employee owns this automation" is not a question
the data model can answer, and "show me everything Emma did" can only be reconstructed by
scanning graph JSON.

That is the gap between "we have an AI Employee platform" and "we have a workflow engine with
employee-flavoured nodes." It is a **small fix with large product meaning**: populate
`actingEmployeeId` at run creation from the graph's employee nodes, index it, and expose it.

# 14. AI Employee Settings Audit

Read live from the Settings panel in Chromium.

| Setting | Control exists | Persisted | Runtime consumes it | Verdict |
|---|---|---|---|---|
| Name | ✅ | ✅ | ✅ (system prompt) | IMPLEMENTED |
| Department | ✅ (free text) | ✅ | ⚠️ display only, no FK | PARTIAL |
| Manager | ✅ | ✅ (`managerUserId`) | ✅ `EMPLOYEE_MANAGER` routing rule — but that rule is unreachable from the UI | PARTIAL |
| Language, working hours, timezone | ✅ | ✅ | ⚠️ prompt context only | PARTIAL |
| Knowledge access (`ALL`/`NONE`) | ✅ | ✅ | ✅ `RetrievalService` | IMPLEMENTED |
| Monthly budget limit (USD) | ✅ | ✅ | ✅ hard block in chat and `AI_STEP` | IMPLEMENTED |
| Max credits / execution | ✅ | ✅ | ✅ (`checkAndReserveEmployeeBudget`, credit flags permitting) | IMPLEMENTED |
| Max credits / task | ✅ | ✅ | ✅ same | IMPLEMENTED |
| KPI targets (tasks/week, success %, max pending) | ✅ | ✅ | ✅ analytics attainment | IMPLEMENTED |
| Send email / Contact customers / Make payments / Access knowledge | ✅ | ✅ | ✅ **enforced at execution — proven** | IMPLEMENTED |
| Require approval for external messages | ✅ | ✅ | ✅ gate | IMPLEMENTED |
| Active / paused | ✅ (Pause button) | ✅ | ✅ 409 | IMPLEMENTED |
| **Model** | ❌ **no control** | ✅ via API | ❌ **ignored** | **DEAD CONTROL** |
| **Model provider** | ❌ | ❌ | env-global only | NOT IMPLEMENTED |
| **Reasoning strategy** | ❌ | ❌ | ❌ | NOT IMPLEMENTED |
| **Category / subcategory** | ❌ | ❌ | ❌ | NOT IMPLEMENTED |
| **Approval routing / escalation** | ❌ | ✅ (`approvalRules` JSON) | ✅ backend | **BACKEND_ONLY** |
| Role | ❌ after hire | ✅ | ✅ | NOT EDITABLE |

**Credit to the team:** the seven dead checkboxes the previous audit found are genuinely gone.
`labels.ts:64` documents *why* `approveOverBudget` and `approveRefunds` were removed rather
than faked — "checkboxes that wrote JSON nothing read." That is the right instinct, applied.

**Configuration versioning:** a running workflow executes against a **pinned
`WorkflowVersion`**, so editing a graph mid-run cannot change it. Editing an *employee*
mid-run, however, is read live — persona and permissions are fetched at node execution time.
For permissions that is arguably correct (a revocation should bite immediately); for persona it
means a run can straddle two configurations. Worth a decision, not a defect. P3.

# 15. Dashboard / Analytics Audit

| Widget | Data source | Employee-scoped | Role-scoped | Dept-scoped | Real / est. | Status |
|---|---|---|---|---|---|---|
| Tasks Completed | `SkillExecution` + `Message` + `WorkflowRun` | no | no | no | real count | IMPLEMENTED, labelled `EST.` |
| Hours Saved | `tasks × 10 min` | no | no | no | **assumption** | labelled `EST. ~10 min/task` |
| Cost Savings | `hours × $25` | no | no | no | **assumption** | labelled `EST. @ $25/hr` |
| Success Rate | tools + workflows | no | no | no | real | IMPLEMENTED |
| Pending Approvals | `ApprovalRequest` | no | no | no | real | IMPLEMENTED |
| Active Employees | `AiEmployee` | — | — | — | real | IMPLEMENTED |
| Your AI workforce | roster + 7-day activity | **yes** (visible-ids) | via resolver | via resolver | real | IMPLEMENTED |
| Marketing | `Campaign` `ScheduledPost` `PublishedPost` | — | **yes** (`hasRole('MARKETING')`) | — | real | IMPLEMENTED |
| HR | `StaffMember` `LeaveRequest` `OnboardingTask` `InterviewSlot` | — | **yes** (`HR`/`RECRUITER`) | — | real | IMPLEMENTED |
| Support | `SupportConversation` `HandoffRequest` | — | **yes** (`SUPPORT`) | — | real | IMPLEMENTED |
| Approvals widget | `ApprovalRequest` | — | — | — | real | IMPLEMENTED |
| AI Employee Performance table | usage + skill executions per employee | **yes** | yes | yes | real | IMPLEMENTED |
| Today's AI Activity | activity feed | yes | yes | yes | real | IMPLEMENTED |

The previous audit's "same six generic tiles for everyone" is **fixed**. I watched a Marketing
tenant get a Marketing widget with a real setup hint (*"Connect a social account to start
publishing"* → `/skills`) and an HR tenant get an HR widget (*"Add interview slots…"* →
`/scheduling`), from the same code.

The two illustrative metrics are honestly labelled and the constants file says so in a comment.
They should still be replaced with customer-supplied inputs before they appear in a sales deck.
P2.

# 16. Workflow Runtime Audit

| Entry point | Runtime used | Durable? | Authorized? | Audited? | Idempotent? | Status |
|---|---|---|---|---|---|---|
| Manual `POST /:id/run` | either, per `engineMode` | in queue mode only | ✅ `workflow:run` at enqueue | ✅ | ✅ `idempotencyKey` unique per tenant | IMPLEMENTED |
| Schedule (queue mode) | BullMQ repeatable | ✅ | ✅ publisher re-resolved, `status:ACTIVE` filter | ✅ | ✅ | IMPLEMENTED |
| Schedule (inline/production) | **`/admin/cron/workflow-schedules` — parked** | ❌ | — | — | — | **NEVER RUNS** |
| Webhook `POST /webhooks/:token` | either | as above | public by token | ✅ | idempotency added | IMPLEMENTED |
| Event (`CanonicalEvent` → `fireEvent`) | either | as above | ✅ | ✅ | ✅ | IMPLEMENTED — but its inbound pollers are parked crons |
| Retry `POST /runs/:id/retry` | either | — | ✅ | ✅ | starts a **fresh** run, and the UI says so | IMPLEMENTED |
| Assist dry-run | scratch workflow | — | ✅ | ✅ | swept if leaked | IMPLEMENTED |

**I proved the durable chain works — in queue mode.** One run produced:
`engineMode = state_machine`, `workflowVersionId` pinned, `WorkflowStepAttempt` = 2,
`RunEventOutbox` = 6, `UsageEvent` = 1, both `WorkflowStepRun` rows COMPLETED. That is
`Version → Run → StepRun → Attempt → Lease → Executor → Result → Audit → Usage` genuinely
end to end.

**And it cannot happen in production.** `engine-mode.ts:84`:

```ts
if (isInlineExecution()) return 'legacy_walk';
```

`docs/runbooks/deployment.md:128` mandates `WORKFLOW_EXECUTION_MODE=inline` because "no worker
runs on Vercel; without this no workflow ever executes." So in the documented production shape,
**100% of runs use the legacy graph-walker**: no attempts, no leases, no reaper recovery, no
timers, no outbox, no DLQ, a 300-second wall-clock ceiling per run, and one serverless
invocation held per running workflow.

To the team's real credit, the code **shouts about this at boot** with an `ERROR`-level log
naming the exact consequence. That is a mitigation, not a fix. And because the watchdog cron is
also parked, a run that dies mid-flight is not even marked failed — it stays `RUNNING` for ever.

There are still **two production execution paths in one codebase**, and the one that gets used
is the one with fewer guarantees.

# 17. Skill / Connection / Engine Audit

| Skill | OAuth / config | Verify adapter | Executor | Classification |
|---|---|---|---|---|
| `gdrive` | OAuth | ✅ | 5 real tools | **REAL** |
| `http` | config | — | real | **REAL** |
| `gmail` | OAuth | ✅ | `send_email` real, `read_inbox` mock | **PARTIAL** |
| `slack` | OAuth/webhook | ✅ | `send_message` real | **PARTIAL** |
| `calendar` | OAuth | ✅ | `create_event` real | **PARTIAL** |
| `email` (SMTP/IMAP) | config | ✅ | `send_email` real | **PARTIAL** |
| `scheduling` | internal | — | 2 real tools | **PARTIAL** |
| `marketing` | internal | — | `check_consent` real | **PARTIAL** |
| `postiz` | API key | ❌ | 5 real tools | **CODE-REAL, ENGINE ABSENT** |
| `chatwoot` | platform token | ❌ | 4 real tools | **CODE-REAL, ENGINE ABSENT** |
| `plane` | API key | ❌ | 3 real tools | **CODE-REAL, ENGINE ABSENT** |
| `stripe` | API key | ❌ | **none** | **SIMULATED** (and `create_payment_link` is `highRisk`) |
| `hubspot` | **working OAuth** | ❌ | **none** | **SIMULATED — worst case** |
| `jira` | **working OAuth** | ❌ | **none** | **SIMULATED — worst case** |
| `github` | token | ❌ | **none** | **SIMULATED** |

The `hubspot`/`jira` pair is the sharpest edge: a customer completes a real OAuth consent
screen against their real CRM, sees `CONNECTED`, and every write is answered by the sandbox
outside production (and refused, with a clear message, inside it). The refusal is the right
behaviour; offering the connection at all is the problem.

The three "KEEP / HARDEN" engines are not deployed anywhere I can find: absent from
`infra/docker-compose.yml`, base URLs pointing at unresolvable container hostnames
(`http://postiz:3000`), and empty credentials. Their 12 tools are labelled `REAL` in the
catalog regardless of whether an instance exists.

# 18. Credit / Billing Integration Audit

**It is built, it is correct, and it is switched off.**

Proven live, in order:

```
CREDIT       +1000   balance    0 → 1000   FREE_SIGNUP grant, lot created with expiry
RESERVATION    −30   balance 1000 →  970   employee-attributed, run + step attributed
DEBIT           −1   balance  970 →  970   settle from real token counts
RELEASE        +29   balance  970 →  999   unused hold returned
                                            reservation status = SETTLED
```

| Requirement | Status |
|---|---|
| Subscription → included credits | renewal job exists — **its cron is parked** |
| Balance + reservation + settlement | ✅ proven |
| Idempotency | ✅ `messageIdempotencyKey`, `ToolIdempotencyRecord`, partial-unique run keys |
| Retry safety | ✅ reservation keyed on `stepRunId`, not `nodeId`, so LOOP iteration 2 cannot collide with 1 |
| Concurrency | ✅ per-company in-flight guard on both chat and `AI_STEP` |
| Worker-crash recovery | sweep exists — **its cron is parked** |
| Enforcement | ✅ proven to block; **off by default, two-key (global flag + per-company allowlist)** |
| PAYG purchase | flag-gated off; returns "not available yet" |
| Refunds / expiry / lots | models + services present |
| Model / tool pricing | code-defined defaults + lazily-created DB rows + admin override |
| **Historical explainability after a price change** | ✅ **genuinely solved** — every ledger row stores `modelCostRateId` / `toolCostRateId`, so a past debit still points at the exact rate row that produced it |
| **Workflow attribution in the ledger** | ❌ `workflowId` always `NULL` |
| **Run/step credit rollup** | ❌ both columns dead — the customer sees `Credits 0` |

Two FinOps facts a founder needs to hear plainly:

1. **The revenue path has never been exercised in production.** `CREDIT_LEDGER_ENABLED`,
   `CREDIT_GRANTS_ENABLED`, `CREDIT_PAYG_ENABLED` and `CREDIT_ENFORCEMENT_ENABLED` all default
   to `false`, none appears in `apps/api/.env`, and **`scripts/preflight-env.mjs` does not
   check a single one of them.** A production deploy can ship with billing entirely off and no
   gate will notice.
2. **With the flags off, the system does the work for free and records nothing.** I watched a
   zero-balance company's `InsufficientCreditsError` get swallowed as
   `credit reservation failed (shadow mode, ignored)` while the run completed. That is the
   correct staged-rollout behaviour and also an unlimited free tier.

# 19. Approval / Authorization Audit

| Layer | Built | Reachable from the product |
|---|---|---|
| High-risk tool auto-gate | ✅ | ✅ |
| Explicit `APPROVAL` node | ✅ | ✅ (message + auto-approve) |
| `canDecide` service-level policy (replacing a blanket `@Roles`) | ✅ | ✅ implicitly |
| Approve / reject / modify | ✅ | ✅ `/approvals` |
| Assigned-to-me inbox | ✅ | ✅ `?assignedToMe=true` |
| Chain history | ✅ `GET /:id/history` | ⚠️ no UI reference |
| **6 routing rule types** (`USER` `ROLE` `DEPARTMENT` `TEAM` `EMPLOYEE_MANAGER` `ANY_ADMIN`) | ✅ | ❌ **no UI** |
| **Multi-level chains** | ✅ | ❌ **no UI** |
| **SLA `dueAt` + breach sweep** | ✅ | ❌ no UI, and **its cron is parked** |
| **Escalation chains** | ✅ | ❌ **no UI** |
| **`onTimeout` AUTO_APPROVE / AUTO_REJECT / EXPIRED** | ✅ | ❌ **no UI** |

`grep -rln "approverRule\|EMPLOYEE_MANAGER\|escalationChain\|routingSnapshot" apps/web/src`
returns **nothing**. `node-catalog.ts:532` declares a `routing` config key for the APPROVAL
node; `NodeEditor.tsx:255-282` renders `message` and `autoApprove` and nothing else.

**Consequence for a customer:** every approval a workflow creates is *unrouted*, which falls
back to "any OWNER or ADMIN may decide." Routing to a department head, a named approver or the
employee's manager is a feature that exists in the database, the service layer, the migration
and the test suite — and cannot be turned on.

This is the single largest backend-without-frontend item after HR, and it undermines the
enterprise story more than HR does, because approvals are on the critical path of every
high-risk automation.

# 20. Knowledge / Memory Audit

| Stage | Status |
|---|---|
| Upload | ✅ real screen, visibility choice **required** before upload |
| Ingest | ✅ BullMQ extract → chunk → embed (384-dim, pgvector HNSW) |
| Scope | ✅ `KnowledgeDocument.category` = nullable `EmployeeRole`; `null` = shared |
| Retrieve — chat | ✅ role-scoped via `RetrievalService`, ANDed with `knowledgeAccess` and the `accessKnowledge` permission |
| Retrieve — **workflow `RETRIEVE` node** | ✅ **now scoped too** (node employee's role → workflow category → shared-only), and it records `scope` in the run output rather than assuming |
| Grounded result | ✅ citations + confidence + grounded flag in the system prompt |
| Retag | ✅ `PATCH /documents/:id/category`, transactional, cascades to chunks |
| Per-employee Knowledge tab | ✅ filtered to that role + shared |
| Memory | ✅ `EmployeeMemory` scoped by `companyId` **and** `employeeId`; `MEMORY_READ`/`MEMORY_WRITE` nodes verify tenancy |
| Feedback → memory | ✅ 👍/👎 + correction → `FACT` memory the runtime recalls |

This is the healthiest subsystem in the product. The one previously-open hole — the
company-wide, unscoped `RETRIEVE` node — is closed, and the handler's own comment explains the
Marketing-employee-reads-HR-salary-band scenario it was closing.

Semantic memory recall is still keyword/recency based (`FACT`s can be crowded past
`RECENT_MEMORY_LIMIT`), which is a documented deferral. P3.

# 21. Audit / Observability Audit

| Signal | Status |
|---|---|
| Audit events (who / what / when / resource / company) | ✅ real, and the chain **verifies** |
| Hash chain + `GET /audit-log/verify` | ✅ returns `valid: true` |
| Audit UI | ✅ `AuditLogSection.tsx` under `/organization` |
| Export | ✅ endpoint — ❌ no UI caller |
| Legal holds | ✅ endpoints — ❌ no UI caller |
| Correlation id through event → run → step | ✅ `correlationId` present on my run |
| Structured logs | ✅ `structured-logger.ts`, `LOG_FORMAT=json` |
| Metrics | ✅ `metrics.registry.ts` + `GET /admin/metrics` |
| Traces | ✅ real OpenTelemetry SDK — **inert without `OTEL_EXPORTER_OTLP_ENDPOINT`, which the preflight never checks** |
| Alerts | ✅ `/admin/alerts` + `ALERT_WEBHOOK_URL` — **its cron is parked, so nothing evaluates them** |
| Realtime execution state | outbox → relay → SSE endpoint, sink registered — **no frontend consumer**, and **no producer in the production engine mode** |

Audit is trustworthy. Observability is *built* but not *operating*: in the current production
config there are no traces (no endpoint), no alert evaluation (parked cron) and no realtime
(no consumer, no producer).

# 22. Lifecycle / Delete / Disable Audit

| Entity | Create | Update | Disable | Delete | What happens to dependents |
|---|---|---|---|---|---|
| Company | ✅ | ✅ | — | ❌ **no endpoint exists** | n/a — a tenant cannot be erased |
| User | ✅ | ✅ | ✅ `DISABLED` kills the session and stops authorising restricted runs | ✅ | ✅ handled |
| Department | ✅ | ✅ | — | ✅ safe, with `GET /:id/dependencies` first | ✅ |
| Team | ✅ | ✅ | — | ✅ | ✅ |
| AI Employee | ✅ | ✅ | ✅ pause | ✅ **soft** (archive); `?hard=true` is OWNER-only and blocked on live dependencies | ✅ credentials no longer destroyed; archived employees stop unlocking product areas |
| Skill / connection | ✅ | ✅ | ✅ disconnect + auto-`markDisconnected` on auth failure | ✅ | ✅ |
| Knowledge doc | ✅ | ✅ retag | — | ✅ | ✅ cascades to chunks |
| Workflow | ✅ | ✅ | ✅ pause | ✅ archive; refuses while runs are in flight | ⚠️ removes the BullMQ repeatable **best-effort only** |
| Workflow version | ✅ | pinned | — | `SetNull` | ✅ running runs keep their pinned version |
| Subscription | ✅ | ✅ | ✅ `PlanGuard` blocks `PAST_DUE`/`CANCELLED` | — | ✅ |
| Credit balance | ✅ | ledger-only | — | — | ✅ lots + consumption preserved |

Two real gaps:

- **No company deletion.** For a product with a privacy policy and a retention engine, there is
  no path to erase a tenant. The retention module prunes 10 data classes on a schedule — whose
  cron is parked.
- **Orphaned repeatables are never reclaimed.** A fresh dev boot logged hundreds of
  `Scheduled workflow <id> not found; skipping`. The fire path is safe (three guards: not
  found, not `ACTIVE`, archived), but the repeatable itself lives for ever in Redis. Over a
  year of tenant churn this is unbounded growth plus permanent log noise.

# 23. Linked vs Broken Service Matrix

| Service / module | Producer | Consumer | Linked | Runtime verified | Browser verified | Status |
|---|---|---|---|---|---|---|
| Auth / tenant | web | API | ✅ | ✅ | ✅ | IMPLEMENTED |
| Product context resolver | API | sidebar, dashboard, workflows, marketing, skills, chooser, onboarding | ✅ | ✅ | ✅ | IMPLEMENTED |
| Onboarding | web wizard | resolver, authz, dashboard | ✅ | ✅ | ✅ | IMPLEMENTED |
| Authorization policy | API | every guard | ✅ | ✅ | ✅ | IMPLEMENTED |
| Employees + chat runtime | web | API → LLM | ✅ | ✅ | ✅ | IMPLEMENTED |
| Knowledge | web | ingest → pgvector → retrieval | ✅ | ✅ | ✅ | IMPLEMENTED |
| Workflow authoring | web builder | API + versions | ✅ | ✅ | ✅ | IMPLEMENTED |
| Workflow execution — **queue mode** | API | BullMQ worker → durable engine | ✅ | ✅ | ✅ | IMPLEMENTED |
| Workflow execution — **production inline mode** | API | **no worker; legacy walker** | ⚠️ | ✅ | ✅ | **DEGRADED BY DESIGN** |
| Approvals gate | engine | `/approvals` | ✅ | ✅ | ✅ | IMPLEMENTED |
| **Approval routing / SLA / escalation** | API | **nothing** | ❌ | ✅ | ❌ | **BACKEND_ONLY** |
| Skills → executor → provider | engine | 11/15 skills | ⚠️ | ✅ | ✅ | PARTIAL |
| **Postiz / Chatwoot / Plane** | API clients | **no deployed engine** | ❌ | ❌ | ❌ | **INFRA ABSENT** |
| Credits ledger | runtime | `/billing/usage` | ✅ | ✅ | ✅ | IMPLEMENTED (flag-gated) |
| **Credits → run/step rollup** | **nothing** | `RunCreditPanel` | ❌ | ✅ (as 0) | ✅ (shows 0) | **BROKEN LINK** |
| **Credits → workflow attribution** | **nothing** | `/billing/usage` Workflow column | ❌ | ✅ (as `—`) | ✅ | **BROKEN LINK** |
| **Employee → run attribution** | **nothing** | nothing | ❌ | — | — | **DEAD COLUMN** |
| Audit | every service | `/organization` | ✅ | ✅ | ✅ | IMPLEMENTED |
| Analytics | usage + executions + runs | dashboard | ✅ | ✅ | ✅ | IMPLEMENTED |
| **HR domain** | API (20 routes) | **nothing** | ❌ | ✅ | ❌ | **BACKEND_ONLY** |
| **Legal holds** | API (3 routes) | **nothing** | ❌ | — | ❌ | **BACKEND_ONLY** |
| **Platform-admin credit ops** | API (5 routes) | **nothing** | ❌ | — | ❌ | **BACKEND_ONLY** |
| **Retention** | API (2 routes) + cron | **nothing; cron parked** | ❌ | — | ❌ | **BACKEND_ONLY + NOT SCHEDULED** |
| **Outbox → SSE → UI** | durable engine only | **no consumer** | ❌ | ✅ (rows written) | ❌ | **BROKEN LINK** |
| **All 18 cron jobs** | `/admin/cron/*` | **no scheduler in production** | ❌ | ✅ (callable by hand) | — | **NOT SCHEDULED** |
| **`AiEmployee.model`** | API + Overview display | **no UI setter, no runtime reader** | ❌ | — | ✅ (shows `—`) | **DEAD** |
| OTel traces | tracing.ts | **no collector configured** | ❌ | — | — | **NOT OPERATING** |

# 24. Browser E2E Results

**Environment:** Chromium (Playwright 1.62), `http://localhost:3200` → `http://localhost:4000`,
real Postgres 16/pgvector on 5433 and real Redis on 6380 in Docker. **No Orlixa API was
mocked.** External providers sandboxed via `SKILL_EXECUTOR=mock`, `LLM_PROVIDER=mock`,
`BILLING_PROVIDER=mock` — the same pinning `browser-e2e.yml` uses.
**Commit:** `00552e4`. **Timestamp:** 2026-09-02 ~23:20 local.

**Command:** `cd platform/e2e && npx playwright test --reporter=list`

```
Running 8 tests using 1 worker

  ok 1 01-auth-journey.spec.ts:12   a visitor can sign up, and lands authenticated (3.0s)
  ok 2 01-auth-journey.spec.ts:21   a registered user can log out and log back in (7.1s)
  ok 3 01-auth-journey.spec.ts:42   a wrong password is rejected and does not authenticate (4.1s)
  ok 4 01-auth-journey.spec.ts:62   an unauthenticated visitor cannot reach an app route (2.5s)
  ok 5 02-security-journey.spec.ts:37   department isolation holds in the browser, both directions (11.6s)
  ok 6 02-security-journey.spec.ts:151  a DISABLED user cannot use the app at all (7.5s)
  ok 7 02-security-journey.spec.ts:209  a MEMBER cannot reach the HR area (4.7s)
  ok 8 03-golden-journey.spec.ts:42    signup → employee → skill → knowledge → workflow → approval → execution → audit (19.6s)

  8 passed (1.1m)
```

**First attempt failed** (2 of 8) with `429 ThrottlerException`, because
`reuseExistingServer` skipped Playwright's own `AUTH_THROTTLE_LIMIT=1000` override and my dev
API was on the production default of 10/min/IP. That is a documented, handled trap — but it
means **a developer running the browser suite against their own dev server gets two red tests
that say nothing about the product.** Worth a `globalSetup` assertion like the existing
`MAIL_ENABLED` one. P3.

### Golden-journey coverage against the 39 requested steps

| Requested | Covered | By |
|---|---|---|
| 1–4 register / verify / login / onboarding | ✅ | browser + API |
| 5–6 industry, departments | ✅ | onboarding step, and I compared two tenants |
| 7 select AI Employee | ✅ | |
| 8 category / subcategory | ❌ | **the concept does not exist** |
| 9–10 relevant data shown, irrelevant hidden | ✅ | resolver diff + browser nav diff |
| 11 hire employee | ✅ | asserted in the roster |
| 12–13 open settings, config persisted | ✅ | read live in Chromium |
| 14–16 change model, save, future runs use it | ❌ | **no UI control; runtime ignores it** |
| 17–18 connect skill, verify | ⚠️ | install + list asserted; real OAuth verify not in the browser suite |
| 19–20 upload knowledge, scoped retrieval | ⚠️ | upload + visibility choice in the browser; scoping proven by API tests |
| 21–26 create workflow, assign employee, configure tool, configure approval, publish, activate | ⚠️ | graph authored via API by design (canvas drag-drop excluded); **approval routing cannot be configured at all** |
| 27 trigger | ✅ | |
| 28 durable execution path | ❌ **in the browser** | proven by me via SQL in queue mode; not reachable in production mode |
| 29 AI Employee attribution | ❌ | `actingEmployeeId` is null |
| 30 authorization | ✅ | |
| 31–32 approval required, approve | ✅ | clicked the real button |
| 33 external action | ⚠️ | mock executor — `stripe` has no real executor at all |
| 34 result | ✅ | exactly-once asserted |
| 35 credit consumption | ❌ **in the browser** | I proved it via SQL; the UI shows `0` |
| 36 audit | ✅ | via API; a UI section does now exist |
| 37–38 analytics, dashboard | ✅ | |
| 39 realtime state | ❌ | polling only; no SSE consumer |

### Requested journeys with no browser coverage at all

- **Two-company data-dependency test** — I ran this at the API layer (two tenants, distinct
  resolver output, 10-endpoint cross-tenant sweep) and manually in one browser session. There
  is **no automated browser test** that logs into two tenants and asserts neither sees the
  other's data.
- **Failure journeys** — none of the 15 requested failure paths (invalid onboarding,
  disconnected skill, approval rejection, approval timeout, insufficient credits, duplicate
  submission, duplicate trigger, refresh mid-run, session expiry, disabled employee) has a
  browser test. I verified insufficient-credits, disabled-user, permission-denial and
  plan-lock by hand.
- **Two users with different roles in the same company** — covered for MEMBER-vs-HR only.

**8 browser tests for a 48-page product is thin.** They are *good* tests — the golden journey
in particular asserts the one thing that matters most, and its comments show it was written
after real failures — but the coverage-to-surface ratio is the weakest part of the QA story.

# 25. Critical Browser Failures

**None.** All 8 passed on a correctly configured stack. The two first-attempt failures were the
rate-limiter interaction described above, not product defects.

### The one genuinely failing test in the repository

`credits-phase2.e2e-spec.ts:728` — *"a stale PENDING reservation is claimed exactly once even
when the sweep runs twice concurrently"*. Fails **1 in 3** in isolation:
`Expected: 1, Received: 2`.

I chased this as a possible financial double-release and it is **not one**. The claim itself is
correct: `updateMany WHERE id=? AND status='PENDING'` under Postgres READ COMMITTED lets exactly
one caller win. The defect is in the **test**: `CreditReservationSweepService.sweep()` is a
**cross-tenant** scan with no `companyId` filter and a batch limit, and the test asserts a
**global** `resultA.swept + resultB.swept === 1` against a shared database. Any other tenant's
lease expiring inside that window inflates the count. The very next lines of the test already
assert the right thing — that *this* reservation ends `RELEASED` with the full amount back.

Fix: drop the global counter assertion, or filter the sweep by company in the test. **P2 test
quality, not a product bug.** It matters because a flaky test in the credit suite is exactly
the test people learn to ignore.

# 26. P0 Findings — BLOCK PRODUCTION

### P0-1 · Account takeover from an email address alone

**Reproduced end to end**, 2026-09-02, against a live API started with `MAIL_ENABLED=false`
(the **default**):

```
register victim (password VictimSecret1)            → 201
POST /auth/forgot-password  {email: victim}         → 201   (unauthenticated)
POST /auth/verify-reset-otp {email, code:"123456"}  → {"token":"47dae1d0…"}
POST /auth/reset-password   {token, "AttackerOwns1"}→ 201
POST /auth/login  {victim, "AttackerOwns1"}         → 201   ← attacker is in
POST /auth/login  {victim, "VictimSecret1"}         → 401   ← victim locked out
```

**Cause.** `mail.service.ts:34-37` — `generateOtp()` returns `DEV_OTP_CODE || '123456'` whenever
`MAIL_ENABLED !== 'true'`. `auth.service.ts:262` uses that same generator for **password
reset**, not just email verification. So the reset code is a public constant.

**Why the existing guard does not cover it.** `require-mail-enabled.ts:14-19` only throws when
`CREDIT_GRANTS_ENABLED === 'true'`:

```ts
if (process.env.NODE_ENV === 'production' &&
    process.env.CREDIT_GRANTS_ENABLED === 'true' &&
    process.env.MAIL_ENABLED !== 'true') { throw … }
```

Credit grants default to `false`. So a production API **boots happily** with every OTP pinned
to `123456`.

**What does mitigate it:** `scripts/preflight-env.mjs:177` hard-fails the GitHub Actions deploy.
That gate is real and it works — but it is *outside* the application, depends on `NODE_ENV`
being present in the pulled Vercel env, and is bypassed entirely by a manual `vercel deploy`,
a different host, or a self-hosted install.

**Fix (one line).** Delete the `CREDIT_GRANTS_ENABLED` condition so the runtime refuses to boot
in production without real mail. Optionally also make `forgotPassword` refuse to issue a reset
when mail is disabled.

---

### P0-2 · No scheduled job runs in production

`apps/api/vercel.json` has **no `crons` key**. All 18 schedules live in
`apps/api/vercel.crons.json`, a sidecar Vercel does not read.
`docs/runbooks/deployment.md:289` states the last production deploy had "**zero** crons in
`vercel.json`; every one was [parked]" — because the account is on the Hobby plan, which
rejects sub-daily crons.

What is therefore dead in production:

| Parked job | Consequence |
|---|---|
| `workflow-schedules` (`* * * * *`) | **no scheduled workflow ever fires** — a customer's "every Monday" automation silently never runs |
| `gmail-poll`, `imap-poll` (`* * * * *`) | **no inbound-email trigger ever fires** — the CV-intake and support-intake products do not work |
| `workflow-watchdog` (`*/5`) | a run that dies mid-flight stays `RUNNING` for ever |
| `approval-sla` (`*/5`) | no escalation, no timeout — an approval whose approver is away blocks its run indefinitely |
| `subscription-credit-renewal` (daily) | **a paying subscription never receives its monthly credits** |
| `credit-reservation-sweep` (`*/5`) | leaked holds keep customer credits reserved for ever |
| `credit-reconciliation`, `credit-finance-rollup` | no finance reporting, no provider-cost reconciliation |
| `data-retention`, `audit-retention`, `hr-retention` | **no GDPR retention enforcement**, contradicting the published privacy policy |
| `alerts` (`*/15`) | nothing evaluates alerts; nobody is paged |
| `campaign-generation` (`* * * * *`) | the brand-new Marketing campaign feature never advances past its first state |
| `marketing-sync`, `marketing-analytics`, `connector-reconcile`, `enterprise-credit-agreement-renewal` | all inert |

The runbook already lists three fixes (Vercel Pro; an external scheduler like cron-job.org or
QStash pointed at `/admin/cron/*` with `CRON_SECRET`; or an always-on worker). **Any one of
them unblocks this.** It is a $20/month decision, not an engineering project — but until it is
made, most of the advertised product does not function in production.

Note also: `CRON_SECRET` unset **disables** the cron routes entirely (by design, correctly), so
this must be set as well as scheduled.

---

### P0-3 · The durable execution engine cannot run in production

`workflow-runtime/engine-mode.ts:84`:

```ts
if (isInlineExecution()) return 'legacy_walk';
```

`deployment.md:128` mandates `WORKFLOW_EXECUTION_MODE=inline`. Therefore **every production run
uses the legacy graph-walker**, and none of the durable machinery — `WorkflowStepAttempt`,
`AttemptLeaseService`, `ReaperService`, `WorkflowRunTimer`, `RunEventOutbox`,
`RetryPolicyService` — executes. No crash recovery, no retry, no DLQ, no timers, a 300-second
ceiling per run, one serverless invocation held per running workflow.

Compounding it: the watchdog that would at least *mark* an abandoned run as failed is a parked
cron (P0-2). So a run interrupted by a function timeout is invisible and permanent.

The code logs an `ERROR` at boot spelling all of this out, which is genuinely good practice and
is the reason I trust the rest of this module. But an honest log is not a working engine.

**Fix:** deploy `apps/api/main.ts` as one always-on worker (Fly/Railway/Render/an EC2 box) with
`QUEUE_WORKERS_ENABLED` unset and `WORKFLOW_EXECUTION_MODE=queue`. `CLAUDE.md` already
documents this as the exit ramp and says it needs no refactor. This also fixes P0-2 for free,
because BullMQ repeatables then drive the scheduled work and the cron routes become unnecessary.

# 27. P1 Findings — REQUIRED BEFORE SCALE

| # | Finding | Evidence |
|---|---|---|
| **P1-1** | **A workflow run is not attributed to an AI Employee.** `actingEmployeeId` has one reference in the repo — the schema. `Workflow` has no employee relation at all. This is the platform's stated #1 differentiator | §13 |
| **P1-2** | **Run credit totals are reported as 0 for billed runs.** `WorkflowRun.totalCreditsCharged` only increments inside a branch that early-returns on the default `creditLimit=null`; `WorkflowStepRun.creditsCharged` has no writer. `RunCreditPanel` shows both. Screenshot evidence | §5 B4, §6 |
| **P1-3** | **Approval routing, SLA and escalation are unreachable.** 6 rule types, multi-level chains, breach sweep and timeout policies exist in DB + service + tests, with zero UI. Every workflow approval is therefore unrouted → OWNER/ADMIN only | §19 |
| **P1-4** | **The entire HR domain has no product surface.** 20 routes, 6 models, PII encryption, retention — no `features/hr` folder exists | §7 |
| **P1-5** | **The credit system is off by default and its flags are not covered by the deploy gate.** Four flags default `false`; none appears in `.env`; `preflight-env.mjs` checks none of them. Shadow mode fails open — zero-balance companies get unlimited free AI with no ledger row | §18 |
| **P1-6** | **`AiEmployee.model` is a dead setting with no UI control.** `LlmCompletionInput` has no `model` field; the Settings panel has no Model input; the Overview tab displays it | §14 |
| **P1-7** | **4 skills have no real executor** (`stripe`, `github`, `hubspot`, `jira`); two have working OAuth so a customer can connect a live account. `stripe.create_payment_link` is `highRisk`, so a human is asked to approve a link that cannot be created | §17 |
| **P1-8** | **3 "keep/harden" engines have no deployment.** Postiz/Chatwoot/Plane: absent from compose, unresolvable hostnames, empty credentials, yet 12 tools labelled `REAL` in the catalog | §17 |
| **P1-9** | **`CreditLedger.workflowId` is never populated**, so the Workflow column on `/billing/usage` is always `—`. Spend cannot be attributed to an automation in the customer's own billing view | §18 |
| **P1-10** | **Browser coverage is 8 tests for 48 pages**, with no automated cross-tenant browser test and no failure-path browser tests | §24 |
| **P1-11** | **Observability is built but not operating**: no `OTEL_EXPORTER_OTLP_ENDPOINT` (and the preflight does not check it), and the `alerts` cron is parked | §21 |

# 28. P2 Findings — IMPORTANT

| # | Finding |
|---|---|
| P2-1 | **Flaky credit test** asserts a global count against a cross-tenant sweep in a shared DB (§25). Fix the assertion; a flaky billing test is a dangerous habit |
| P2-2 | **Billing prices a different model than it calls.** `ai-step.handler.ts:145` uses `process.env.LLM_MODEL ?? 'default'`; the provider uses `config.get('LLM_MODEL') \|\| 'gpt-5.6-terra'`. Unset `LLM_MODEL` ⇒ spend priced at a generic default rate |
| P2-3 | **Orphaned BullMQ repeatables are never reclaimed** — hundreds observed on a fresh boot; unbounded Redis growth plus permanent log noise |
| P2-4 | **No company deletion endpoint** — no tenant-erasure path for a product with a published privacy policy |
| P2-5 | **`AiEmployee.department` is free text, not a FK** to `Department`, so an employee's department cannot be joined to the authorization scope |
| P2-6 | **Hours Saved / Cost Savings use hardcoded constants** (10 min, $25/hr). Honestly labelled `EST.`, but they should not reach a customer-facing report without customer-supplied inputs |
| P2-7 | **`availableWorkflowTemplates` is not relevance-filtered** — both my tenants received all 22 templates. Each carries honest `ready`/`missingEmployeeRoles`, so it is defensible, but a Marketing-only company sees 11 HR templates |
| P2-8 | **Legal holds (3 routes), platform-admin credit ops (5) and retention (2) have no UI**; audit export has an endpoint and no caller |
| P2-9 | **Only 5 of 15 skills have verify-before-connect adapters** — the other 10 mark `CONNECTED` without proving anything works |
| P2-10 | **`poc/workflow-sdk` is 302 MB of dead code** in every clone |
| P2-11 | **`GET /workflows/node-types` is superseded** by `node-definitions` and referenced nowhere |

# 29. P3 Findings — LATER

| # | Finding |
|---|---|
| P3-1 | `/assist` renders its whole interface for a plan that cannot use it; the correct upsell only appears after the click |
| P3-2 | Browser suite rate-limits itself against a developer's own dev server; add a `globalSetup` assertion for `AUTH_THROTTLE_LIMIT` like the existing `MAIL_ENABLED` one |
| P3-3 | `RunEventOutbox` → SSE has no frontend consumer; either wire it or stop writing 6 rows per run |
| P3-4 | Employee persona/config is read live mid-run, so a long run can straddle two configurations (permissions arguably *should* be live; persona arguably should be snapshotted) |
| P3-5 | Semantic memory recall is still recency-based; `FACT`s can be crowded out |
| P3-6 | `yopmail.com` — the repo's own default fake-email domain — is on the disposable blocklist, so every internal demo tenant gets zero free credits |
| P3-7 | No support-conversation UI; the Chatwoot models are reachable only through the handoff queue |
| P3-8 | `AI_STEP` and `AI_EMPLOYEE_STEP` both exist; `AI_STEP` is "banned" by doc 27 but still fully wired, including its own separate credit path |

# 30. Additional Services Analysis

| Service | Classification | Note |
|---|---|---|
| Postgres + pgvector | **CORE** | |
| Redis / BullMQ | **CORE** | and the reason a worker host is needed |
| MinIO / S3 | **SUPPORTING** | `local` default is fine for now |
| OpenTelemetry + Jaeger + Prometheus + Grafana | **REQUIRED at scale** | compose profile exists, nothing configured in production |
| Stripe | **REQUIRED** for revenue | `BILLING_PROVIDER=mock` today |
| SMTP (Hostinger) | **CORE** | and the P0-1 dependency |
| OpenAI / Anthropic | **CORE** | real parity behind one seam — genuinely good work |
| Postiz | **OPTIONAL** | code done, not deployed |
| Chatwoot | **OPTIONAL** | code done, not deployed |
| Plane | **OPTIONAL** | code done, not deployed |
| n8n, Metabase, Meilisearch, Novu, Listmonk, Keycloak | **CORRECTLY PAUSED** | no code, no dependency, no drift — the engine freeze held |
| Vercel Workflow SDK | **CORRECTLY REJECTED** | evaluated, verdict recorded, PoC should now be deleted |

# 31. Irrelevant / Duplicate Services

| Item | Verdict |
|---|---|
| `poc/workflow-sdk` (302 MB) | **DELETE** — decision made, artefact left behind |
| `GET /workflows/node-types` | **DELETE** — superseded |
| `AI_STEP` node | **DEPRECATE ON A DATE** — a second, separately-credit-wired LLM node the docs already ban |
| Two execution engines | **CONVERGE** — pick the durable one, keep legacy only as a documented rollback flag |
| Marketplace vs workflow-templates | **ALREADY RESOLVED** — no action |
| Duplicate plan/role checks | **ALREADY RESOLVED** by the resolver — no action |

No duplicate event system, no duplicate billing logic, no duplicate authorization logic. The
consolidation work claimed by earlier phases genuinely happened.

# 32. Exact Completion Calculations

### 32.1 Product Concept Completion

| Capability | Weight | Completion | Weighted |
|---|---:|---:|---:|
| Company configuration drives the product | 10 | 85% | 8.50 |
| Onboarding captures the organisation | 8 | 70% | 5.60 |
| AI Employee as a rich entity | 10 | 75% | 7.50 |
| AI Employee identity persists into execution | 10 | 40% | 4.00 |
| Per-employee model / config drives runtime | 6 | 10% | 0.60 |
| Skills & tools are executable | 10 | 60% | 6.00 |
| Knowledge: upload → scope → ground | 8 | 90% | 7.20 |
| Memory | 5 | 80% | 4.00 |
| Workflows: author → publish → version → run | 10 | 85% | 8.50 |
| Approvals / human-in-the-loop | 9 | 55% | 4.95 |
| Permissions & authorization | 9 | 85% | 7.65 |
| Credits & usage | 8 | 65% | 5.20 |
| KPIs & per-employee analytics | 6 | 70% | 4.20 |
| Execution history & audit | 6 | 85% | 5.10 |
| HR + Support domain surfaces | 8 | 20% | 1.60 |
| Marketing domain surface | 5 | 70% | 3.50 |
| **Total** | **128** | | **84.10** |

**84.10 / 128 = 65.7% → 66%**

### 32.2 Production Readiness *(scored in the actual deployment shape)*

| Dimension | Weight | Completion | Weighted |
|---|---:|---:|---:|
| Authentication & authorization correctness | 10 | 60% | 6.00 |
| Tenant isolation | 10 | 95% | 9.50 |
| Secrets & credential handling | 8 | 85% | 6.80 |
| **Scheduled work actually runs** | 10 | **0%** | 0.00 |
| **Durable execution in production** | 10 | **15%** | 1.50 |
| Crash / retry / recovery | 8 | 20% | 1.60 |
| Billing correctness **and enablement** | 9 | 45% | 4.05 |
| Observability operating | 7 | 55% | 3.85 |
| Backup & disaster recovery | 6 | 70% | 4.20 |
| Data retention / GDPR | 6 | 30% | 1.80 |
| CI, tests, release gates | 8 | 85% | 6.80 |
| Rate limiting & abuse controls | 5 | 75% | 3.75 |
| Error truthfulness (no fake success) | 7 | 75% | 5.25 |
| Realtime / run visibility | 4 | 40% | 1.60 |
| **Total** | **108** | | **56.70** |

**56.70 / 108 = 52.5% → 52%**

*If the same codebase ran in `queue` mode on an always-on worker with crons scheduled and the
credit flags on, the same table scores ≈ 78%. The gap between 52% and 78% is configuration and
hosting, not code.* That is the most useful single sentence in this report.

### 32.3 Architectural Integration

| Link | Weight | Completion | Weighted |
|---|---:|---:|---:|
| Web → API (routes actually consumed) | 8 | 80% | 6.40 |
| API → authorization | 9 | 95% | 8.55 |
| API → database | 9 | 95% | 8.55 |
| API → queue → worker | 8 | 50% | 4.00 |
| Runtime → skills → external provider | 8 | 60% | 4.80 |
| Runtime → credit ledger | 8 | 70% | 5.60 |
| Runtime → audit | 7 | 85% | 5.95 |
| Runtime → analytics | 7 | 75% | 5.25 |
| Runtime → AI Employee identity | 8 | 45% | 3.60 |
| Product context → UI | 8 | 85% | 6.80 |
| Onboarding → downstream consumers | 7 | 65% | 4.55 |
| Approval routing → UI | 6 | 10% | 0.60 |
| Outbox → SSE → UI | 4 | 25% | 1.00 |
| Observability producers → collectors | 5 | 40% | 2.00 |
| Cron producers → scheduler | 8 | 5% | 0.40 |
| **Total** | **110** | | **68.05** |

**68.05 / 110 = 61.9% → 62%**

# 33. Kill-Critic Decisions

**1. What should NOT be built**
- No `ProductContextEngine`. It exists, it works, and I verified it produces different output
  for different tenants. Building a second one would be the worst decision available.
- No new engines. Not one. n8n, Metabase, Meilisearch, Novu, Listmonk, Keycloak stay paused
  until the core is live. The freeze held; keep it.
- No Kafka, no service mesh, no multi-region, no read replicas.
- No workflow-runtime rewrite. The durable engine is good. It just needs a host.
- No AI Employee "category/subcategory" taxonomy. Eight roles are enough until customers ask.
- No realtime WebSocket layer. 1-second polling is fine and already shipped.

**2. What should be removed**
- `poc/workflow-sdk` — 302 MB, decision already made.
- `GET /workflows/node-types` — superseded.
- `AI_STEP` — on a date, with a migration for existing graphs.
- One of the two execution engines, once a worker host exists.

**3. What should be simplified**
- Credit enablement: four flags plus a per-company allowlist is right for a canary and wrong
  for a default. Pick a launch configuration and put it in the preflight.
- The cron story: an always-on worker deletes 18 HTTP cron endpoints and their shared secret.

**4. What is duplicate** — two execution engines; two LLM node types; two credit-reservation
call sites with slightly different pricing inputs. Nothing else.

**5. What is premature** — the platform-operator finance suite (rollup, reconciliation,
enterprise agreements, provider invoices) is a finance back office for revenue that is not yet
being collected. Correct to have built the ledger; the reporting layer could have waited.
Legal holds likewise.

**6. Useful but can wait** — HR UI, approval-routing UI, Postiz/Chatwoot/Plane deployment,
real Stripe/HubSpot/Jira/GitHub executors, OTel collector, realtime SSE, semantic memory.

**7. Genuinely mandatory before a paying customer** — exactly the three P0s and P1-1, P1-2,
P1-5. Nothing else on this list blocks revenue.

# 34. What Is Actually Complete

Multi-tenant isolation · role/department authorization at both layers · capability resolution
that genuinely differentiates tenants · department lifecycle with dependency checks ·
employee soft-delete that no longer destroys credentials · employee tool permissions enforced
at execution and not overridable by approval · the high-risk approval gate with exactly-once
execution · knowledge upload → ingest → role-scoped retrieval → grounded answer, in chat
**and** in workflows · employee memory with feedback learning · workflow authoring, validation,
versioning, readiness and publish · the credit grant → reserve → settle → release loop, with
per-rate historical explainability · credit enforcement when armed · hash-chained audit with a
verifying endpoint and a UI · per-employee analytics and a configuration-driven dashboard ·
honest labelling of simulated integrations and estimated metrics · the production config
preflight gate · 1,015 unit tests, 745 API e2e tests, 8 browser tests, all green.

# 35. What Is Still Missing

Scheduled execution in production · durable execution in production · crash recovery ·
run-level AI Employee attribution · truthful run-level credit reporting · approval routing UI ·
HR UI · support-conversation UI · per-employee model selection (control *and* runtime) ·
real executors for stripe/github/hubspot/jira · deployed Postiz/Chatwoot/Plane · an OTel
collector · alert evaluation · retention execution · tenant deletion · realtime run state ·
browser coverage for cross-tenant and failure paths · AI Employee category/subcategory (if it
is actually wanted).

# 36. Recommended Implementation Sequence

See the single ordered roadmap below.

# 37. FINAL PRODUCTION GATE

## ❌ DO NOT SHIP TO A PAYING CUSTOMER YET

Three unconditional blockers:

1. **P0-1** — account takeover from an email address alone, reachable at runtime.
2. **P0-2** — no scheduled job runs, so scheduled workflows, inbound email, SLA escalation,
   retention, alerts and subscription credit renewal all silently do nothing.
3. **P0-3** — no durable execution or crash recovery in the production deployment shape.

### The gate, restated as a checklist

- [ ] `requireMailEnabledInProduction()` throws on `MAIL_ENABLED != true` regardless of any
      other flag; re-run the takeover script and get a rejection.
- [ ] An always-on API worker is deployed with `QUEUE_WORKERS_ENABLED` set and
      `WORKFLOW_EXECUTION_MODE=queue`; `/admin/health` reports `isDurableActive: true`.
- [ ] A scheduled workflow fires on time in production, and the fire is visible in `/runs`.
- [ ] An abandoned run is marked failed by the watchdog within 5 minutes.
- [ ] `WorkflowRun.actingEmployeeId` is populated on every run and shown in the UI.
- [ ] A billed run shows its real credit cost on `/runs/[runId]`, not `0`.
- [ ] `preflight-env.mjs` fails the deploy if the credit flags do not match the intended
      launch configuration.
- [ ] Skills with no real executor are hidden or clearly marked "preview" before OAuth is
      offered.
- [ ] The flaky credit test is fixed, and both engine modes are green.
- [ ] Browser tests exist for: two tenants not seeing each other, insufficient credits,
      approval rejection, and a disabled employee.

---

# FINAL IMPLEMENTATION ROADMAP

One ordered list. Do them in this order.

### P0-A · Close the password-reset bypass
- **Problem** — `generateOtp()` returns `123456` when `MAIL_ENABLED != 'true'`, and that
  generator serves password reset. The runtime boot guard only fires when
  `CREDIT_GRANTS_ENABLED=true`.
- **Business impact** — any account takeable over from its email address. Company-ending.
- **Architectural impact** — none. One condition removed.
- **Files** — `apps/api/src/common/config/require-mail-enabled.ts`,
  `apps/api/src/modules/auth/auth.service.ts:262`,
  `apps/api/src/modules/mail/mail.service.ts:34`.
- **Depends on** — nothing.
- **Test** — unit: guard throws with grants off; e2e: `verify-reset-otp` with `123456` is
  rejected when mail is enabled.
- **Browser E2E** — no.
- **Complexity** — trivial (< 1 hour).
- **Done when** — the takeover script in §26 fails at step 3, and the API refuses to boot in
  production without real mail.

### P0-B · Deploy an always-on worker and switch to queue mode
- **Problem** — `WORKFLOW_EXECUTION_MODE=inline` forces `legacy_walk`; no worker exists on
  Vercel, so the durable engine, the reaper, leases, timers and the outbox never run.
- **Business impact** — no crash recovery. A run interrupted by a 300 s function timeout is
  lost silently and, with the watchdog parked, is not even marked failed.
- **Architectural impact** — **collapses two production execution paths into one.** This is
  the single highest-leverage change in the repository.
- **Files** — hosting config only; `CLAUDE.md` states the exit ramp needs no code change.
  Verify via `engine-mode.ts` boot log and `/admin/health`.
- **Depends on** — a host that can run a persistent process (Fly / Railway / Render / EC2).
- **Test** — full API e2e in `queue` + `state_machine`; kill the worker mid-run and confirm the
  reaper recovers it.
- **Browser E2E** — yes: trigger a run, confirm completion and per-step attempts.
- **Complexity** — medium (1–2 days, mostly ops).
- **Done when** — `/admin/health` reports `isDurableActive: true` and a killed worker's run
  finishes anyway.

### P0-C · Make scheduled work actually run
- **Problem** — 18 cron definitions parked in `vercel.crons.json`, which Vercel does not read.
- **Business impact** — scheduled workflows, inbound email triggers, SLA escalation, retention,
  alerts and subscription credit renewal all silently do nothing. Most of the advertised
  product.
- **Architectural impact** — largely **solved for free by P0-B**: BullMQ repeatables drive this
  work in queue mode. Keep `/admin/cron/*` only for jobs the worker does not own.
- **Files** — `apps/api/vercel.crons.json`, `apps/api/vercel.json`,
  `apps/api/src/modules/admin/cron.controller.ts`, `cron-schedule-coverage.spec.ts`.
- **Depends on** — P0-B (or a Vercel Pro upgrade / external scheduler as the fallback).
- **Test** — extend `cron-schedule-coverage.spec.ts` to assert every job has a **live** driver,
  not merely a parked entry.
- **Browser E2E** — yes: a schedule set in the UI produces a run without human action.
- **Complexity** — small after P0-B; trivial-but-paid without it.
- **Done when** — a workflow scheduled for "in 5 minutes" runs in production unattended.

### P1-A · Attribute every run to an AI Employee
- **Problem** — `actingEmployeeId` is written by nothing and read by nothing; `Workflow` has no
  employee relation.
- **Business impact** — the platform's headline claim is untrue. "Show me what Emma did this
  week" cannot be answered.
- **Architectural impact** — makes the AI Employee the primary abstraction in the data model,
  not just in the marketing.
- **Files** — `workflows.service.ts` (`enqueueRun`), `run-state-writer.service.ts`,
  `workflows.mapper.ts`, `packages/types/src/index.ts`, `schema.prisma` (add the FK + index),
  `apps/web/src/app/(app)/runs/*`, employee detail page.
- **Depends on** — nothing.
- **Test** — e2e: a run with an `AI_EMPLOYEE_STEP` has `actingEmployeeId` set; analytics filters
  by it.
- **Browser E2E** — yes: the run list shows which employee ran it; the employee page lists its
  runs.
- **Complexity** — medium (2–3 days).
- **Done when** — every new run row has a non-null `actingEmployeeId` derived from its graph,
  and the UI shows it.

### P1-B · Tell the truth about run credits
- **Problem** — `WorkflowRun.totalCreditsCharged` only increments inside a branch that
  early-returns by default; `WorkflowStepRun.creditsCharged` has no writer. `RunCreditPanel`
  shows `0` and "No billable steps" for a run that was billed.
- **Business impact** — a customer-visible billing misstatement. Fatal to trust the first time
  someone reconciles their bill.
- **Architectural impact** — small: write the rollup on settle, unconditionally.
- **Files** — `credits/credit-reservation.service.ts` (settle path),
  `credits/credit-limits.service.ts:196-205`, `run-state-writer.service.ts`,
  `workflows.mapper.ts`, `RunCreditPanel.tsx`.
- **Depends on** — nothing (do it with P1-C).
- **Test** — e2e: after a billed run, `totalCreditsCharged` equals the sum of ledger DEBITs and
  each billable step carries its own figure.
- **Browser E2E** — yes: `/runs/[runId]` shows the real number.
- **Complexity** — small (1 day).
- **Done when** — the run in §5 B4 shows `1`, not `0`.

### P1-C · Decide and gate the launch billing configuration
- **Problem** — four credit flags default off, none set in `.env`, none checked by the
  preflight. Shadow mode fails open, so a zero-balance company gets unlimited free AI with no
  ledger row. `CreditLedger.workflowId` is never populated.
- **Business impact** — no revenue, and no record of the cost of giving it away.
- **Architectural impact** — none; the loop is correct.
- **Files** — `common/config/credit-config.ts`, `scripts/preflight-env.mjs`,
  `credits/credit-reservation.service.ts` (set `workflowId`), Vercel env.
- **Depends on** — a founder decision on grant size, credits-per-USD and safety margin (the
  `// FOUNDER-PENDING` markers already name every open number).
- **Test** — preflight unit tests for each flag; e2e that a zero-balance company is blocked.
- **Browser E2E** — yes: a company that runs out of credits sees a truthful message and an
  add-credits path.
- **Complexity** — small technically; blocked on a pricing decision.
- **Done when** — the preflight fails a deploy whose credit flags disagree with the intended
  launch configuration.

### P1-D · Ship the approval-routing UI
- **Problem** — 6 rule types, multi-level chains, SLA and escalation exist with zero UI, so
  every approval is unrouted and only owners/admins can decide.
- **Business impact** — the enterprise story ("your manager approves, escalating after 4
  hours") cannot be configured by a customer.
- **Architectural impact** — none; render the `routing` config key the node catalog already
  declares.
- **Files** — `apps/web/src/features/workflows/components/NodeEditor.tsx:255`,
  new routing editor, `features/approvals/*`; backend already complete.
- **Depends on** — P0-C for the SLA sweep to have any effect.
- **Test** — e2e already covers routing + SLA; add web unit tests for the editor.
- **Browser E2E** — yes: route to a department, breach the SLA, watch it escalate.
- **Complexity** — medium (3–4 days).
- **Done when** — a customer can route an approval to a named user, a department and the
  employee's manager, with a timeout policy, from the builder.

### P1-E · Stop offering skills that cannot act
- **Problem** — `stripe`, `github`, `hubspot`, `jira` have no real executor; two have working
  OAuth, so a customer can authorise a live account and see `CONNECTED`.
- **Business impact** — the highest-trust moment in the product (granting access to a CRM)
  followed by nothing working.
- **Architectural impact** — none; the `executionSupport` data already exists.
- **Files** — `skills/catalog.ts`, `features/skills/components/SkillCatalog.tsx`,
  `skills/oauth/oauth.controller.ts`.
- **Depends on** — nothing.
- **Test** — unit: a `SIMULATED` skill cannot begin OAuth; UI test for the preview badge.
- **Browser E2E** — yes: a `SIMULATED` skill is visibly marked and cannot be connected.
- **Complexity** — small (1 day to gate; weeks to write four real executors — gate first).
- **Done when** — no customer can complete OAuth against a provider Orlixa cannot write to.

### P1-F · Per-employee model selection, end to end
- **Problem** — `AiEmployee.model` has no UI control and no runtime reader.
- **Business impact** — "choose the model for this employee" is an advertised capability that
  does not exist.
- **Architectural impact** — add optional `model` to `LlmCompletionInput`; thread it from the
  employee; keep `LLM_MODEL` as the fallback. Also fixes P2-2's pricing mismatch, because the
  pricer and the caller would finally read the same value.
- **Files** — `employees/llm/llm.provider.ts`, both provider implementations,
  `runtime/agent-runtime.service.ts`, `nodes/ai-step.handler.ts`,
  `features/employees/components/EmployeeSettings.tsx`.
- **Depends on** — nothing.
- **Test** — unit: a per-employee model reaches the provider and the pricer; e2e: two employees
  on different models bill at different rates.
- **Browser E2E** — yes: change the model, save, run, confirm the run used it.
- **Complexity** — medium (2 days).
- **Done when** — the Settings panel has a Model control whose value demonstrably changes the
  model called and the rate charged.

### P1-G · Raise browser coverage to the risk
- **Problem** — 8 tests for 48 pages; no automated cross-tenant browser test; no failure-path
  browser tests.
- **Business impact** — the failures customers meet first are the least tested.
- **Architectural impact** — none.
- **Files** — `e2e/tests/04-tenant-isolation.spec.ts`, `05-failure-journeys.spec.ts`;
  add the `AUTH_THROTTLE_LIMIT` assertion to `e2e/global-setup.ts`.
- **Depends on** — P1-B and P1-C for the credit assertions to be meaningful.
- **Test** — the tests are the deliverable.
- **Browser E2E** — yes, by definition.
- **Complexity** — medium (3–4 days).
- **Done when** — two tenants are proven isolated in a browser, and insufficient-credits,
  approval-rejection, disabled-employee and session-expiry all show truthful states.

### P2 · Cleanup and correctness, in this order
1. Fix the flaky credit sweep test (§25) — half a day, and it restores trust in the suite.
2. Delete `poc/workflow-sdk` and `GET /workflows/node-types`.
3. Reclaim orphaned BullMQ repeatables when a workflow is deleted or archived.
4. Configure an OTel collector and check `OTEL_EXPORTER_OTLP_ENDPOINT` in the preflight.
5. Add `AiEmployee.departmentId` as a real FK.
6. Replace the hardcoded Hours-Saved / Cost-Savings constants with customer-supplied inputs.
7. Add a company-deletion path, and prove the retention sweep runs.
8. Add verify-before-connect adapters for the remaining 10 skills.
9. Ship the HR UI (the largest remaining backend-only domain) — then decide whether Postiz,
   Chatwoot and Plane get deployed or shelved.
