# ORLIXA — FINAL DEEP PRODUCTION AUDIT (v2, re-audit)

**Date:** 2026-09-03
**Commit:** `d749900` + this audit's one fix (a test-noise silence, §0.3). Working tree otherwise clean.
**Supersedes:** [v1, 2026-09-02](ORLIXA_FINAL_DEEP_PRODUCTION_AUDIT_v1_2026-09-02.md) at `00552e4`,
preserved verbatim as history. Three remediation waves (`7c11e95`, `9b20814`, `83162a8`) shipped
between v1 and this document.
**Companion:** [current-system-inventory.md](current-system-inventory.md).

## How this re-audit was done

**Rule 1 of the brief applies to my own previous report.** Nothing v1 said, and nothing the three
remediation commits claim, was carried forward on trust. Every "closed" item was re-tested from the
outside — a fresh tenant, live HTTP calls, SQL against the live database, a browser — at the current
commit, and every "still open" item was re-checked against current code. Where I had earlier
over-credited something, this document says so (§0.2).

### What I actually ran, today

| Check | Result |
|---|---|
| API unit suite | **105 suites / 1058 tests pass** |
| API e2e, durable engine (`state_machine`) | **744 / 745** — one intermittent, §25 |
| API e2e, legacy engine (`legacy_walk`, the deployed path) | **745 / 745** |
| Playwright, own servers, quiet machine | **13 / 13 pass** (2.5 m) |
| Playwright, under concurrent load | 12 / 13 — `ECONNREFUSED ::1:4000`, not an assertion, §25 |
| Typecheck, API + web | clean |
| Migrations on disk / applied | 66 / 66 |
| Production boot with `MAIL_ENABLED` unset (fresh process) | **refused**, with the reason |
| `platform-sweeps` repeatables in Redis, queue mode | **all 8 present** |
| `GET /admin/runtime`, queue mode | `durableExecution: true`, 0 warnings |
| Fresh run: attribution / rollup / ledger / model pricing | `actingEmployeeName=Rhea Reaudit`, `totalCreditsCharged=1`, step `1`, ledger `workflowId` set, priced against **the employee's** model |
| Routed approval, end to end (**never tested before v2**) | routed to DEPARTMENT, owner **403**, member sees it under `assignedToMe`, approves → run **COMPLETED** |
| SLA escalation, end to end (**never run outside jest before v2**) | backdated due → sweep → tier 0 `ESCALATED`, tier 1 `ANY_ADMIN` → owner approves → **COMPLETED** |
| OAuth gate | hubspot **refused (400)**, gmail unaffected (200) |
| HR area for a Marketing tenant / a member | absent from areas; member **403** on `/hr/staff` and `/admin/runtime` |
| Cross-tenant sweep vs an earlier tenant's ids | 404 / 404 / 404 |
| Preflight, production, billing off | 4 warnings, 0 failures (intended) |
| Preflight, the unmitigated P0-1 config | hard **FAIL** |

### 0.1 A fact that changes nothing but needed checking

Ten `orlixa-*` containers are running on this machine, including `orlixa-worker` and `orlixa-api`.
They are `aimarket-*` images running `/repo/apps/api/dist/main.js` — **a different project**. No
Orlixa worker is deployed. P0-B and P0-C remain open exactly as v1 described them.

### 0.2 Correcting my own remediation numbers

The Wave-3 commit and v1's delta section reported **78 / 71 / 83**. Recomputed strictly at the
current commit, in the deployment shape that is actually deployed, the honest numbers are
**80 / 61 / 78**. Product Concept went *up* on re-examination (routed approvals and escalation are
now proven end to end). Production Readiness and Architectural Integration were **over-credited**:
I gave "scheduled work runs" 50% for the drivers existing. In the shape that is deployed, nothing
scheduled runs. Code that is ready but not deployed earns the same 15% the durable engine earns for
the same reason. The gap between 61% and the ~89% ceiling is the same three infrastructure decisions
it was in v1.

### 0.3 The one change made during this audit

`require-mail-enabled.ts` — the warning I added in Wave 1 fired once per Nest boot under
`NODE_ENV=test`, which is ~100 times per e2e run. It is now silent under `test` only. Spec updated
(9 tests). No behaviour change in any other environment.

---

# Executive Verdict

> ### Product Concept Completion: **80%**
> ### Production Readiness: **61%**
> ### Architectural Integration: **78%**
>
> ## Overall Verdict: **C — CORRECT ARCHITECTURE, MAJOR PRODUCTION GAPS REMAIN**
>
> *Closer to D than v1 was, and the remaining gap is now almost entirely deployment shape rather
> than code.*

### The one-paragraph version

Orlixa is on the right path and the three waves closed the concept gaps v1 named: a run is now
attributed to the AI Employee that performed it; the credit a run consumed is what the run page
shows; a per-employee model reaches the request *and* the bill; approvals can be routed to a
department, a team, a named person or the employee's manager from the product, and the escalation
chain provably rescues a stuck run; the HR domain has a front door; skills that cannot act cannot
take a customer's credentials; and the deploy gate now watches billing and observability. Every one
of those I re-proved today from outside the code.

What has *not* changed is the thing code cannot change: the documented production shape is Vercel
serverless with `WORKFLOW_EXECUTION_MODE=inline`, which forces every run onto the legacy walker and
leaves all 18 scheduled jobs parked. Until an always-on worker exists — approved, not yet deployed —
production has no durable execution, no crash recovery, no scheduled workflows, no inbound-email
triggers, no SLA escalation in practice, no retention, and no monthly credit renewal. `GET
/admin/runtime` now tells the truth about this in one field. The credit system is correct and
proven, and still off by default pending a pricing decision the preflight now refuses to let anyone
forget.

---

# 1. What Orlixa Was Intended To Be

Unchanged from v1: a SaaS where a company hires AI Employees that behave like digital staff, and
where the company's configuration — industry, departments, hired roles, plan, user role — drives
what the product shows and does. The AI Employee is the primary abstraction; a workflow is
something an employee does. Founder decision 2026-09-03: **no AI-Employee category/subcategory
taxonomy** — eight roles are the model.

# 2. Current Architecture

pnpm/Turborepo monorepo; NestJS + Prisma + Postgres/pgvector + BullMQ/Redis API; Next.js web;
shared `@vaep/types` contract with a compile-time schema/DTO drift guard. 82 models, 66 migrations,
41 modules, 217 routes, 49 pages, 16 workers, 18 cron endpoints (all 18 now also have a worker-mode
repeatable). The capability resolver (`product-context`) is real, pure, and consumed by seven UI
surfaces; **no new abstraction was needed and none was added.**

Two execution engines still coexist. Which one runs is decided by `WORKFLOW_EXECUTION_MODE`:
`queue` → durable state machine; `inline` → legacy walker, unconditionally. The deployed
configuration is `inline`.

# 3. Completed

All v1 items still hold (re-verified today: tenant isolation, role enforcement, HR PII ciphertext at
rest, capability resolution differentiating tenants, department-driven scoping, employee tool
permissions surviving human approval, high-risk gate exactly-once, knowledge scoping in chat and
workflow, hash-chained audit, versioning/readiness/publish, honest `SIMULATED`/`EST.` labels, CI
preflight). Newly complete, each with today's evidence in the table above:

| Capability | Evidence |
|---|---|
| **Run → AI Employee attribution** | DTO carries `actingEmployeeId/Name`; FK + index; historical runs backfilled; shown in runs table and run page |
| **Truthful run credits** | `totalCreditsCharged=1`, step `creditsCharged=1` on a run that debited 1; ledger rows carry `workflowId` |
| **Per-employee model → request and price** | ledger rate row `claude-sonnet-5` for an employee configured that way, env default ignored |
| **Approval routing from the product** | graph `routing` → `ApprovalRequest` (DEPARTMENT, target, SLA, due, ESCALATE) → `canDecide` → `assignedToMe` → approve → resume |
| **SLA escalation** | breach → tier-0 ESCALATED, tier-1 ANY_ADMIN pending → decided → run resumes |
| **Production refuses to boot without real mail** | fresh process dies with the reason |
| **All 18 sweeps have a worker-mode driver** | 8 `platform-sweeps` schedulers present in Redis; coverage spec asserts both shapes |
| **Runtime truth surface** | `/admin/runtime` reports the engine actually in force |
| **HR front door** | `/hr` roster / time off / onboarding, resolver-gated, admin-only, member 403 |
| **Credential gate for fake-capable skills** | hubspot authorize 400 with reason; gmail 200 |
| **Deploy gate covers billing + observability** | 4 warnings with billing off; hard-fail on incoherent combinations |
| **Browser coverage 13** | cross-tenant + 4 failure journeys added |

# 4. Partially Implemented

| Capability | Works | Does not |
|---|---|---|
| Scheduled work | every job has a driver in both shapes | nothing schedules them in the deployed shape |
| Durable execution | proven in `queue` mode (attempts, outbox, leases) | forced off by `inline`; production runs legacy |
| Credit system | grant → reserve → settle → release → rollups → attribution, all proven | four flags default off; no pricing decision |
| HR domain | roster, leave, onboarding | documents, reviews, attendance: endpoints only |
| Skills | 11/15 have a real executor; 4 gated | 4 have none; 3 engines undeployed |
| Observability | OTel SDK, metrics, structured logs, alert rules | no collector configured; alerts cron parked in prod |
| Retention / GDPR | 10 data classes, legal hold, proven restore | cron parked in prod; no tenant deletion |
| Onboarding capture | industry, size, goals, departments, employees | skills, connections, knowledge, model not captured at onboarding (settable later) |
| Realtime | outbox → relay → SSE endpoint | no frontend consumer; no producer in inline mode |

# 5. Broken

| # | Item | Status vs v1 |
|---|---|---|
| B1 | Password reset accepts `123456` when mail is off | **FIXED** — production refuses to boot |
| B2 | No scheduled job runs in production | **OPEN** — deployment shape; drivers now exist |
| B3 | Durable engine cannot run in production | **OPEN** — deployment shape |
| B4 | Run page reports 0 credits for a billed run | **FIXED** — verified today |
| B5 | Orphaned BullMQ repeatables fire forever | **OPEN** (P2) |

# 6. Disconnected

| Item | v1 | Now |
|---|---|---|
| `WorkflowRun.actingEmployeeId` | DEAD (1 ref) | **LIVE** — 32 refs, FK, index, backfilled |
| `WorkflowStepRun.creditsCharged` | DEAD | **LIVE** |
| `WorkflowRun.totalCreditsCharged` | effectively dead | **LIVE** for uncapped runs; capped runs keep reservation-time accounting |
| `CreditLedger.workflowId` | DEAD | **LIVE** |
| `AiEmployee.model` | triple-disconnected | **LIVE** — control, request, price |
| APPROVAL node `routing` | not rendered | **LIVE** — editor + badges + inbox |
| `EngineModeService.isDurableActive()` | never called | **LIVE** — `/admin/runtime` |
| `GET /workflows/runs/:id/events` (SSE) | no consumer | still no consumer (P3) |
| `AiEmployee.department` | free text, no FK | unchanged (P2) |

# 7. Backend-Only

| Domain | v1 | Now |
|---|---|---|
| HR | 20 routes, no UI | 12 consumed (staff, leave, onboarding); **8 still endpoint-only** (documents 3, reviews 3, attendance 2) |
| Legal holds | 3 routes | unchanged |
| Platform-operator credit ops | 5 routes | unchanged (internal tooling; acceptable) |
| Retention preview / run-now | 2 routes | unchanged |
| Approval routing / SLA | full engine, no UI | **now has UI** |
| Support conversations | model only | unchanged (handoff queue has UI) |

# 8. Frontend-Only

None found. The shared-types drift guard caught every DTO change I made, including one it caught
*against me* (`ownerType` typed as `string` let a wrong value reach a runtime 400; it is now the
union on both sides).

# 9. Mocked / Fake Success

| Item | Status |
|---|---|
| Run page "Credits 0" for a billed run | **FIXED** |
| 4 skills with no executor offered live credentials | **GATED** — OAuth and API-key handover refused; still `SIMULATED` |
| 3 engines labelled `REAL` with no deployment | **OPEN** — code-real, infra-absent |
| Shadow-mode credits fail open | **OPEN by design** until flags are on; preflight now warns with the consequence |
| Pricing against the wrong model | **FIXED** — one resolved value for request and price |
| `/assist` renders fully for a plan that cannot use it | OPEN (P3) — the post-click message is truthful |

# 10. Dead / Irrelevant Services

| Item | Verdict |
|---|---|
| `poc/workflow-sdk` (302 MB, 26 tracked files) | **REMOVED**; 42 KB verdict report kept |
| `GET /workflows/node-types` | **KEPT — v1 was wrong.** Its consumer is `workflow-p2-nodes.e2e-spec.ts`, asserting the runtime registry, which the static `node-definitions` catalog cannot do |
| `RunEventOutbox` + relay + SSE | inert in inline mode, unconsumed in queue mode (P3) |
| `AI_STEP` node | still fully wired alongside `AI_EMPLOYEE_STEP`; docs ban it; deprecate on a date (P3) |

# 11. Role / Department Dependency Audit

Every v1 row re-verified today; two new rows.

| Test | Result |
|---|---|
| Marketing tenant → `MARKETING` area, no `HR` area | ✅ |
| HR tenant → `HR` + `INTERVIEW_SCHEDULING`, no `MARKETING` | ✅ (yesterday's tenants, re-checked) |
| Member → `/hr/*`, `/admin/runtime` | 403 |
| Member → HR area in `product-context` | absent (and the API still enforces — hidden ≠ control) |
| Tenant A → tenant B's employee / run / delete | 404 / 404 / 404 |
| Disabled user with a pre-issued token → start run | refused (browser test 11) |
| Owner → DEPARTMENT-routed approval | **403** — `canDecide` is rule-specific, no owner override, as doc 08 §8.1.7 intends |
| Department member → same approval | allowed once assigned to the department |

Two design notes, not defects: `GET /users` is readable by members (the roster); `POST /users` does
not take `departmentId` — department is assigned by `PATCH /users/:id` afterwards. My first routing
test assumed create-time assignment and drew the wrong conclusion for ten minutes; the contract is
create-then-assign, and it works.

# 12. Onboarding Dependency Audit

Unchanged from v1 except: the taxonomy rows are **removed from the rubric** by founder decision, and
`model` is now editable later with runtime effect.

| Input | Stored | Consumed | Runtime | UI | Editable later | Status |
|---|---|---|---|---|---|---|
| Company name / industry / size / goals | ✅ | resolver | — | resolver output | ✅ | IMPLEMENTED |
| Departments | ✅ | resolver + authz | authz scope | nav, widgets, approvals | ✅ `/organization` | IMPLEMENTED |
| User role | ✅ | guards | every guard | nav | ✅ `/team` | IMPLEMENTED |
| AI Employees (role, name) | ✅ | resolver, dashboard, retrieval | persona, scope, budget | nav, widgets | role not editable after hire | PARTIAL |
| Plan | ✅ | resolver | `PlanGuard` | `lockedAreas` | via `/billing` | IMPLEMENTED |
| AI model | not at onboarding | ✅ | **✅ request + price** | **✅ Settings control** | ✅ | IMPLEMENTED (post-onboarding) |
| Skills / connections / knowledge | not at onboarding | — | — | — | via their own pages | NOT IN ONBOARDING (P3) |

# 13. AI Employee Audit

| PRD question | v1 | Now |
|---|---|---|
| Every run attributed to an AI Employee? | No | **Yes** — first employee-bearing node in definition order; null only when the graph names nobody |
| `actingEmployeeId` populated? | Never | **Yes**, and history backfilled |
| Identity through async execution? | node-level | node-level + run-level |
| Tool execution knows the employee? | Yes | Yes |
| Credit usage attributed? | Yes | Yes, plus `workflowId` |
| Analytics per employee? | Yes | Yes |
| One employee uses another's skills? | No | No |
| Disabled employee executes? | No | No |
| Employee config affects runtime? | mostly; model ❌ | **all, including model** |

Still open: `Workflow` has no employee relation of its own (attribution lives on the run, derived
from the graph) — acceptable; `AiEmployee.department` is free text (P2).

# 14. AI Employee Settings Audit

Every control listed in v1 re-checked; the change is one row.

| Setting | v1 | Now |
|---|---|---|
| Model | **DEAD CONTROL** — no control, no runtime reader | **IMPLEMENTED** — free-text control (deliberately, per the "no hardcoded models" rule), nullable to reset, reaches request and price |
| Approval routing | BACKEND_ONLY | **IMPLEMENTED** on the APPROVAL node; per-employee `approvalRules` still the coarser "require approval for external messages" |
| Everything else | as v1 | as v1 |

Configuration versioning: unchanged — graph pinned per run; employee persona/permissions read live
(permissions *should* be live; persona arguably should snapshot — P3).

# 15. Dashboard / Analytics Audit

Unchanged from v1: config-driven widgets are real, per-employee table is real, the two value tiles
are honestly labelled estimates with hardcoded constants (P2). The HR widget's setup CTA now points
at `/hr` instead of the interview-slot workaround.

# 16. Workflow Runtime Audit

| Entry point | Deployed (inline) | Worker (queue) |
|---|---|---|
| Manual / webhook / event | legacy walker, no attempts | durable: attempts, leases, outbox — **proven today** (`attempts=2`) |
| Schedule | `/admin/cron/workflow-schedules` — **parked** | per-workflow repeatable |
| The other 17 sweeps | parked | **all driven** — 8 via `platform-sweeps` (new) |

**Two production execution paths still exist and the deployed one is the weaker.** `/admin/runtime`
now makes this impossible to miss: in inline mode it reports `engineMode: legacy_walk,
durableExecution: false` with two actionable warnings; in queue mode, `true` with none.

# 17. Skill / Connection / Engine Audit

Unchanged classifications (11 real-or-partial, 4 simulated, 3 engines code-real/infra-absent). The
change is behavioural: a `SIMULATED` skill can no longer take credentials, and the gate reads the
executor registry so it opens automatically when an executor lands. Postiz/Chatwoot/Plane remain
absent from every compose file and point at unresolvable hostnames.

# 18. Credit / Billing Integration Audit

| Requirement | v1 | Now |
|---|---|---|
| Loop correctness | proven | re-proven |
| Run/step rollups | dead | **live + backfilled** |
| Workflow attribution in ledger | null | **set** |
| Model pricing accuracy | mismatch possible | **one resolved value** |
| Historical explainability | ✅ (`modelCostRateId` per row) | ✅ |
| Enablement | 4 flags off, ungated | 4 flags off, **preflight warns; incoherent combos fail** |
| Subscription renewal | cron parked | driver exists; parked in deployed shape |

Still true and worth saying plainly: **the revenue path has never run in production**, and in shadow
mode a zero-balance company gets unlimited AI with no ledger row. That is now a *documented,
gated* choice rather than an invisible one.

# 19. Approval / Authorization Audit

| Layer | v1 | Now |
|---|---|---|
| Gate, decide, audit, `canDecide` | ✅ | ✅ |
| Routing rules / chains / SLA / escalation | ❌ no UI | **✅ UI, and proven end to end today including escalation** |
| Assigned-to-me inbox | endpoint only | **✅ UI** |
| Chain history | endpoint only | not surfaced (P3) |

# 20. Knowledge / Memory Audit

Unchanged: the healthiest subsystem. Role scoping in chat and in the workflow `RETRIEVE` node
confirmed by code re-read; no changes were made here.

# 21. Audit / Observability Audit

Audit trail: unchanged, trustworthy, chain verifies. Observability: still built-not-operating in the
deployed shape; the preflight now **warns** on missing OTel endpoint and alert webhook, and the
alerts sweep has a worker driver. No collector is configured anywhere.

# 22. Lifecycle / Delete / Disable Audit

Unchanged from v1. Still no `DELETE /companies` (P2). Orphaned repeatables still not reclaimed (P2).

# 23. Linked vs Broken Service Matrix (delta)

| Link | v1 | Now |
|---|---|---|
| Runtime → AI Employee identity | DEAD | **LINKED, verified** |
| Runtime → credit rollups | BROKEN | **LINKED, verified** |
| Credits → workflow attribution | BROKEN | **LINKED, verified** |
| Approval routing → UI | BACKEND_ONLY | **LINKED, verified end to end** |
| HR → UI | BACKEND_ONLY | **LINKED** (12 of 20 routes) |
| `isDurableActive` → health surface | DEAD | **LINKED** |
| 8 sweeps → any scheduler | **NONE in any shape** (v1 missed this) | worker driver exists; deployed shape still none |
| All 18 crons → deployed scheduler | NOT SCHEDULED | NOT SCHEDULED |
| Postiz / Chatwoot / Plane | INFRA ABSENT | INFRA ABSENT |
| Outbox → SSE → UI | BROKEN | BROKEN (P3) |
| OTel → collector | NOT OPERATING | NOT OPERATING (now warned) |

# 24. Browser E2E Results

**Environment:** Chromium via Playwright 1.62; Next.js on :3200 → NestJS on :4000; real Postgres
16/pgvector (:5433) and Redis (:6380) in Docker; no Orlixa API mocked; providers pinned to
`mock`/`hash`/`local` as `browser-e2e.yml` does. **Commit** `d749900`. **Command** `cd e2e && npx
playwright test --reporter=list`. **Time** 2026-09-03T17:42Z.

```
  ok  1 01-auth-journey › a visitor can sign up, and lands authenticated
  ok  2 01-auth-journey › a registered user can log out and log back in
  ok  3 01-auth-journey › a wrong password is rejected and does not authenticate
  ok  4 01-auth-journey › an unauthenticated visitor cannot reach an app route
  ok  5 02-security-journey › department isolation holds in the browser, both directions
  ok  6 02-security-journey › a DISABLED user cannot use the app at all
  ok  7 02-security-journey › a MEMBER cannot reach the HR area
  ok  8 03-golden-journey › signup → employee → skill → knowledge → workflow → approval → execution → audit
  ok  9 04-tenant-isolation-journey › one company cannot see or touch another's data, in the API or the browser
  ok 10 05-failure-journeys › rejecting an approval fails the run and executes nothing
  ok 11 05-failure-journeys › a disabled user cannot trigger a workflow with a token issued before the disable
  ok 12 05-failure-journeys › a demo-only skill refuses to start an OAuth flow
  ok 13 05-failure-journeys › a duplicate submission produces one run, not two
  13 passed (2.5m)
```

Against the brief's 39-step golden journey: step 8 (taxonomy) is dropped by decision; 14–16
(change model → future runs use it) are now **proven at the API layer** (ledger priced at the
employee's model) but not yet clicked in a browser test; 28/29/35 (durable path, attribution,
credits) are proven via SQL and DTO, and attribution + credits are now *visible* in the browser
(runs table column, run page header, credit panel) though not yet asserted by a spec; 24
(configure approval routing) is proven end to end via the API today and has a UI, but no browser
spec drives the editor yet. Those three specs are the remaining browser-coverage debt (P2).

# 25. Critical Browser Failures

None on a quiet machine. Two observations, both classified:

1. **`02-security-journey › a DISABLED user…` failed once** in a run executed while the unit suite
   and a second API were running concurrently: `apiRequestContext.post: connect ECONNREFUSED
   ::1:4000`. A connection refusal, not an assertion. 3/3 in isolation, 13/13 in the quiet run.
   **Environmental.**
2. **`workflows.e2e-spec › per-employee connection priority (TOOL_ACTION)` failed once** in the
   durable-mode full run: `output.result.installedSkillId` was `undefined`. 2/2 in isolation;
   passed in every other full run today and yesterday. The code path (per-employee connector
   resolution) was not touched by any remediation commit. **Pre-existing intermittent, newly
   observed — P2, needs a root cause, not a retry.**

# 26. P0 Findings

| # | Finding | Status |
|---|---|---|
| P0-1 | Account takeover from an email address alone | **CLOSED** — reproduced in v1, refused at boot now, re-proven today |
| P0-2 | No scheduled job runs in production | **OPEN — infrastructure.** All 18 now have worker drivers; the deployed shape has no worker and no registered crons |
| P0-3 | Durable engine cannot run in production | **OPEN — infrastructure.** Same root cause as P0-2; `/admin/runtime` reports it |

No new P0 was found by the re-audit.

# 27. P1 Findings

| # | v1 | Now |
|---|---|---|
| P1-1 run attribution | open | **CLOSED** |
| P1-2 run credit truth | open | **CLOSED** |
| P1-3 approval routing unreachable | open | **CLOSED** |
| P1-4 HR no UI | open | **CLOSED for roster/leave/onboarding**; documents/reviews/attendance → P2 |
| P1-5 credit flags ungated | open | **CLOSED as a gate**; the flags themselves await a pricing decision |
| P1-6 model dead setting | open | **CLOSED** |
| P1-7 fake-capable skills | open | **GATED**; executors still absent → P2 |
| P1-8 engines undeployed | open | **OPEN** (infra) |
| P1-9 ledger workflowId | open | **CLOSED** |
| P1-10 browser coverage | open | **8 → 13**; editor/model/credits specs remain → P2 |
| P1-11 observability not operating | open | **gated**; collector still absent → OPEN (infra) |

# 28. P2 Findings

Open: intermittent per-employee-connection e2e (§25); orphaned repeatables; no tenant deletion;
`AiEmployee.department` not an FK; hardcoded Hours-Saved/Cost-Savings constants; templates not
relevance-filtered (honest `ready` flags, so defensible); legal-holds/retention/platform-admin UI;
10 skills without verify-before-connect adapters; HR documents/reviews/attendance UI; three browser
specs (routing editor, model change, credit panel); real executors for stripe/github/hubspot/jira.
Closed: flaky credit sweep test; `poc/workflow-sdk`; pricing/model mismatch.

# 29. P3 Findings

`/assist` pre-click state for a locked plan; `AUTH_THROTTLE_LIMIT` guard in Playwright
`globalSetup`; SSE consumer or stop writing the outbox in inline mode; persona snapshot per run;
semantic memory recall; `yopmail.com` on the disposable blocklist; `AI_STEP` deprecation date;
`POST /users` accepting `departmentId` at create; chain history surface.

# 30. Additional Services Analysis

Unchanged from v1. The engine freeze held again: no n8n/Metabase/Meilisearch/Novu/Listmonk/Keycloak
code or dependency exists. (The `orlixa-n8n` container on this machine belongs to the other project.)

# 31. Irrelevant / Duplicate Services

`poc/workflow-sdk` removed. `node-types` retained with the reason documented in the controller.
Two engines and two LLM node types remain the only duplication; both are scheduled for convergence
once a worker host exists.

# 32. Exact Completion Calculations

### 32.1 Product Concept — **80%**

| Capability | W | v1 | Now | Weighted |
|---|---:|---:|---:|---:|
| Company configuration drives the product | 10 | 85 | 90 | 9.00 |
| Onboarding captures the organisation (taxonomy row dropped) | 8 | 70 | 75 | 6.00 |
| AI Employee as a rich entity | 10 | 75 | 80 | 8.00 |
| Employee identity persists into execution | 10 | 40 | **90** | 9.00 |
| Per-employee model drives runtime | 6 | 10 | **90** | 5.40 |
| Skills & tools executable | 10 | 60 | 62 | 6.20 |
| Knowledge | 8 | 90 | 90 | 7.20 |
| Memory | 5 | 80 | 80 | 4.00 |
| Workflows | 10 | 85 | 85 | 8.50 |
| Approvals / human-in-the-loop | 9 | 55 | **90** | 8.10 |
| Permissions & authorization | 9 | 85 | 85 | 7.65 |
| Credits & usage | 8 | 65 | 80 | 6.40 |
| KPIs & per-employee analytics | 6 | 70 | 72 | 4.32 |
| Execution history & audit | 6 | 85 | 90 | 5.40 |
| HR + Support surfaces | 8 | 20 | 55 | 4.40 |
| Marketing surface | 5 | 70 | 70 | 3.50 |
| **Total** | **128** | | | **103.07** |

**103.07 / 128 = 80.5% → 80%**

### 32.2 Production Readiness — **61%** *(in the deployed shape)*

| Dimension | W | v1 | Now | Weighted |
|---|---:|---:|---:|---:|
| Authentication & authorization | 10 | 60 | **95** | 9.50 |
| Tenant isolation | 10 | 95 | 95 | 9.50 |
| Secrets & credentials | 8 | 85 | 85 | 6.80 |
| Scheduled work actually runs | 10 | 0 | 15 | 1.50 |
| Durable execution in production | 10 | 15 | 15 | 1.50 |
| Crash / retry / recovery | 8 | 20 | 20 | 1.60 |
| Billing correctness **and enablement** | 9 | 45 | 65 | 5.85 |
| Observability operating | 7 | 55 | 60 | 4.20 |
| Backup & DR | 6 | 70 | 70 | 4.20 |
| Retention / GDPR | 6 | 30 | 35 | 2.10 |
| CI, tests, release gates | 8 | 85 | 92 | 7.36 |
| Rate limiting & abuse | 5 | 75 | 75 | 3.75 |
| Error truthfulness | 7 | 75 | 92 | 6.44 |
| Realtime / run visibility | 4 | 40 | 40 | 1.60 |
| **Total** | **108** | | | **65.90** |

**65.90 / 108 = 61.0% → 61%.** With the worker deployed, crons live, credit flags on and a collector
configured, the same table scores ≈ **89%**; the last ~11 points are P2 code (tenant deletion,
verify adapters, executors, SSE, orphan reclaim).

### 32.3 Architectural Integration — **78%**

| Link | W | v1 | Now | Weighted |
|---|---:|---:|---:|---:|
| Web → API (routes consumed) | 8 | 80 | 88 | 7.04 |
| API → authorization | 9 | 95 | 95 | 8.55 |
| API → database | 9 | 95 | 95 | 8.55 |
| API → queue → worker | 8 | 50 | 60 | 4.80 |
| Runtime → skills → provider | 8 | 60 | 60 | 4.80 |
| Runtime → credit ledger | 8 | 70 | **95** | 7.60 |
| Runtime → audit | 7 | 85 | 85 | 5.95 |
| Runtime → analytics | 7 | 75 | 80 | 5.60 |
| Runtime → AI Employee identity | 8 | 45 | **95** | 7.60 |
| Product context → UI | 8 | 85 | 90 | 7.20 |
| Onboarding → consumers | 7 | 65 | 70 | 4.90 |
| Approval routing → UI | 6 | 10 | **95** | 5.70 |
| Outbox → SSE → UI | 4 | 25 | 25 | 1.00 |
| Observability → collectors | 5 | 40 | 45 | 2.25 |
| Cron producers → scheduler | 8 | 5 | 60 | 4.80 |
| **Total** | **110** | | | **86.34** |

**86.34 / 110 = 78.5% → 78%**

# 33. Kill-Critic Decisions

Unchanged in substance from v1, with three closed: the PoC is gone, the taxonomy will not be built,
and "delete `node-types`" is withdrawn. Still do not build: a `ProductContextEngine`, new engines,
Kafka, WebSockets, a per-employee model *dropdown* (a hardcoded model list in the browser bundle is
the exact thing the repo's own rule forbids). Still converge: two engines → one, once a worker
exists; `AI_STEP` → `AI_EMPLOYEE_STEP` on a date. Still premature: platform-operator finance
reporting for revenue not yet collected.

# 34. What Is Actually Complete

Everything in §3, each re-proven today against the current commit from outside the code.

# 35. What Is Still Missing

**Infrastructure (blocks D):** an always-on worker; cron registration (or worker repeatables); an
OTel collector; a pricing decision to switch the credit flags on.
**Code (P2):** the items in §28.

# 36. Recommended Implementation Sequence

The v1 roadmap's code items are done except where §28 lists them. The ordering below is what remains.

# 37. FINAL PRODUCTION GATE

## ❌ NOT YET — but the blockers are now deployment decisions, not defects

- [x] Production refuses to boot without real mail — **verified today**
- [ ] Always-on worker deployed; `GET /admin/runtime` → `durableExecution: true` **in production**
- [ ] A scheduled workflow fires unattended in production
- [ ] An abandoned run is marked failed within 5 minutes in production
- [x] Every run attributed to an AI Employee, shown in the UI — **verified today**
- [x] A billed run shows its real cost — **verified today**
- [x] Preflight refuses incoherent billing configuration — **verified today**
- [x] Skills with no executor cannot take credentials — **verified today**
- [x] Both engine modes green — **744/745 + 745/745 today; the one intermittent is §25**
- [x] Browser tests for two tenants, insufficient credits, rejection, disabled user — **13/13 today**

---

# FINAL IMPLEMENTATION ROADMAP (remaining)

### P0-B · Deploy the worker *(owner: founder / ops)*
- **Problem** — `inline` forces `legacy_walk`; no worker exists in the deployed shape.
- **Impact** — no durable execution, crash recovery, or scheduled work in production.
- **Files** — hosting only; `docs/ops/durable-engine-rollout.md`; verify with `GET /admin/runtime`.
- **Done when** — production `/admin/runtime` returns `durableExecution: true` and a scheduled
  workflow fires unattended. **This single step closes P0-2 and P0-3 together** and moves the
  verdict to D.

### P1 · Switch billing on *(owner: founder decision + one env change)*
- **Problem** — four flags default off; the loop is proven; the preflight now names every
  consequence.
- **Done when** — `CREDIT_LEDGER_ENABLED`, `CREDIT_ENFORCEMENT_ENABLED`, `CREDIT_PAYG_ENABLED` are
  `true` in production with the `// FOUNDER-PENDING` numbers decided, and a zero-balance tenant is
  blocked.

### P1 · Configure an OTel collector + alert webhook *(ops)*
- **Done when** — the preflight's two observability warnings disappear and a trace appears.

### P2 · In this order (code, all mine)
1. Root-cause the per-employee-connection intermittent (§25) — a flaky test in a security-adjacent
   path is not acceptable to leave.
2. Browser specs for the routing editor, the model change, and the credit panel.
3. Reclaim orphaned BullMQ repeatables on delete/archive and on the not-found path.
4. `AiEmployee.departmentId` FK; `POST /users` accepting `departmentId`.
5. Tenant deletion path.
6. HR documents / reviews / attendance UI.
7. Verify-before-connect adapters for the remaining 10 skills.
8. Real executors for stripe / github / hubspot / jira — the gate opens by itself as each lands.
9. Replace the Hours-Saved / Cost-Savings constants with customer-supplied inputs.
10. Decide Postiz / Chatwoot / Plane: deploy or shelve; stop labelling undeployed engines `REAL`.
