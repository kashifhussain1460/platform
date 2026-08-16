# Production Execution Baseline (WAVE 0)

**Date:** 2026-08-14
**Purpose:** map every workflow execution path that exists in the code *today*, before any
change. This is the gate for WAVE 1 — nothing is implemented until every path is here.
**Method:** source only. Every claim below cites a file and line. Documentation claims were not
trusted; each was checked against the code.

---

## 1. Summary

There are **two execution engines** in the codebase and **one is the default**:

| Engine | Selected by | Default | Entry |
|---|---|---|---|
| Durable state machine (`modules/workflow-runtime`) | `EngineModeService.usesStateMachine(companyId)` | ✅ **yes** | `wf-run-advance` queue |
| Legacy graph walk (`WorkflowEngine.run`) | `WORKFLOW_ENGINE_MODE=legacy_walk`, **or any `inline` deployment** | no | `workflow-run` queue |

`EngineModeService` ([engine-mode.ts:40](../../apps/api/src/modules/workflow-runtime/engine-mode.ts#L40))
opts *out*, not in — anything other than the literal `legacy_walk` gets the durable engine.

**But `inline` silently forces the legacy walker** ([engine-mode.ts:84](../../apps/api/src/modules/workflow-runtime/engine-mode.ts#L84)).
On the Vercel/serverless deployment there is no worker to consume `wf-run-advance`, so every run
would stop after zero nodes. The constructor logs an `error` about it at boot. **This is the
single biggest fact about production today: if Orlixa runs serverless-only, it has no durable
engine at all.**

---

## 2. Every execution entry point

| # | Entry point | Code path | Creates the run via | Canonical? |
|---|---|---|---|---|
| 1 | **Manual run** (UI button) | `WorkflowsController` → `createRun()` [:657](../../apps/api/src/modules/workflows/workflows.service.ts#L657) | `enqueueRun` | ✅ |
| 2 | **Retry a run** | `retryRun()` [:862](../../apps/api/src/modules/workflows/workflows.service.ts#L862) → `createRun` | `enqueueRun` | ✅ |
| 3 | **Webhook** (public token) | `WebhooksController` → `fireWebhook()` [:632](../../apps/api/src/modules/workflows/workflows.service.ts#L632) | `enqueueRun` | ✅ |
| 4 | **Event** (canonical + manual fire) | `fireEvent()` [:576](../../apps/api/src/modules/workflows/workflows.service.ts#L576) | `enqueueRun` | ✅ |
| 5 | **Gmail inbound poll** | `gmail-inbound.service.ts:526` → `fireEvent` | `enqueueRun` | ✅ |
| 6 | **Canonical event normalize** | `event-normalize.processor.ts:135` → `fireEvent` | `enqueueRun` | ✅ |
| 7 | **AI Assist dry-run** | `assist-test-tool.ts:221` → `createRun` | `enqueueRun` | ✅ |
| 8 | **Approval approved → resume** | `approval.service.ts:439` → `resumeRun()` [:756](../../apps/api/src/modules/workflows/workflows.service.ts#L756) | resumes an existing run | ✅ |
| 9 | **Approval SLA auto-approve → resume** | `approval-sla.service.ts:208` → `resumeRun` | resumes | ✅ |
| 10 | **Approval rejected / SLA reject / expire** | `approval.service.ts:441`, `approval-sla.service.ts:156,210` → `cancelRun()` | terminates | ⚠️ see G-B4 |
| 11 | **User cancel** | `cancelRunByUser()` [:818](../../apps/api/src/modules/workflows/workflows.service.ts#L818) | terminates | ❌ **G-B2** |
| 12 | **SCHEDULE — BullMQ repeatable** | `addSchedule()` [:1119](../../apps/api/src/modules/workflows/workflows.service.ts#L1119) → `WorkflowProcessor:93` → `engine.trigger()` | ❌ **`workflowRun.create` direct** | ❌ **G-B1** |
| 13 | **SCHEDULE — cron sweep (serverless)** | `cron.controller.ts:177` → `fireScheduled()` [:1003](../../apps/api/src/modules/workflows/workflows.service.ts#L1003) → `engine.trigger()` | ❌ **direct** | ❌ **G-B1** |

Entries 1–9 all converge on `WorkflowsService.enqueueRun()`
[:892](../../apps/api/src/modules/workflows/workflows.service.ts#L892), which is the only place
that applies run idempotency, version pinning and `workflow:run` authorization.

**Entries 12 and 13 do not.** That is the WAVE 1 headline.

---

## 3. Queues and workers

| Queue | Producer | Consumer | Role |
|---|---|---|---|
| `wf-run-advance` | `WorkflowsService.dispatchDurable` [:191](../../apps/api/src/modules/workflows/workflows.service.ts#L191), `WorkflowEngine.execute` [:218](../../apps/api/src/modules/workflows/engine/workflow-engine.service.ts#L218), `NodeAttemptProcessor:290`, `ReaperService:176`, `RunAdvanceProcessor:81,263` | `RunAdvanceProcessor` (concurrency 4) | decide the next node |
| `wf-node-attempt` | `RunAdvanceProcessor:426`, `NodeAttemptProcessor:364` (retry) | `NodeAttemptProcessor` | execute one attempt |
| `wf-timer` | self (repeatable, every `WF_TIMER_SWEEP_EVERY_MS`) | `WorkflowTimerProcessor` (concurrency 1) | reaper + outbox relay |
| `wf-compensate` | — | — | **registered, unused** (saga deliberately not implemented) |
| `wf-dlq` | — | — | **registered, unused** |
| `workflow-run` | `dispatchRun` [:138](../../apps/api/src/modules/workflows/workflows.service.ts#L138), `dispatchDurable` [:184](../../apps/api/src/modules/workflows/workflows.service.ts#L184) (schedule fires only), `addSchedule` repeatable | `WorkflowProcessor` | legacy walk + `{workflowId,source}` + watchdog |
| `approval-sla` | repeatable | `ApprovalSlaProcessor` | SLA sweep |
| `event-normalize` | `CanonicalIngestService` | `EventNormalizeProcessor` | Raw → Canonical |
| `connector-reconcile`, `connector-health`, `gmail-inbound`, `knowledge-ingest`, `marketing-sync`, `support-sync`, `hr-retention` | various | own processors | supporting |

All workers are gated by `QUEUE_WORKERS_ENABLED`. On a serverless deployment they are absent and
time-based work is driven by `/admin/cron/:job` (`workflow-schedules`, `workflow-watchdog`,
`approval-sla`, `hr-retention`) per `apps/api/vercel.json`.

---

## 4. The two stuck-run sweepers — **verified disjoint, with one hole**

Both exist and both are registered:

- Legacy: `WorkflowEngine.sweepStuckRuns()` [:288](../../apps/api/src/modules/workflows/engine/workflow-engine.service.ts#L288), repeatable registered in `WorkflowProcessor.onModuleInit`, also `/admin/cron/workflow-watchdog`. Filter: `status IN (PENDING,RUNNING) AND attempts NONE`. **Fails** the run.
- Durable: `ReaperService.sweepStuckRuns()` [:133](../../apps/api/src/modules/workflow-runtime/reaper.service.ts#L133), driven by `wf-timer`. Filter: `status = RUNNING AND attempts SOME AND no attempt RUNNING`. **Recovers** the run.

The `attempts NONE` / `attempts SOME` discriminator means they cannot both act on the same run.
The P0 flagged in the 2026-08-05 gap audit ("reaper re-executes legacy runs") **is fixed**.

**The hole (G-B3):** a *durable* run that is stuck in `PENDING` with **no attempt rows yet** —
because its `wf-run-advance` job was lost (Redis flushed, worker never booted) — matches the
**legacy** filter (`attempts NONE`). After 10 minutes it is **killed** by the legacy watchdog
instead of being **recovered** by the reaper, which only looks at `RUNNING`. The most recoverable
failure in the system gets the least recoverable treatment.

---

## 5. Database state that defines execution

`WorkflowRun` · `WorkflowStepRun` · `WorkflowStepAttempt` (lease, `outcomeUnknown`, per-attempt
`idempotencyKey`, `failureClass`) · `WorkflowRunTimer` (DB-clock `fireAt`) · `WorkflowJoinState`
(atomic `arrived`) · `RunEventOutbox` (BigInt seq) · `WorkflowVersion` · `WorkflowVariable` ·
`WorkflowSecretRef` · `ApprovalRequest` (routing, chain, SLA).

`RunStateWriter` [run-state-writer.service.ts](../../apps/api/src/modules/workflow-runtime/run-state-writer.service.ts)
is documented as *"THE only writer of run and step status… Callers must not write `status`
directly."* Two callers still do — see G-B1 and G-B2.

---

## 6. Gaps found in the baseline

| ID | Severity | Gap | Evidence |
|---|---|---|---|
| **G-B1** | 🔴 **P0** | **SCHEDULE runs bypass the canonical path entirely.** `WorkflowEngine.trigger()` calls `prisma.workflowRun.create` directly, so a scheduled run gets **no `workflowVersionId` (no version pinning)**, **no `idempotencyKey`**, and **never passes `WorkflowPermissionsService.assertCanRun`**. Both schedule drivers (BullMQ repeatable and the serverless cron sweep) use it. | [workflow-engine.service.ts:145–165](../../apps/api/src/modules/workflows/engine/workflow-engine.service.ts#L145) |
| **G-B2** | 🔴 **P0** | **`cancelRunByUser` bypasses `RunStateWriter`.** Three consequences: (a) check-then-act race — the status read and the unguarded `update` are separate statements, so it can stomp a concurrent transition; (b) **no `run.cancelled` outbox event**, so the realtime stream never learns the run was cancelled; (c) no `failureClass`. The event type `run.cancelled` is declared and emitted by nothing. | [workflows.service.ts:838](../../apps/api/src/modules/workflows/workflows.service.ts#L838), [run-state-writer.service.ts:23](../../apps/api/src/modules/workflow-runtime/run-state-writer.service.ts#L23) |
| **G-B3** | 🟠 **P1** | **A durable run stuck in `PENDING` is killed, not recovered.** See §4. | §4 |
| **G-B4** | 🟠 **P1** | **`cancelRun` (approval reject / SLA) records no `failureClass`** and terminates as `FAILED` with a free-text reason. The failure taxonomy cannot distinguish `APPROVAL_REJECTED` from a node error in queries or metrics. | [workflows.service.ts:803](../../apps/api/src/modules/workflows/workflows.service.ts#L803) |
| **G-B5** | 🟠 **P1** | **`inline` mode silently has no durable engine.** Logged loudly at boot, but there is no runtime surface that refuses to start or marks the deployment degraded. | [engine-mode.ts:61](../../apps/api/src/modules/workflow-runtime/engine-mode.ts#L61) |

### Deliberate designs, recorded so they are not mistaken for gaps

- **`retryRun` starts a fresh run on the *current* active version**, not the failed run's pinned
  version. A retry after a fix should use the fix. Stated in the UI. Not a gap.
- **The Postiz webhook is a deliberate no-op.** It is unsigned and publicly reachable, so writing
  to the DB from it would let anyone flip any company's post status; the `marketing-sync` sweep is
  the source of truth ([marketing-webhook.controller.ts:9](../../apps/api/src/modules/engines/marketing/marketing-webhook.controller.ts#L9)).
  Chatwoot and Plane both go through the canonical `CanonicalIngestService` pipeline with real
  signature verification. Not a gap.
- **`wf-compensate` / `wf-dlq` queues are registered but unused.** Saga compensation is
  deliberately not implemented.

---

## 6b. Gaps found AFTER the baseline, while implementing

| ID | Severity | Gap | Status |
|---|---|---|---|
| **G-B6** | 🔴 **P0** | **`outcomeUnknown` was written and then ignored.** The reaper flagged the ATTEMPT but left the `WorkflowStepRun` in `RUNNING`. `RUNNING` is not in the traversal's `SETTLED` set, so the next advance resolved to the same node and opened attempt N+1. **Negative control proved the run did not merely retry — it re-executed the node and reported `COMPLETED`.** A worker crash mid-send produced a duplicate side effect reported as success. | ✅ FIXED + VERIFIED |
| **G-B7** | 🟠 **P1** | **`assertCanRun` cannot deny an automated run through permission grants.** The run subject for SCHEDULE/EVENT/WEBHOOK is the pinned version's publisher, and publishing is `@Roles('OWNER','ADMIN')` — who bypass the check. The only control that actually bites is the DISABLED-user kill switch (§9.C.5), which is now pinned by a test. Grants on an automated workflow are decorative today. | ⚠️ OPEN — WAVE 3 |
| **G-B8** | 🟠 **P1** | **One bad row aborted the whole cross-tenant reaper sweep.** The sweeps run under `Promise.all`; an exception in the lease sweep abandoned every other tenant's due timers, stuck runs and expired leases in that pass. Found by a `PENDING → FAILED` step transition that the state table did not allow. | ✅ FIXED + VERIFIED |
| **G-B9** | 🟡 **P2** | **Run-level `failureClass` was never populated from the attempt.** The taxonomy stopped at the attempt row and never reached the run, metrics or the operator. | ✅ FIXED |

## 7. Baseline verdict

**No unmapped production execution path was found.** Every way a `WorkflowRun` can come into
existence, advance, pause, resume or terminate is listed in §2. WAVE 1 may proceed.

The WAVE 1 target is narrow and specific: **make `enqueueRun` the only way a `WorkflowRun` is
created, and `RunStateWriter` the only way its status changes.** That closes G-B1 and G-B2, which
together are the reason a scheduled workflow today runs unpinned, unauthorised and invisible to
the realtime stream.

---

## 8. Implementation status

### WAVE 1 — one canonical execution path · **IMPLEMENTED + TESTED + VERIFIED**

| Change | File |
|---|---|
| `WorkflowEngine.trigger()` **removed** — the last `workflowRun.create` outside `enqueueRun` | `workflows/engine/workflow-engine.service.ts` |
| `WorkflowsService.fireSchedule()` — the canonical SCHEDULE entry, via `enqueueRun` | `workflows/workflows.service.ts` |
| `scheduleSlotKey()` — per-occurrence idempotency key (interval-bucketed; 1-min for cron) | `workflows/workflows.constants.ts` |
| Non-ACTIVE / archived workflows refuse to fire (defence in depth) | `workflows/workflows.service.ts` |
| `WorkflowProcessor` `{workflowId,source}` → `fireSchedule` | `workflows/engine/workflow.processor.ts` |
| `RunDispatchJob` — dispatch can no longer represent "create a run" | `workflows/workflows.constants.ts` |
| `cancelRunByUser` → `RunStateWriter` (guarded, emits `run.cancelled`, `failureClass:'CANCELLED'`) | `workflows/workflows.service.ts` |
| `cancelRun` takes a `failureClass`; SLA expiry passes `TIMEOUT` | `workflows/workflows.service.ts`, `approvals/sla/approval-sla.service.ts` |
| Legacy watchdog skips durable-engine runs; reaper gains `sweepStalledPendingRuns` | `workflows/engine/workflow-engine.service.ts`, `workflow-runtime/reaper.service.ts` |

**Tests:** `test/workflow-canonical-path.e2e-spec.ts` (9, real PG+Redis) ·
`src/modules/workflows/schedule-slot.spec.ts` (6 unit) ·
`src/modules/workflow-runtime/reaper.service.spec.ts` (extended).
**Regression:** 56/56 across `workflow-triggers`, `inline-execution`, `workflow-run-controls`,
`workflow-durable-cutover`, `workflow-versioning`, `approval-sla`, `approvals`,
`workflow-approval`.

### WAVE 2 — side-effect safety + failure taxonomy · **IMPLEMENTED + TESTED + VERIFIED (partial wave)**

| Change | File |
|---|---|
| Reaper settles the **step** with the attempt, in one transaction | `workflow-runtime/reaper.service.ts` |
| Advance worker refuses to open a new attempt when any attempt is `outcomeUnknown` (backstop) | `workflow-runtime/run-advance.processor.ts` |
| New `OUTCOME_UNKNOWN` failure class, classified non-retryable | `workflow-runtime/retry-policy.service.ts` |
| Attempt `failureClass` propagates to the run | `workflow-runtime/run-advance.processor.ts` |
| `PENDING → FAILED` is a legal step transition (reachable: lease claimed before the step RUNNING write) | `workflow-runtime/run-state.ts` |
| Per-row isolation in the lease sweep | `workflow-runtime/reaper.service.ts` |

**Tests:** `test/workflow-side-effect-safety.e2e-spec.ts` (5, real PG+Redis).
**Negative control run:** with the backstop disabled, 4 of 5 fail and the crashed run reports
`COMPLETED` — the test genuinely guards the behaviour rather than describing it.

**Still open in WAVE 2:** mid-step cancellation (a RUNNING step is not cancellation-aware),
the `wf-dlq` queue is registered but unused, and Redis/DB-failure recovery is untested (WAVE 10).

---

## 9. Verification status after WAVE 1 + WAVE 2

| Gate | Result |
|---|---|
| `tsc --noEmit` (api) | ✅ clean |
| `pnpm -w run lint` | ✅ 0 errors (1 pre-existing warning) |
| Unit suite | ✅ **66 suites, 584 tests** |
| E2E, default engine (`state_machine`) | ✅ **76 suites, 491 tests, 0 failures** |
| E2E, `WORKFLOW_ENGINE_MODE=legacy_walk` | ❌ **5 failures — all pre-existing, see G-B10** |

The e2e count rose from the documented 477 to 491: 14 new tests, no regressions.

### G-B10 🔴 P1 — the documented rollback path is broken (pre-existing)

`CLAUDE.md` states *"Both are 465/465 as of 2026-08-13"*. That is no longer true. Running the
full suite with `WORKFLOW_ENGINE_MODE=legacy_walk` gives **5 failures in 4 suites**
(`workflow-approval`, `approval-routing`, `business-lifecycle`, `journey-hr-e2e`), all with the
same symptom: **a run stays `WAITING` after its approval is granted — the legacy walker does not
resume.**

**Proven pre-existing, not caused by this work.** The changes were stashed with
`git stash push -- apps/api/src` and the same suites re-run against the original code:
`approval-routing` alone failed the identical two tests, and `workflow-approval`,
`business-lifecycle` and `journey-hr-e2e` failed identically. (`approval-routing` passed in one
batch ordering at baseline and failed in another, which is why it first looked like a regression —
it is order-sensitive, and broken either way.)

**Why this matters more than the test count.** `legacy_walk` is the documented mid-incident
rollback: *"Rollback is still flipping a flag, not shipping a deploy."* If the durable engine has
to be switched off during an incident, **every workflow containing an APPROVAL node will hang at
the approval**. The escape hatch does not work. Either the legacy resume path is fixed, or the
rollback story is retired and the docs stop promising it.

This is now the top P1 for WAVE 4 (approvals).
