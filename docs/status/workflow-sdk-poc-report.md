# Workflow SDK POC — Orlixa

**Date:** 2026-08-14
**Scope:** isolated proof of concept only. No production code, schema, contract, frontend or
execution mode was changed. Everything built for this POC lives in
[`platform/poc/workflow-sdk/`](../../poc/workflow-sdk/) and is imported by nothing.
**Subject:** Vercel Workflow SDK (`workflow` npm package) v4.8.2, docs at <https://workflow-sdk.dev>.
**Method:** read the real Orlixa source → build a real POC app → inject real failures → kill real
processes → read the results back off disk and out of Postgres.

---

## 1. Executive Verdict

| | |
|---|---|
| **Feasibility** | 🟡 **YELLOW** |
| **Score** | **61 / 100** (85 of a possible 140 across 14 dimensions, normalised) |
| **Can it replace Orlixa's durable execution infrastructure?** | **PARTIAL** |
| **How much custom infrastructure could realistically be removed?** | **~25%** |
| **Recommended next step** | **A — do not adopt** (with named conditions that would reopen it) |

**The one-line answer.** The Workflow SDK is a genuinely good durable execution engine, and it
passed every core durability test we threw at it — including a real `SIGKILL` in the middle of a
suspended run. But it does not solve the parts of Orlixa's problem that are actually hard
(tenant isolation, approval routing and SLA, failure classification, run-level idempotency,
audit and retention), and adopting it would **cost Orlixa two guarantees it has today**: the
"never blindly retry a side effect whose outcome is unknown" rule, and the ability to run the
NestJS API on Vercel.

**The three findings that decide it:**

1. **Side-effect safety goes backwards.** We crashed the process immediately after an external
   API call committed. The SDK re-ran the step and the provider received a **second call**. With
   no provider-side idempotency key, that produced **two real resources**. Orlixa's current
   runtime marks exactly this case `outcomeUnknown` and refuses to auto-retry
   ([`WorkflowStepAttempt.outcomeUnknown`](../../apps/api/prisma/schema.prisma)). The SDK has no
   equivalent concept.
2. **Version pinning does not exist off Vercel.** We started a run, killed the process, changed
   the step's code, rebuilt, and restarted. The in-flight run **resumed into the new code**. The
   SDK's headline "runs are pinned to the deployment that started them" is a Vercel World
   feature; on the self-hosted Postgres World `deployment_id` is the constant string `postgres`
   and `deploymentId: 'latest'` is documented in the SDK's own source as "a no-op in Worlds
   without atomic deployments".
3. **NestJS and Vercel are mutually exclusive.** The SDK's own docs say "NestJS integration is
   experimental and not yet supported for deployment to Vercel", and the package bears this out —
   `@workflow/nest` contains no Vercel build-output code at all, while `@workflow/builders`
   (used by the Next/Nitro paths) is what emits the `.vc-config.json` queue triggers the Vercel
   World requires. So Orlixa must pick: keep NestJS and self-host (needs Render, loses version
   pinning), or re-platform `apps/api` off NestJS to reach Vercel.

---

## 2. Current Orlixa Execution Architecture

Read from source, not from the docs. Two engines exist side by side, selected per company by
[`EngineModeService`](../../apps/api/src/modules/workflow-runtime/engine-mode.ts).

### Entry point and dispatch

```
Frontend / Webhook / Schedule / Event
        │
        ▼
WorkflowsController  (apps/api/src/modules/workflows/workflows.controller.ts)
        │
        ▼
WorkflowsService.enqueueRun()          ← run idempotency, version pinning, workflow:run authz
   ├─ idempotencyKey → unique (companyId, idempotencyKey) on WorkflowRun  → returns the prior run
   ├─ pins workflowVersionId = workflow.activeVersionId
   └─ WorkflowPermissionsService.assertCanRun(subjectUserId)
        │
        ▼
WorkflowsService.dispatchRun()
   ├─ durable  → BullMQ `wf-run-advance`  { runId, companyId }
   ├─ queue    → BullMQ `workflow-run`    (legacy walk, WorkflowProcessor)
   └─ inline   → WorkflowEngine.execute() in-request (serverless, gap G40)
```

### The durable state machine (the default engine)

```
wf-run-advance ──► RunAdvanceProcessor          "decide ONE thing, enqueue ONE job, exit"
                     │  advisory run lock (RunLockService)
                     │  seeds context, JOIN fan-in, disabled-node SKIP, step budget
                     ▼
                   creates WorkflowStepRun + WorkflowStepAttempt rows
                     │
                     ▼
wf-node-attempt ─► NodeAttemptProcessor          "execute ONE attempt"
                     T1  claim lease (leaseOwner/leaseExpiresAt) + heartbeat
                         ApprovalGateService.evaluate()   ← re-asked on EVERY attempt, from Postgres
                         NodeRegistry.get(type).execute() ← bounded by nodeTimeoutMs + AbortSignal
                     T2  attempt result + step status + RunEventOutbox row, one transaction
                         then enqueue the next advance (never inside T2)
                     │
                     ▼
                   NodeRegistry → TOOL_ACTION handler → ToolExecutorService → SkillExecutor
                     │                                                          │
                     │                                                          ▼
                     │                                                  Provider adapters
                     │                                          (Postiz / Chatwoot / Plane / Gmail)
                     ▼
wf-timer ────────► WorkflowTimerProcessor
                     ReaperService.sweep()   expired leases · due WorkflowRunTimer · stuck runs · overdue runs
                     OutboxRelayService      RunEventOutbox → realtime feed, then prune
```

### The durable state Orlixa owns in Postgres

| Model | Purpose |
|---|---|
| `WorkflowRun` | run identity, status, `correlationId`, `triggerEventId`, `idempotencyKey` (unique per tenant), `workflowVersionId`, `dryRun`, `resumeNodeId`, `failureClass` |
| `WorkflowStepRun` | one row per node, per-node audit |
| `WorkflowStepAttempt` | one row per attempt — lease, `outcomeUnknown`, per-attempt `idempotencyKey`, `failureClass` |
| `WorkflowRunTimer` | durable WAIT / DEADLINE / APPROVAL_SLA, `fireAt` from the **database** clock |
| `WorkflowJoinState` | fan-in counters, atomic `arrived = arrived + 1` |
| `RunEventOutbox` | transactional outbox, `BigInt` seq from the DB |
| `WorkflowVersion` | the frozen graph; runs pin to it |
| `WorkflowVariable`, `WorkflowSecretRef` | variable values and secret references |
| `ApprovalRequest` | routing, chains, SLA, escalation, `canDecide` |

Supporting rules that are pure business logic, not orchestration:
[`RetryPolicyService`](../../apps/api/src/modules/workflow-runtime/retry-policy.service.ts)
(11 failure classes, only 4 retryable, full-jitter backoff, "the three retry layers must not
compound"), [`run-state.ts`](../../apps/api/src/modules/workflow-runtime/run-state.ts) (legal
transitions, illegal ones throw), and tenant checks in both processors that refuse to trust the
`companyId` in a job payload.

---

## 3. POC Architecture

```
POC HTTP controller (NestJS 10, CommonJS, SWC builder)
        │  start(runOrlixaDefinition, [{ runId, companyId, employeeId,
        │                                workflowVersionId, definition, trigger }])
        ▼
Workflow SDK  "use workflow"  ── ONE generic interpreter, not one function per workflow
        │   walks the JSON graph · pure condition evaluation · sleep() · createHook()
        ▼
Workflow SDK  "use step"  ── one step per NODE KIND (ai / tool / approval), not per node
        │
        ▼
Orlixa boundary (POC mocks, deliberately outside the SDK)
   ├─ assertAuthorized()      ← authorization
   ├─ createApproval()        ← the approval RECORD stays Orlixa's
   └─ executeSkill()          ← SkillExecutor seam
        │
        ▼
Mock external provider  — records every request, honours idempotency keys like Stripe/Postiz do
        │
        ▼
evidence/ledger.jsonl + evidence/external-api-state.json   ← every assertion is read back from here
```

**Runtime under test:** `@workflow/world-postgres` v4.3.3 against a throwaway local database
(`workflow_poc`, its own role, never the Orlixa dev DB). Queue: graphile-worker. Node 22.13.1.

**Why it was built this way.** A POC that hard-codes one TypeScript function per workflow would
have proved nothing, because Orlixa has no such functions — its workflows are rows in
`WorkflowVersion.definition`, written by AI Assist. So the POC had to prove the interpreter model
or fail.

**Reproduce it:**

```bash
cd platform/poc/workflow-sdk
npm install
WORKFLOW_POSTGRES_URL="postgres://wfpoc:wfpoc@localhost:5433/workflow_poc" \
  npx --package=@workflow/world-postgres bootstrap
npm run build
node scripts/run-poc.mjs        # POC-01 … POC-11, kills and restarts the server for real
node scripts/run-poc08b.mjs     # POC-08b, rebuilds mid-run
```

---

## 4. Test Results

| Test | Capability | Result | Evidence | Risk if adopted |
|---|---|---|---|---|
| POC-01 | Basic workflow | ✅ PASS | `status=completed`, `order=[A,B,C]`, `result=3` | — |
| POC-02 | Retry (real failures) | ✅ PASS | 3 real attempts, 1 distinct `stepId`, run completed | Retry policy is a function property, not a tenant policy |
| POC-02b | `FatalError` not retried | ✅ PASS | `status=failed`, 1 attempt | Every non-retryable Orlixa failure must be re-thrown as `FatalError` |
| POC-03 | Durable wait | ✅ PASS | suspended 5s, `before=1`, `after=1` | — |
| POC-04 | Restart recovery | ✅ PASS | SIGKILL mid-sleep, restarted after 23.9s, `before=1`, `after=1` | — |
| POC-05 | External side effect + crash **with** provider key | ✅ PASS | step ran **2×**, provider got **2 requests**, 1 honoured + 1 deduped, **1 resource** | 🔴 depends entirely on the provider honouring keys |
| POC-05b | Same, **without** a provider key | ⚠️ NOT VERIFIED (recorded) | step ran 2×, provider got 2 requests, **2 resources created** | 🔴 duplicate real side effect |
| POC-06 | Duplicate trigger idempotency | ✅ PASS | 2 runs → `[DUPLICATE, PROCESSED]`, 1 side effect | 🟠 no native API; a hand-written hook protocol with a documented race |
| POC-07 | Dynamic (JSON) workflow | ✅ PASS | visited `n_trigger → n_draft → n_check → n_publish` from a DB-style definition | 🟠 every node kind must be a statically compiled step |
| POC-08 | Version pinning (Orlixa-owned) | ✅ PASS | run A stayed on v2 and parked on its approval while run B completed on v1 | — |
| POC-08b | Version pinning (SDK-owned, self-hosted) | ❌ **FAIL** | in-flight run **resumed into build B** after a rebuild | 🔴 no code-version safety off Vercel |
| POC-09 | Approval suspend → restart → resume | ✅ PASS | pending survived SIGKILL, resumed on decision, 1 publish | 🟠 no SLA, escalation or routing |
| POC-10 | Authorization boundary | ✅ PASS | run failed, **0 provider calls leaked**, 4 denials recorded | 🟠 the denial was retried 4× — the SDK has no failure classes |
| POC-11 | Observability | ✅ PASS | `runId`, `status`, `returnValue`, `stepId` available | 🔴 no tenant dimension; payloads stored as CBOR `bytea` |
| POC-12 | Vercel deployment | ⚠️ **NOT VERIFIED** | not deployed — see §13 for two concrete blocking facts | 🔴 |
| POC-13 | Self-hosting | ✅ PASS | the entire suite ran on `@workflow/world-postgres`, zero Vercel | 🟠 needs a long-running process |

Raw evidence: `platform/poc/workflow-sdk/evidence/results.json`, `ledger.jsonl`,
`external-api-state.json`, `poc-08b.json`, `poc-run.log`, `server-gen*.log`.

---

## 5. Failure / Restart Evidence

These were real kills, not simulated ones. The driver owns the server process and issues
`taskkill /F`; in POC-05 the step kills its own process with `process.exit(137)`.

**POC-04 — killed while suspended in `sleep()`**

```
[server gen1] up pid=68396
[kill] SIGKILL pid=68396 — POC-04: kill while the run is suspended in sleep()
[server gen1] exited code=1
[server gen2] up pid=72348
PASS POC-04 {"stepsCompletedBeforeKill":1,"restartedAfterMs":23904,
              "finalStatus":"completed","beforeExecutions":1,"afterExecutions":1}
```

The step-execution counters are file-backed, so a re-executed first step would have shown
`beforeExecutions: 2`. It showed 1. **The run survived the kill, resumed on a new process, and
did not repeat completed work.**

**POC-05 — killed in the unsafe window, between the side effect and the bookkeeping**

```
[server gen2] exited code=137        ← the step killed itself after the provider call committed
[server gen3] up pid=40648
PASS POC-05 {"processReallyDied":true,"finalStatus":"completed",
             "providerRequestsReceived":2,"requestsHonoured":1,
             "requestsDeduplicatedByProvider":1,"distinctResourcesCreated":1,
             "stepExecutions":2}
```

**POC-08b — rebuilt while a run was suspended**

```
built with CODE_BUILD='A'
started wrun_01M00N4A6PG5FKEJJV9VF1XHR6 on build A
built with CODE_BUILD='B'
POC-08b result: {"status":"completed","resumedIntoBuild":"B"}
NOT PINNED — the in-flight run resumed into code deployed after it started.
```

---

## 6. Dynamic Workflow Result — **mandatory**

**Verdict: works, via an Orlixa interpreter. This is the single most important positive finding.**

Orlixa's workflows are data, not code:

```
AI Assist → WorkflowDefinition JSON → WorkflowVersion row → runtime
```

The SDK cannot execute that directly — `"use workflow"` marks a *function*. But a **single generic
interpreter** whose argument is the graph works end to end. POC-07 executed
`n_trigger → n_draft → n_check(true) → n_publish` purely from JSON, and POC-09 ran a different
JSON graph containing a `WAIT` and an `APPROVAL` through the same function.

```
WorkflowVersion.definition (JSON, from Postgres)
        │
        ▼
Orlixa interpreter   "use workflow"   ← deterministic: walks the graph, decides what runs next
        │
        ▼
one step per NODE KIND  "use step"    ← AI_EMPLOYEE_STEP · TOOL_ACTION · APPROVAL · …
        │
        ▼
Orlixa authorization → SkillExecutor → provider adapter
```

Three constraints this imposes, all of them real:

1. **The set of node kinds must be static.** Steps are registered at build time by the SWC
   plugin. A new node type is a deploy, not a row. That matches Orlixa's frozen-17 node
   vocabulary today, so it is a fit — but it is a hard ceiling.
2. **Control flow lives in the replayed body.** Conditions, branching and the loop guard run on
   every replay. That is free for a 5-node graph and grows linearly; Orlixa's 50-node budget is
   fine, a 500-node graph would not be.
3. **The SDK's event log has no idea what a "node" is.** It sees anonymous steps. Every
   node-level fact Orlixa's UI shows today — `WorkflowStepRun`, per-node attempts, branch taken,
   skipped-because-disabled — has to keep being written by Orlixa in parallel. **The step tables
   do not go away.**

---

## 7. External Side Effect Result — **mandatory**

**Verdict: the SDK does not make external side effects safe. That responsibility stays 100%
with Orlixa, and the SDK is weaker here than what Orlixa runs today.**

The test: call the provider, then kill the process before the result can be recorded.

| | With provider idempotency key | Without |
|---|---|---|
| Step executions | 2 | 2 |
| Provider requests received | 2 | 2 |
| Requests honoured | 1 | **2** |
| Distinct resources created | 1 | **2** |
| Final run status | completed | completed |

**The SDK re-ran the step both times.** The only thing that prevented a duplicate publish was
the *provider* honouring an idempotency key. The SDK's own docs confirm this is by design
("Step executed multiple times… the step will be re-tried according to your retry policy, but no
error will be visible in the Observability UI").

This is a real regression against Orlixa today. `NodeAttemptProcessor` splits execution into
T1 (claim lease) → side effect → T2 (record), and when a worker dies in between, the reaper marks
the attempt `outcomeUnknown` and **refuses to retry it**, surfacing it to a human instead. The
comment in the source is explicit: *"Retrying a possibly-completed side effect is the worse
failure."* The SDK takes the opposite position silently.

For Orlixa this matters because not every provider honours idempotency keys. Postiz
`publish_now`, a Gmail send, a Chatwoot reply — a duplicate there is a customer-visible mistake,
and it is exactly the class of bug the `highRisk` approval gate exists to prevent.

---

## 8. Idempotency Result — **mandatory**

**Verdict: step-level idempotency is good. Run-level idempotency is Orlixa's, and must stay
Orlixa's.**

| Layer | Provided by | Assessment |
|---|---|---|
| Step retry key | **Workflow SDK** — `getStepMetadata().stepId`, stable across attempts (POC-02 confirmed: 3 attempts, 1 `stepId`) | Good. Directly comparable to Orlixa's `sha256(runId:nodeId:attempt)`, and arguably better because it is stable across attempts rather than per-attempt. |
| Duplicate workflow start | **Orlixa / the adapter** — the SDK has no `start(fn, args, { idempotencyKey })` | Weaker than today. |
| Provider-side dedup | **The external provider** | Unchanged either way. |

POC-06 sent `test-trigger-001` twice, concurrently. One run processed, one returned `DUPLICATE`,
and the provider saw exactly one honoured call. So it *works* — but only because the POC
implemented the documented hook-token protocol by hand: create a hook with a deterministic token,
`await hook.getConflict()`, and return early if another run owns it. The SDK's own docs carry a
warning on that pattern ("two concurrent requests can both observe 'no hook yet' and each call
`start()`… A native API for atomically starting a run and registering a hook is in the works").

Orlixa's current mechanism is a unique index — `@@unique([companyId, idempotencyKey])` on
`WorkflowRun`, with a `P2002` catch that returns the winner. That is simpler, atomic, tenant-scoped
and has no race. **There is no reason to give it up.**

---

## 9. Approval Result

**Verdict: the suspend/resume mechanism is excellent; the approval *product* is entirely Orlixa's.**

What the SDK provided, proven in POC-09: `createHook({ token })` suspends the run; the
registration is durable in Postgres; a `SIGKILL` while suspended changed nothing; `resumeHook(token,
payload)` from an ordinary HTTP controller resumed it; the next step ran **exactly once**
(`publishCallsHonoured: 1`).

Split of responsibility, as built:

| Belongs to the Workflow SDK | Belongs to Orlixa |
|---|---|
| The hook token and its uniqueness | The `ApprovalRequest` row and its lifecycle |
| Suspending and resuming the run | Routing (USER / ROLE / DEPARTMENT / TEAM / EMPLOYEE_MANAGER / ANY_ADMIN) |
| Durability of the suspension | `canDecide` — who is allowed to press approve |
| | Multi-level chains (`chainId`, lazy next level) |
| | SLA `dueAt`, escalation tiers, `onTimeout` AUTO_APPROVE / AUTO_REJECT / EXPIRED |
| | The approvals inbox, badges, audit |

The SDK has **no timeout on a hook**. Orlixa's `approval-sla` sweep, `WorkflowRunTimer` of kind
`APPROVAL_SLA` and the whole `approval-routing` module have no counterpart and would be kept as-is.

---

## 10. Version Pinning Result

Two different axes, and they must not be confused.

**Axis 1 — which graph does this run execute?** Orlixa's. ✅ **Works, and works well.** Because the
interpreter takes the definition as an argument, the pinned graph travels with the run for its
whole life. POC-08 proved it: run A started on v2 (with a `WAIT` and an `APPROVAL`) and was still
parked on its approval while run B started and completed on v1's shorter path. Publishing a new
`WorkflowVersion` cannot reach into an in-flight run, because the in-flight run never reads the
table again. This is strictly Orlixa-owned and needs no SDK feature.

**Axis 2 — which *code* does this run execute?** The SDK's. ❌ **Does not exist off Vercel.**
POC-08b started a run on build `A`, killed the process, rebuilt as `B`, restarted, and the
suspended run resumed into `B`. All 15 POC runs carry `deployment_id = 'postgres'`, a constant.
The SDK's own source says `deploymentId: 'latest'` "is a no-op in Worlds without atomic
deployments".

The practical consequence for Orlixa: on a self-hosted deployment, shipping a change to a step —
say a fix to the TOOL_ACTION handler — while an approval has been pending for two days means that
approval resumes into the new handler. That is the same exposure Orlixa has today with its own
engine, so it is not a *new* risk; but it does mean the SDK's most-advertised safety guarantee is
one Orlixa would not actually receive.

---

## 11. Authorization Result

**Verdict: the boundary holds, but the SDK actively works against Orlixa's failure semantics.**

POC-10 ran the `authz` graph as `emp-unauthorized`. Result: run `failed`, **0 provider calls
leaked**, denial recorded. The SDK never gets near a provider — it calls a step, the step calls
`assertAuthorized()`, and only then `executeSkill()`. The separation the brief asked for is
preserved and is structurally sound.

But note the count: **4 denials recorded for 1 logical denial.** The SDK retried an authorization
failure three times before giving up, because its default is "any uncaught error is retried, up
to 3 times". Orlixa's `RetryPolicyService` classifies `AUTHORIZATION_DENIED` as non-retryable and
stops at one.

Adopting the SDK therefore means auditing every throw path that can reach a step and wrapping the
non-retryable ones in `FatalError` — `AUTHORIZATION_DENIED`, `VALIDATION_ERROR`,
`APPROVAL_REJECTED`, `BUDGET_EXCEEDED`, `SUBSCRIPTION_BLOCKED`, `CANCELLED`, `INTERNAL`, all
seven of them. Miss one and a tenant's budget-exceeded error burns four attempts and writes four
audit rows. The failure taxonomy is not something the SDK can take over; it is business logic.

---

## 12. Observability Result

| Orlixa field | Workflow SDK | Status |
|---|---|---|
| `workflowRunId` | `runId` (`wrun_…`) | ⚠️ **PARTIAL** — a *second* identity; Orlixa's run id must be carried in the payload and mapped |
| `stepRunId` | — | ❌ **MISSING** — the SDK has steps, not nodes |
| `attemptId` | `getStepMetadata().attempt` | ⚠️ PARTIAL — visible in-process, no queryable row |
| status / duration / error | `run.status`, `returnValue`, `errorCode`, timestamps | ✅ SUPPORTED |
| retry visibility | event log + Web UI | ⚠️ PARTIAL — a crash-retry is invisible by design (see §7) |
| parent/child | linked runs via `start()` from a step | ✅ SUPPORTED |
| `companyId` | — | ❌ **MISSING — and this is the serious one** |
| `userId` / `employeeId` / `workflowId` / `workflowVersionId` | — | ❌ MISSING; recoverable only from the payload |
| `skillExecutionId` / `externalRequestId` | — | ❌ MISSING — Orlixa's `SkillExecution` audit is unaffected and stays |

The schema the Postgres World creates, read directly out of the POC database:

```
workflow.workflow_runs(id, output, deployment_id, status, name, execution_context,
                       input, error, created_at, updated_at, completed_at, started_at,
                       output_cbor, execution_context_cbor, input_cbor, expired_at,
                       spec_version, error_cbor)
```

Two structural problems for an enterprise multi-tenant SaaS:

1. **There is no tenant column anywhere in the `workflow` schema.** Not on runs, steps, events,
   hooks or waits. A search of `information_schema` for any `%company%` or `%tenant%` column
   returns zero rows. Row-level security, per-tenant retention, per-tenant export and "delete
   everything for this customer" are all impossible without forking the World implementation.
2. **Run inputs and outputs are stored as CBOR `bytea`, not as queryable JSON.** In our runs
   `input` was NULL and `input_cbor` was populated. That is good for privacy and bad for
   everything else: no SQL joins to `Company`, no analytics, no retention sweep by content, no
   "show me every run that touched this candidate".

Orlixa's WAVE 8 retention work covers 10 data classes with legal hold. None of it can reach
inside the SDK's tables.

---

## 13. Vercel Result — **NOT VERIFIED**

**We did not deploy to Vercel.** Deploying publishes to an external service, and it was outside
what this POC was authorised to do. Marking it PASS on documentation alone would be exactly the
kind of assumed result the brief forbids. So: **NOT VERIFIED**, with two concrete facts gathered
locally that both point the same way.

**Fact 1 — the SDK says so.** From the official NestJS guide: *"NestJS integration is experimental
and not yet supported for deployment to Vercel."*

**Fact 2 — the packages bear it out.** A Vercel World deployment needs each step and flow handler
registered as a Vercel Queue consumer via `experimentalTriggers` in `.vc-config.json`, emitted at
build time. That code lives in `@workflow/builders` (`vercel-build-output-api.js`, referenced from
`base-builder.js`) and is used by the Next/Nitro/Vite integrations. Searching every compiled file
in `@workflow/nest` for the string `vercel` returns **nothing**. `@workflow/nest` builds a local
bundle and serves it from a Nest controller at `/.well-known/workflow/v1/` — a shape that requires
a long-running server.

**What this means concretely for Orlixa.** `apps/api` is a NestJS app that already runs on Vercel
as an HTTP-only serverless function with `QUEUE_WORKERS_ENABLED=false` and
`WORKFLOW_EXECUTION_MODE=inline`. To put the Workflow SDK on that deployment, Orlixa would have to
either wait for official NestJS→Vercel support, or re-platform the API's build onto Nitro or
Next — which is a far larger change than swapping a workflow engine.

There is also a data question that Vercel World forces and that the POC could not answer locally:
on the 4.x line, **all workflow data is stored in Vercel's cloud in `iad1` regardless of where the
app is deployed**. Orlixa's run context routinely carries HR special-category PII, which the
platform currently encrypts at rest in its own Postgres. Moving it into a US-region managed store
is a data-residency decision, not an engineering one, and it needs a legal answer before any
Vercel World adoption.

---

## 14. Self-hosting Result — ✅ PASS

Every test in this report ran self-hosted. No Vercel account, no Vercel CLI, no network
dependency on Vercel at runtime: `@workflow/world-postgres` against local Postgres, with
graphile-worker as the queue. It created its own schemas (`workflow`, `graphile_worker`,
`workflow_drizzle`) via an idempotent bootstrap, and it worked.

| | Self-hosted (Postgres World) | Vercel World |
|---|---|---|
| Durability, retry, sleep, hooks | ✅ proven here | assumed equivalent |
| Deployment/code version pinning | ❌ **absent** (POC-08b) | ✅ the documented behaviour |
| `deploymentId: 'latest'` | no-op | supported |
| Long-running process required | ✅ **yes** — `world.start()` polls the DB | no |
| Serverless-compatible | ❌ no | ✅ yes |
| Data location | your Postgres | Vercel cloud, `iad1` on 4.x |
| Works with NestJS | ✅ yes | ❌ not supported |

The honest summary: **the SDK is portable, but its two Worlds do not offer the same guarantees.**
"Write once, run anywhere" holds for the workflow *code* and not for the workflow *contract*.

---

## 15. What Workflow SDK Solves

Real, and worth naming plainly:

- **Durable execution genuinely works.** Kill the process at any point; the run continues. Proven,
  not assumed.
- **The programming model is much nicer than a graph walker.** `await sleep("2d")` and
  `const decision = await hook` are ordinary code. Orlixa needs `WorkflowRunTimer`,
  `resumeNodeId`, `ApprovalGateService` re-entrancy on every attempt, and a reaper to get the same
  effect.
- **Step memoization is free.** Completed steps are never re-run on replay — no equivalent of the
  "reuse an attempt that has not started, otherwise open the next one" logic that had to be
  debugged in `RunAdvanceProcessor`.
- **A stable `stepId` across retries** is the right primitive for provider idempotency keys.
- **`FatalError` / `RetryableError` with `retryAfter`** is a clean retry API.
- **Fan-out and fan-in are just `Promise.all`.** No `WorkflowJoinState`, no atomic arrival counter,
  no lost-lane bug of the kind the `__lanes` fix addressed.
- **Observability tooling out of the box** — CLI, web UI, event log.
- **It removes a genuinely hard class of bug.** Lease heartbeats, advisory locks, run-lock
  re-enqueue on fan-in, timer sweeps, outbox relay — roughly 2,000 lines of `workflow-runtime/`
  exist to solve problems the SDK solves for you.

---

## 16. What Workflow SDK Does NOT Solve

- **Side-effect safety on crash.** It retries; Orlixa's engine refuses to. §7.
- **Run-level idempotency.** No native API; a hook protocol with a documented race. §8.
- **Tenant isolation.** No `companyId` anywhere in its schema. §12.
- **Failure classification.** One retry policy per function, no `FailureClass`, no
  `AUTHORIZATION_DENIED`-is-not-retryable rule. §11.
- **Approval as a product.** Routing, `canDecide`, chains, SLA, escalation, `onTimeout` — none of
  it. §9.
- **Node-level audit.** No concept of a node, so `WorkflowStepRun` / `WorkflowStepAttempt` stay. §6.
- **Version pinning off Vercel.** §10.
- **NestJS on Vercel.** §13.
- **Retention, legal hold, export, right-to-erasure** over its own tables. §12.
- **Entitlements and plan gating** (`PlanGuard`, `@RequirePlan`), budget limits, usage metering.
- **Reconciliation** against providers, connector health, circuit breakers, per-connector rate
  limiting, DLQ — all of `common/resilience` and `ConnectorHealthService`.
- **Dry-run mode.** `WorkflowRun.dryRun` has no counterpart.
- **Compensation / saga.** Orlixa has `COMPENSATING` states modelled (deliberately unimplemented);
  the SDK's cookbook shows saga as a pattern you write yourself, same as today.

---

## 17. What Orlixa Must Continue Owning

| Concern | Verdict | Why |
|---|---|---|
| Workflow definition | **Orlixa** | AI Assist writes JSON; the SDK has no representation for it |
| Workflow versioning | **Orlixa** | pinning works because the graph is data; the SDK's own pinning is Vercel-only |
| Authorization | **Orlixa** | must never move; the SDK has no subject, tenant or permission concept |
| Approval | **Orlixa** | the SDK gives suspend/resume only; routing, `canDecide`, SLA, escalation are the product |
| Skill executor | **Orlixa** | explicitly out of scope for this POC, and correctly so |
| Provider adapters | **Orlixa** | unchanged |
| Tenant isolation | **Orlixa** | 🔴 the SDK has no tenant column at all |
| Audit | **Orlixa** | `SkillExecution`, `AuditEvent`, node-level step rows |
| Reconciliation | **Orlixa** | connector health, circuit breakers, DLQ |
| Entitlements | **Orlixa** | plan gating, budget, metering |
| Business rules | **Orlixa** | failure classes, retry policy, `dryRun`, step budget |
| **Run idempotency** | **Orlixa** | added to the brief's list — the DB unique index is better than the hook protocol |
| **Side-effect safety** | **Orlixa** | added — §7 is the headline risk |

---

## 18. Custom Infrastructure We Could Remove

**Estimate: ~25%, and only in the self-hosted configuration.**

Counting the ~10,600 lines under `modules/workflows/` + `modules/workflow-runtime/`:

| Component | Fate | Lines (approx.) |
|---|---|---|
| `RunAdvanceProcessor` | replaced by the SDK's replay | 459 |
| `NodeAttemptProcessor` (lease/T1/T2 machinery) | mostly replaced | 390 |
| `AttemptLeaseService` | replaced | 159 |
| `RunLockService` | replaced | 62 |
| `ReaperService` | replaced | 187 |
| `TimerProcessor` + `WorkflowRunTimer` (WAIT half) | replaced by `sleep()` | ~120 |
| `WorkflowJoinState` + fan-in traversal | replaced by `Promise.all` | ~200 |
| `RunStateWriter` / `run-state.ts` | **kept** — the state machine is a product contract | 477 |
| `RetryPolicyService` | **kept** — failure classes are business logic | 147 |
| `TraversalService`, `graph.ts` | **kept** — moves into the interpreter, does not vanish | 673 |
| `OutboxRelayService` + `RunEventOutbox` | **kept** — realtime feed is Orlixa's | 116 |
| Node handlers, validator, templates, secrets | **kept** | ~2,500 |
| `WorkflowStepRun` / `WorkflowStepAttempt` writes | **kept** — the SDK has no node concept | — |

So roughly **1,600 of 10,600 lines** disappear outright, and some of what remains gets simpler.
Call it 15–25% of the workflow subsystem, and **0%** of authorization, approvals, skills, events,
resilience or HR.

Against that, adoption *adds*: an interpreter, an Orlixa-id ↔ SDK-id mapping layer, a
`FatalError` wrapper on every non-retryable throw, a run-idempotency hook protocol, a second
queue system (graphile-worker beside BullMQ), a second run store, and a build-system change from
`tsc` to SWC — which collides directly with the documented `tsconfig.build.json` arrangement that
makes `nest build` emit `dist/main.js`.

**Net: this is close to a wash on code volume, and a clear loss on operational surface area.**

---

## 19. Render Requirement

**YES — Render (or any long-running host) is still required.**

Not a judgement call; it follows from two proven facts. The Postgres World requires
`world.start()` and a process that polls the database — the SDK's docs state plainly that it "is
not compatible with serverless platforms". And the Vercel World, which *is* serverless, cannot be
reached from a NestJS app (§13).

So on the tested architecture Orlixa needs a long-running process either way. The SDK does not
remove Render from the picture; it swaps a BullMQ worker for a graphile-worker one.

---

## 20. Vercel Requirement

**CONDITIONAL — and today the condition is not met.**

The tested architecture (NestJS + Postgres World) **cannot** run on Vercel. To get there, all of
the following must be true:

1. Official NestJS → Vercel support ships (currently "not yet supported"), **or** `apps/api` is
   re-platformed onto Nitro/Next.
2. Legal sign-off that workflow run state — including HR special-category PII in the run context —
   may live in Vercel's managed store in `iad1`.
3. Acceptance that Orlixa gains a hard dependency on Vercel Queues and Vercel-managed storage for
   its core execution path, with the exit ramp being the Postgres World, which has weaker
   guarantees (§10).
4. A cost model for Vercel Workflow at Orlixa's run volume — not evaluated here.

Note the irony worth stating out loud: the Vercel World would genuinely fix gap **G40** (runs
sitting `PENDING` for ever on a serverless-only deployment, currently worked around with
`WORKFLOW_EXECUTION_MODE=inline`). That is the strongest single argument for the SDK — and it is
blocked by the NestJS limitation.

---

## 21. Migration Risk

**HIGH.** (Not CRITICAL only because a phased, per-tenant cutover is possible — the same
`EngineModeService` seam that carried the legacy → durable migration.)

| Dimension | Risk | Why |
|---|---|---|
| Data migration | 🟠 MEDIUM | `Workflow` / `WorkflowVersion` / `WorkflowRun` stay; the SDK adds parallel tables rather than replacing them |
| Workflow migration | 🟢 LOW | definitions are data and are not rewritten — the interpreter reads the same JSON |
| Run migration | 🔴 **HIGH** | in-flight runs cannot be moved. A `WorkflowRun` mid-graph has no representation in the SDK's event log. The only safe answer is drain-then-cut, and Orlixa has approvals that legitimately sit pending for days |
| Active-workflow migration | 🟠 MEDIUM | ACTIVE workflows keep running; new runs pick the new engine. The existing per-company engine flag handles this |
| Approval migration | 🔴 **HIGH** | a pending `ApprovalRequest` whose run is on the old engine must stay on the old engine. Both runtimes have to be live for as long as the longest SLA |
| Schedule migration | 🟠 MEDIUM | BullMQ repeatables and the `/admin/cron/*` sweeps must be re-pointed; the double-fire bug that inline mode already exposed is a live precedent |
| Version migration | 🟢 LOW | pinning is Orlixa's and is unaffected |
| **Rollback** | 🟠 MEDIUM | flipping the engine flag back is easy for *new* runs; runs already started on the SDK cannot be moved back. Rollback is therefore "stop starting new ones", not "undo" |
| Build system | 🔴 **HIGH** | `nest build` (tsc) → SWC. `apps/api/tsconfig.build.json` is deliberately configured (`rootDir:"src"`, `paths:{}`, `incremental:false`) so the entry lands at `dist/main.js` and `@vaep/types` resolves from `node_modules`. SWC + the workflow plugin is a different pipeline and would need that whole arrangement re-derived |

No migration was performed. This is an assessment only.

---

## 22. Recommended Future Architecture

Nothing changes now. If the SDK is ever adopted, this is the **smallest viable** shape — and note
that it adds a layer rather than removing one:

```mermaid
flowchart TD
    subgraph Orlixa_owns["Orlixa owns — unchanged"]
        A["AI Assist → WorkflowDefinition JSON"] --> B["WorkflowVersion (pinned, immutable)"]
        B --> C["WorkflowsService.enqueueRun<br/>run idempotency · workflow:run authz · dryRun"]
        C --> D["WorkflowRun row<br/>companyId · correlationId · idempotencyKey"]
    end

    D --> E["Orlixa Execution Adapter<br/>maps Orlixa ids ↔ SDK runId<br/>wraps non-retryable errors in FatalError"]

    subgraph SDK["Workflow SDK — durability only"]
        E --> F["'use workflow' interpreter<br/>walks the JSON graph"]
        F --> G["sleep / createHook<br/>durable wait · approval suspend"]
        F --> H["'use step' — one per NODE KIND"]
    end

    H --> I["Orlixa AuthorizationService"]
    I --> J["ToolExecutorService<br/>highRisk approval gate"]
    J --> K["SkillExecutor + provider idempotency key"]
    K --> L["Provider adapters<br/>Postiz · Chatwoot · Plane · Gmail"]

    subgraph Still_Orlixa["Still Orlixa — not replaceable"]
        M["WorkflowStepRun / WorkflowStepAttempt<br/>node-level audit"]
        N["ApprovalRequest<br/>routing · canDecide · SLA · escalation"]
        O["RunEventOutbox → realtime"]
        P["SkillExecution · AuditEvent · retention · legal hold"]
    end

    H -.writes.-> M
    G -.resumed by.-> N
    H -.writes.-> O
    K -.writes.-> P

    style SDK fill:#1e293b,color:#e2e8f0
    style Orlixa_owns fill:#0f172a,color:#e2e8f0
    style Still_Orlixa fill:#0f172a,color:#e2e8f0
```

The shape is honest about the cost: the SDK sits **inside** Orlixa's stack, not underneath it,
and the boxes on either side of it do not shrink much.

---

## 23. Recommended Next Step

### **A — Do not adopt.**

The Workflow SDK is a good product and it passed the durability tests convincingly. That is not
the question. The question is whether it is a good fit for Orlixa *now*, and on the evidence it is
not, for four reasons:

1. **It would make Orlixa less safe where safety matters most.** The `outcomeUnknown` rule — never
   auto-retry a side effect whose outcome is unknown — is one of the better decisions in the
   current runtime, and there is no way to express it in the SDK. §7 measured the consequence:
   two real resources created from one logical publish.
2. **It solves the part Orlixa has already built and paid for.** The durable runtime shipped in
   WAVE 0/1 and is the default engine. The ~1,600 lines the SDK would delete are the lines that
   are already written, already tested in both engine modes, and no longer changing.
3. **It does not solve any of the parts that are still open.** Tenant isolation, retention, legal
   hold, approval SLA, failure classification, node-level audit — all stay exactly where they are.
4. **It blocks the Vercel path rather than opening it.** The one genuinely attractive prize — the
   Vercel World fixing G40 — is unreachable from NestJS today.

**Keep the POC.** It lives at `platform/poc/workflow-sdk/`, it is reproducible, and it cost far
less than the decision it informs. Re-run it and reopen this decision when **any two** of the
following become true:

- [ ] NestJS → Vercel deployment is officially supported by the SDK.
- [ ] The Postgres World gains real deployment/version pinning (POC-08b flips to `A`).
- [ ] A native `start(fn, args, { idempotencyKey })` ships (the docs say it is "in the works").
- [ ] The World schema gains a tenant dimension, or Orlixa accepts a forked World.
- [ ] Orlixa decides to re-platform `apps/api` off NestJS for unrelated reasons.

Until then the recommendation is to spend the same effort on the gaps the current runtime still
has — which the SDK would not have closed either.

---

## Appendix — POC inventory

| Path | Purpose |
|---|---|
| `poc/workflow-sdk/src/workflows/poc-01-basic.ts` | POC-01 |
| `poc/workflow-sdk/src/workflows/poc-02-retry.ts` | POC-02, POC-02b |
| `poc/workflow-sdk/src/workflows/poc-03-wait.ts` | POC-03, POC-04, POC-08b |
| `poc/workflow-sdk/src/workflows/poc-05-side-effect.ts` | POC-05, POC-05b |
| `poc/workflow-sdk/src/workflows/poc-06-idempotency.ts` | POC-06 |
| `poc/workflow-sdk/src/workflows/poc-07-dynamic.ts` | POC-07, POC-08, POC-09, POC-10, POC-11 — the interpreter |
| `poc/workflow-sdk/src/orlixa/*` | mock Orlixa boundary: authorization, approvals, skill executor, provider, ledger, fault injection |
| `poc/workflow-sdk/scripts/run-poc.mjs` | the driver — owns and kills the server process |
| `poc/workflow-sdk/scripts/run-poc08b.mjs` | the code-version pinning test |
| `poc/workflow-sdk/evidence/` | raw results, ledger, provider state, server logs |

**Isolation confirmed:** `git status` shows `poc/` as the only addition. No file under
`apps/`, `packages/`, `prisma/`, `e2e/` or `docs/architecture/` was modified. The POC uses its own
throwaway database (`workflow_poc`, role `wfpoc`) and never touches the Orlixa dev database.
