# CTO Gap Closure — Baseline (WAVE 0)

**Date:** 2026-08-11
**Authority:** `docs/implementation/workflow-system/orlixa-cto-master-gap-closure-plan(1).md`
**Gate:** WAVE 0 requires this record before any architectural migration begins.

---

## 1. Current architecture

Monorepo `platform/` — pnpm + Turborepo.

```
apps/web   Next.js App Router (UI)
apps/api   NestJS + Prisma + Postgres + BullMQ/Redis
packages/types   @vaep/types (shared DTOs, CommonJS build)
infra/     docker-compose: postgres+pgvector :5433, redis :6380, minio, adminer
```

28 backend modules under `apps/api/src/modules/`.

---

## 2. Workflow execution paths — the central finding

**There are two engines. Only one of them runs anything.**

### Path A — legacy graph walk (100% of production traffic)

```
WorkflowsService.enqueueRun()
   -> dispatchRun()
        queue mode  -> BullMQ `workflow-run` -> WorkflowProcessor -> WorkflowEngine.execute/resume/trigger
        inline mode -> WorkflowEngine.* called directly in-request
   -> WorkflowEngine.run() recursively walks nodes/edges in one process
```

- `apps/api/src/modules/workflows/engine/workflow-engine.service.ts` — 1078 lines.
- Control flow (PARALLEL lanes, LOOP bodies) is **recursive in-process sub-walks** sharing a
  `MAX_WORKFLOW_NODES` budget.
- Status writes are direct `prisma.workflowRun.update` calls, unguarded by any transition table.
- No attempt rows, no leases, no reaper on this path.

### Path B — durable state machine (dormant, zero production traffic)

```
wf-run-advance  -> RunAdvanceProcessor  (decide; enqueue exactly one attempt)
wf-node-attempt -> NodeAttemptProcessor (T1 lease -> side effect -> T2 record)
wf-timer        -> WorkflowTimerProcessor
wf-compensate / wf-dlq (registered, not driven)
```

- `apps/api/src/modules/workflow-runtime/` — 2394 lines, 17 files.
- Real durable primitives already exist: `WorkflowStepAttempt`, `WorkflowJoinState`,
  `RunEventOutbox`, advisory run locks, lease + heartbeat + reaper, a retry classifier, and a
  `RUN_TRANSITIONS`/`STEP_TRANSITIONS` state table that **throws** on illegal transitions.
- Schema landed in migration `20260801150000_p1_runtime_state_machine`.

**VERIFIED DORMANT.** `EngineModeService.usesStateMachine()` is referenced in exactly two files:
its own definition and its own module registration. Nothing in `workflows/`, `approvals/`,
`events/`, or any controller ever consults it. Nothing outside `workflow-runtime/` ever enqueues
`wf-run-advance`. The state machine's processors boot, subscribe, and idle forever.

Confirmed by grep across `apps/api/src`:
- `usesStateMachine|modeFor(` — 4 hits, all inside `engine-mode.ts`.
- `WF_RUN_ADVANCE_QUEUE` — 12 hits, all inside `workflow-runtime/`.

---

## 3. Known gaps blocking the WAVE 1 cutover

Ordered by severity. These are the concrete reasons Path B cannot simply be switched on today.

| # | Gap | File | Impact |
|---|-----|------|--------|
| **W1-a** | **No production entry point.** No caller consults `EngineModeService`; `dispatchRun` always uses the legacy engine. | `workflows.service.ts:99` | The durable runtime is unreachable code. |
| **W1-b** | **Advance does not traverse the graph.** `nextNode()` returns `definition.nodes.find(n => !doneIds.has(n.id))` — *array order*, ignoring `edges` entirely. | `run-advance.processor.ts:155` | A CONDITION would execute **both** branches. Correctness blocker; the file's own comment concedes routing is "owned by the legacy walk". |
| **W1-c** | **Lost update on run context.** Each attempt reads `run.context` at job start and later writes `{...context, [outputKey]: value}`. Two concurrent PARALLEL lanes read-modify-write the same row. | `node-attempt.processor.ts:129,168` | Lane B silently erases lane A's output. Worse under the durable runtime than legacy, because lanes are genuinely parallel here. |
| **W1-d** | **Stale context handed to traversal.** `applyDirective` receives `run.context` from before T2, not the post-step context. | `node-attempt.processor.ts:186` | A pause/fan-out persists a context missing the step that just ran. |
| **W1-e** | **No durable resume path.** `WorkflowsService.resumeRun()` (approval approved) always dispatches a legacy `{resume:true}` job. | `workflows.service.ts:576` | An approval on a durable run would resume on the wrong engine. |
| **W1-f** | **Module cycle.** `WorkflowRuntimeModule` imports `WorkflowsModule`, so `WorkflowsModule` cannot import the runtime back to dispatch. | `workflow-runtime.module.ts:48` | Requires the leaf-module fork the codebase already uses for `ApprovalRoutingModule`. |
| **W1-g** | **No end-to-end durable test.** `workflow-runtime-p1.e2e-spec.ts` tests the state writer, reaper, timers and outbox in isolation. No test ever drives advance → attempt → completion. | `test/workflow-runtime-p1.e2e-spec.ts` | The advance/attempt loop has never executed a whole workflow. |

Idempotency is **already present** on run creation: `enqueueRun` dedups on
`companyId_idempotencyKey`, with keys minted for EVENT (`event:<wf>:<eventId>`), WEBHOOK
(`webhook:<token>:<key>`) and MANUAL (`run:<id>:<key>`) triggers. This carries over unchanged.

---

## 4. Queue topology (producers / consumers)

14 registered queues, 12 `@Processor` consumers.

| Queue | Producer | Consumer |
|---|---|---|
| `workflow-run` | `WorkflowsService.dispatchRun` | `WorkflowProcessor` |
| `wf-run-advance` | *(none — dormant)* | `RunAdvanceProcessor` |
| `wf-node-attempt` | `RunAdvanceProcessor`, `TraversalService` | `NodeAttemptProcessor` |
| `wf-timer` | `WorkflowTimerProcessor` (self) | `WorkflowTimerProcessor` |
| `wf-compensate`, `wf-dlq` | registered only | — |
| `knowledge-ingest` | KnowledgeService | ingest processor |
| `event-normalize` | connector webhook | `EventNormalizeProcessor` |
| `gmail-inbound`, `connector-health`, `connector-reconcile` | cron / poll | processors |
| `approval-sla`, `hr-retention`, `marketing-sync` | repeatables | processors |

All consumers are gated by `queueWorkersEnabled()` (`QUEUE_WORKERS_ENABLED`), so the serverless
deployment registers producers without hosting consumers.

---

## 5. Webhook / external entry points

| Route | Verification |
|---|---|
| `POST /connectors/:id/webhook` | signed (`events/normalization/signature-verifier.ts`) |
| `POST /workflows/webhooks/:token` | token in URL, public, **no idempotency key required** |
| `POST /engines/support/webhook` (Chatwoot) | HMAC |
| `POST /engines/marketing/webhook` (Postiz) | — |
| `POST /billing/webhook` (Stripe) | Stripe signature |
| `ALL /admin/cron/:job` | `X-Cron-Secret` / bearer; routes disabled when `CRON_SECRET` unset |

Plane has **no inbound webhook controller** — only `plane-client.service.ts` (outbound). This
matches the plan's WAVE 3.5 expectation that Plane inbound must be implemented.

---

## 6. Authorization, audit, realtime — current surface

- **Authorization:** 72 `@Roles(...)` decorator sites plus service-level checks
  (`ApprovalRoutingService.canDecide`, `WorkflowPermissionService`). There is **no single
  `authorize(actor, action, resource, context)` entry point** — WAVE 2.2 is genuinely unbuilt.
- **Audit:** `modules/audit/audit-log.service.ts`, 35 call sites. Append-only in practice but
  **not hash-chained**; no `previousHash`/`eventHash` columns, no export, no legal hold.
- **Realtime:** `RunEventOutbox` + `OutboxRelayService` exist (5 references) but are written only
  by the dormant state machine. The UI polls at 1 s; no WS/SSE gateway (deferred as P5-01).

---

## 7. Engines

| Engine | Status |
|---|---|
| Postiz (marketing) | client + sync processor + webhook. `publish_now` tracking / reconciliation gaps are WAVE 3.6. |
| Chatwoot (support) | client + HMAC webhook controller. Not on a canonical event pipeline. |
| Plane (pm) | outbound client only. **No webhook, no inbound events.** |
| n8n / Metabase / Meilisearch / Novu / Listmonk / Keycloak / MinIO | not implemented — correctly matches the freeze. |

MinIO is present in `infra/docker-compose.yml` as a *local dev* S3 target behind
`STORAGE_PROVIDER=s3` (default is `local`). It is **not** a production dependency, consistent with
the plan's prohibition.

---

## 8. Test baseline (recorded 2026-08-11)

| Check | Command | Result |
|---|---|---|
| Typecheck (all 5 packages) | `pnpm -w run typecheck` | **PASS** — 5/5 tasks, 13.8 s |
| Unit tests | `pnpm --filter @vaep/api run test:unit` | **PASS — 388 tests, 51 suites**, 33 s |
| E2E suites present | `apps/api/test/*.e2e-spec.ts` | 65 files (62 top-level + 3 under `test/e2e/`) |

E2E requires live Postgres :5433 + Redis :6380 (both up in `docker compose`) and runs serially
(`maxWorkers: 1`, `testTimeout: 30000`). The suite is expected 100% green — a failure is a real
regression, not environment noise.

Browser E2E: **none executed**. Per the plan's WAVE 7 rule, no browser E2E claim is made here.

---

## 9. Database / migration state

- 46 migrations, latest `20260809000000_password_reset_otp`.
- Durable-runtime DDL is already applied: `20260801150000_p1_runtime_state_machine`.
- **GOTCHA (carried forward):** never `prisma migrate dev` to *apply* — the pgvector HNSW index on
  `KnowledgeChunk.embedding` reads as drift and Prisma offers to drop it. Use `prisma:migrate`
  (`migrate deploy`).

---

## 10. Deployment topology

- `apps/web` and `apps/api` are separate Vercel projects.
- Serverless API runs `WORKFLOW_EXECUTION_MODE=inline` with `QUEUE_WORKERS_ENABLED=false`;
  time-based work is driven by Vercel Cron hitting `/admin/cron/:job`.
- Exit ramp to a real worker: deploy `main.ts` with `QUEUE_WORKERS_ENABLED` unset and flip
  `WORKFLOW_EXECUTION_MODE` back to `queue`.

**Consequence for WAVE 1:** the durable runtime is queue-driven by construction (advance and
attempt are separate jobs). It therefore cannot run under `inline`. The cutover flag must be
orthogonal to and gated on execution mode — `state_machine` requires a hosted worker.

---

## 11. Known regressions

None. Typecheck and 388 unit tests are green at baseline.

---

## WAVE 0 gate: **PASSED** — baseline recorded. WAVE 1 may begin.
