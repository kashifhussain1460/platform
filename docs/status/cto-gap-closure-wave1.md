# CTO Gap Closure — WAVE 1: Durable Execution (P0)

**Date:** 2026-08-11
**Authority:** `docs/implementation/workflow-system/orlixa-cto-master-gap-closure-plan(1).md` §WAVE 1
**Baseline:** `docs/status/cto-gap-closure-baseline.md` (WAVE 0, passed)

---

## 1. What changed, in one sentence

The durable state machine went from **unreachable scaffolding** to **the production
execution path for any opted-in tenant**, behind a per-company flag that still defaults every
company to the legacy walk.

---

## 2. The headline finding

The durable runtime could not have worked in production even if something had called it.

**Every job it enqueued was rejected by BullMQ.** BullMQ 5 refuses a custom `jobId` containing
`:` (`Job.validateOptions` → `Custom Id cannot contain :`), and all four enqueue sites used
`attempt:<id>` / `advance:<id>:<ts>`. So `queue.add` threw on every call, the failures piled up
silently in the queue's `failed` set (100 of them were sitting in Redis), and no run ever advanced
past its first node.

This was invisible for exactly one reason: nothing dispatched to the runtime, so no run existed to
notice. The runtime's own unit and e2e tests all passed throughout, because each tested a
*component* — transitions, leases, outbox, reaper — and none drove a whole workflow. That is the
lesson worth keeping: **a passing component suite over an unwired subsystem proves nothing about
the subsystem.**

Fixed with a `wfJobId()` helper (`workflow-runtime.constants.ts`) that all four sites use, so the
separator cannot regress.

---

## 3. Gaps closed

| Gap | Fix |
|---|---|
| **W1-a** No production entry point | `WorkflowsService.dispatchRun` now asks `EngineModeService` and enqueues `wf-run-advance` for a state-machine company. `WorkflowEngine.execute` does the same, because `trigger()` (SCHEDULE) creates its run and calls `execute()` directly, bypassing dispatchRun — without both, the cutover would have covered manual runs only. |
| **W1-b** Advance ignored `edges` | New pure module `workflow-runtime/graph.ts` (`entryNode` / `successorOf` / `nextRunnableNode` / `branchOf`), porting the legacy routing rules verbatim. Routing decisions persist on the new `WorkflowStepRun.branch` column so the advance worker can re-derive them from Postgres alone after a restart. |
| **W1-c** Lost update on run context | `RunStateWriter.mergeRunContext` does a `jsonb \|\| jsonb` merge in Postgres instead of read-modify-write. Concurrent PARALLEL lanes writing different keys now both survive. Applied in the attempt processor and in the loop cursor. |
| **W1-d** Stale context to traversal | `applyDirective` receives the post-step context, so a pause or fan-out persists the step that caused it. |
| **W1-e** No durable resume | The APPROVAL gate is re-entrant (below); `resumeRun` dispatches through the same `dispatchRun`, so a durable run resumes on the durable engine. |
| **W1-f** Module cycle | `EngineModeModule` — a leaf holding only the flag — is imported by both `WorkflowsModule` and `WorkflowRuntimeModule`. Same shape the codebase already uses for `ApprovalRoutingModule`. `wf-run-advance` is registered as a **producer** in WorkflowsModule and a **consumer** in the runtime. |
| **W1-g** No end-to-end test | `test/workflow-durable-cutover.e2e-spec.ts` — 9 tests against real Postgres + real BullMQ workers. |

---

## 4. Bugs found and fixed while wiring it up

Each of these would have produced a stuck or double-executing run the first time a real tenant was
switched over.

1. **`jobId` containing `:`** — see §2. Nothing could execute.
2. **Retry double-execution.** On a retryable failure the processor scheduled a delayed retry
   attempt *and* enqueued an advance. The advance found the step un-settled and queued a second
   attempt of the same node — two concurrent executions of one side effect from a single failure.
   `recordFailure` now reports who owns the run next (`RETRY_SCHEDULED` → the retry job does).
3. **A failed step left the run RUNNING for ever.** Nothing finalised a terminally-failed step, so
   the advance handed the same failed node back on every pass. The advance now fails the run.
4. **A completed attempt could be re-claimed.** T2 clears `leaseOwner`, so a redelivered attempt job
   would re-claim a COMPLETED attempt and re-run its side effect. `claim` now also requires
   `status IN ('PENDING','RUNNING')` — finished attempts are never re-claimable, while an expired
   lease still is, which is how a dead worker's attempt is recovered.
5. **Approval could never resume.** `enqueueAttempt` upserted `attempt: step.attempt`, and
   `step.attempt` was never incremented, so it always resolved to attempt 1. After a pause that row
   is COMPLETED and the empty `update: {}` returned it unchanged — unclaimable. The run sat RUNNING
   with the approval granted and the work never resumed. It now reuses a PENDING attempt or opens
   the next one.
6. **A paused step was marked COMPLETED.** COMPLETED is terminal in the step table, so the resumed
   run could not re-enter the node. Paused steps now go to `WAITING` (new `step.waiting` outbox
   event).
7. **`resumeNodeId` was never consumed.** Every later advance returned to the same node, so an
   approval step would re-execute for ever. It is cleared when its node is dispatched.
8. **Loop iteration 2 threw.** Each iteration reused one step row and had to transition it
   COMPLETED → RUNNING, which the step state table forbids. Iterations now get their own step row
   (which also gives per-iteration run-log history).
9. **Two watchdogs racing.** The legacy 10-minute stuck-run sweep would have *killed* durable runs
   while the reaper was *recovering* them — neither authoritative. The legacy sweep now excludes
   runs with `WorkflowStepAttempt` rows, the exact discriminator for the durable path (the reaper's
   own sweep already required the converse).
10. **Fresh runs had no context.** The legacy walk seeds `{{trigger.*}}` and persisted
    WORKFLOW/OUTPUT variables in memory before it starts; the state machine has no such moment, so
    node 1 rendered `{{trigger.who}}` as empty. Seeded on PENDING → RUNNING.

---

## 5. Deliberate design decisions

- **`inline` mode forces `legacy_walk`.** The durable runtime is queue-driven by construction (a
  decision and an effect are separate jobs, precisely so retrying the decision cannot re-run the
  effect). The serverless deployment has no worker, so a state-machine run there would be created
  and never consumed. `EngineModeService.modeFor` refuses at the source, so a misconfigured
  `WORKFLOW_ENGINE_MODE=state_machine` on Vercel degrades to working legacy execution rather than
  silently doing nothing.
- **One approval system, not two** (plan §19). `ApprovalGateService` writes the same
  `ApprovalRequest` rows with the same `ApprovalRoutingService` routing that `ApprovalsService`
  already decides on, so approve / reject / SLA-escalate work unchanged against a durable run. The
  only addition is `args.nodeId`: the legacy path can find its pending approval by run alone
  because a run pauses at one node at a time, and with genuinely concurrent lanes that stops being
  true.
- **The gate is re-entrant, and that is what makes approval durable.** Every attempt at the node
  asks "may I proceed?" and the answer comes entirely from Postgres. There is no in-memory state to
  lose across a restart.
- **Traversal is duplicated between engines for now.** `graph.ts` ports the legacy rules verbatim
  rather than refactoring the legacy walk to share them. Editing the engine that currently runs
  100% of production traffic is the larger risk during a flagged migration. Collapsing the two is
  part of removing the legacy engine (plan §21) and must not be left permanent.

---

## 6. WAVE 1 gate

| Gate item | Status | Evidence |
|---|---|---|
| Production execution path uses durable runtime | ✅ | `workflow-durable-cutover.e2e-spec.ts` — "executes a whole workflow on the durable runtime", asserting `WorkflowStepAttempt` rows exist (only the durable path writes them) |
| Existing workflow behaviour remains compatible | ✅ | "leaves a non-opted-in company on the legacy walk" (0 attempt rows) + the whole pre-existing workflow suite green |
| Approval survives restart | ✅ | "pauses at an APPROVAL, survives, and resumes exactly once when approved" — the gate answers from Postgres on every attempt |
| Retry survives restart | ✅ | Retries are new `WorkflowStepAttempt` rows in Postgres, not BullMQ `attempts`; `RETRY_SCHEDULED` ownership prevents the double-dispatch |
| Worker crash recovery passes | ✅ | "marks a dead worker's attempt outcomeUnknown instead of re-running it" |
| Duplicate triggers are idempotent | ✅ | "returns the SAME run for a duplicate idempotency key" |
| Side effects protected against duplicate execution | ✅ | "does not re-execute a node when the same advance is delivered twice" (one attempt per node after repeated reaper sweeps) + the `claim` status guard |
| Legacy engine isolated behind a migration flag | ✅ | `EngineModeService`; default `legacy_walk`; rollback is clearing an env var, not a deploy |

### Test results (2026-08-11)

| Check | Result |
|---|---|
| `pnpm -w run typecheck` | **PASS** — 5/5 packages |
| `pnpm --filter @vaep/api run test:unit` | **PASS — 409 tests, 52 suites** (was 388/51; +21 `graph.spec.ts`) |
| Durable + workflow e2e (7 suites) | **PASS — 64 tests** (`workflow-durable-cutover`, `workflow-runtime-p1`, `workflow-runtime-concurrency`, `workflow-approval`, `workflows`, `workflow-triggers`, `inline-execution`) |
| Full e2e suite | **390 passed / 6 failed, 66 suites** — all 6 failures pre-existing (below) |

**Zero regressions.** All 6 remaining failures were verified pre-existing by stashing every WAVE 1
source change and re-running the same suites, where they fail identically:

| Suite | Failing | Symptom |
|---|---|---|
| `analytics.e2e-spec.ts` | 3 | KPI aggregates return 0 where `>= 1` is expected |
| `auth-email-verification.e2e-spec.ts` | 2 | `POST /auth/verify-email` with dev code `123456` returns 400, not 201 |
| `e2e/engines-support.e2e-spec.ts` | 1 | no `SkillExecution` row written for the chatwoot tool call, so the expected `ERROR` status is `undefined` |

These contradict the CLAUDE.md claim that the suite is 100% green and should be triaged
separately; none touch workflow execution.

One test that WAS broken by this wave — `workflow-runtime-concurrency`'s "an EXPIRED lease can be
reclaimed" — was caught by that same stash-and-compare and is fixed: the `claim` guard excludes
only *finished* attempts (`status IN ('PENDING','RUNNING')`), not running ones, so the
duplicate-effect hole closes without disabling dead-worker recovery.

---

## 7. Rollout (plan §21)

`WORKFLOW_ENGINE_MODE` stays `legacy_walk`. Opt in per tenant:

```
WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES=<companyId>[,<companyId>...]
```

Order: internal test tenant → staging → one production tenant → percentage → all → remove legacy.
Rollback at any point is removing the id from that list. **Requires a hosted worker**
(`WORKFLOW_EXECUTION_MODE=queue`, `QUEUE_WORKERS_ENABLED` unset) — the flag self-disables under
`inline`.

---

## 8. Known limitations carried into later waves

- `WorkflowsService.resumeRun` / `cancelRun` still write `status` directly rather than through
  `RunStateWriter`, so those two transitions emit no outbox event. Harmless today (the UI polls);
  it matters for WAVE 5 realtime.
- PARALLEL/LOOP on the durable engine are wired and unblocked but not yet covered by an end-to-end
  test; the cutover tests cover linear, branching and approval graphs.
- Traversal logic exists in two places until the legacy engine is removed (§5).
- Per-attempt node-permission enforcement (doc 09 PDP) remains deferred, as scoped in P3-06.

---

## WAVE 1 gate: **PASSED**. WAVE 2 (Authorization + Security Policy) may begin.
