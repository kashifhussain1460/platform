# Workflow Backend — Production Completion Report

**Date:** 2026-08-05
**Mode:** Production Backend Completion — worked P0/P1 from `implementation-gap-audit.md` in dependency order. Read-only sources of truth: L1 architecture, L2 specs, frozen node contracts (doc 26), DB migration plan, implementation plans, and the gap audit.
**Rules honored:** no rewrites of working modules, no `any`-hiding, no fake/stub production behavior, no silent catches, no disabled security checks, no removed tests, no unrelated refactors. Protected: tenant isolation, RBAC, secrets, idempotency, back-compat, auditability.

## Verification (whole pass)
- **Typecheck:** `tsc --noEmit` clean.
- **Lint:** `pnpm -w run lint` clean (0).
- **Unit:** 327 passed / 41 suites (was 38 — 3 new specs).
- **E2E (touched + adjacent, all green):** workflow-triggers, skills, per-employee-skill-connections, workflow-tool-approval-gate, workflow-approval, approvals, approval-routing, approval-sla, rbac-users, audit-log, inline-execution, assist-agent, workflow-runtime-p1, workflow-runtime-concurrency, workflow-run-controls, event-ingestion, connector-health.

## Completed

| Item | Change | Files | Tests |
|---|---|---|---|
| **P0-1** reaper cross-engine race | `sweepStuckRuns` filters `attempts:{some:{}}` so it only touches runs that entered the durable engine; legacy runs are never re-enqueued/re-executed | `reaper.service.ts` | `reaper.service.spec.ts` (new) |
| **P0-2 / P1-2** idempotency | `enqueueRun` dedups on `WorkflowRun.idempotencyKey` (`@@unique([companyId,idempotencyKey])`), P2002-race-safe. Webhook keys on `Idempotency-Key`/`X-GitHub-Delivery`; run endpoint on `Idempotency-Key`; `fireEvent` on canonical event id | `workflows.service.ts`, `webhooks.controller.ts`, `workflows.controller.ts` | `workflow-triggers.e2e` (webhook + run dedup) |
| **P1-1** skill-grant enforcement | `runTool` gates on an ENABLED `EmployeeSkill` when attributed to an employee; company-wide (no employeeId) allowed — back-compat | `skills.service.ts` | `skills.service.spec.ts` (new) |
| **P1-4** serverless inbound | new cron jobs `gmail-poll` + `connector-reconcile` + `vercel.json` entries | `admin/cron.controller.ts`, `events.module.ts`, `admin.module.ts`, `vercel.json` | `inline-execution.e2e` |
| **P1-5** audit events | human approve/reject/modify (at `claim`), SLA escalate/expire/auto-decide, and status-only user disable/reactivate now write `AuditLog` | `approval.service.ts`, `approval-sla.service.ts`, `users.service.ts` | `rbac-users.e2e` |
| **P1-8** secret taint boundary | `runTool` redacts resolved secret + credential values from persisted `SkillExecution.error`/result and the returned call | `skills.service.ts`, `common/crypto/redact-secrets.ts` (new), `executors/skill-executor.ts`, `tool-action.handler.ts` | `redact-secrets.spec.ts` (new) |
| **P1-9** tenant scoping | `resumeRun`/`cancelRun` now take `companyId` and query `{id, companyId}`; all callers updated | `workflows.service.ts`, `approval.service.ts`, `approval-sla.service.ts` | covered by approvals/SLA e2e |

## Addressed by fencing (activation deferred to L2)
- **P1-3 durable engine.** Its one unsafe behavior (P0-1) is fixed; it is now provably unreachable by accident. Full activation — writing `deadlineAt` so `TIMED_OUT` can fire, a `WF_COMPENSATE_QUEUE` processor, and an `EngineModeService` cutover with the G25 approval gate re-verified in the state-machine path — is a scoped L2 plan, intentionally not attempted here.

## Deferred with rationale (not faked)
- **P1-6 Chatwoot/Plane → workflow triggering.** Firing from the Support engine hits a real module cycle (`Workflows → Skills → Support → Workflows`, confirmed in code) and the canonical normalize path is worker-gated (dead on serverless, same class as P1-4). Plane additionally has no controller and needs an event-type taxonomy + a tenant-resolution decision (`chatwootAccountId` is not `@unique`). This needs an explicit design (an event-bus seam, or `forwardRef` + a serverless-safe synchronous fire) — outside "smallest safe change," so deferred rather than hacked.
- **P1-7 real reconciliation pollers.** `hasPoller()` is hardcoded `false`; real catch-up requires live per-provider cursor/history APIs and credentials. It cannot be implemented as verifiable production behavior in an offline pass, and a stub would be fake behavior (forbidden). The cron route now exists (P1-4), so this reduces to implementing real per-provider cursor logic under live test.

## Notes / follow-ups (unchanged priority)
- Add a `@@unique` on `chatwootAccount.chatwootAccountId` (P1-6 prerequisite; flagged in the audit).
- Webhook idempotency covers explicit `Idempotency-Key` and GitHub's `X-GitHub-Delivery`; other providers that redeliver with a different/no header still need their delivery-id header mapped in the controller.

## Can backend work continue?
Yes. All P0 items and the tractable, offline-verifiable P1 items are complete and green. The two remaining P1 items (P1-6, P1-7) are explicitly scoped design/live-integration work, and the durable-engine activation (P1-3) is a deliberate L2 plan — none blocks the current legacy-walk production path, which is now free of the two P0 correctness hazards.
