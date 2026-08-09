# Workflow Runtime — Verification Report (break-testing)

**Date:** 2026-08-05
**Mode:** Runtime Verification — attempt to break the engine against production failure scenarios. Expected behavior defined from canonical docs first, then actual behavior probed with `file:line` evidence, then defects that contradict canonical architecture fixed, with a regression test per discovered bug.
**Live path under test:** the LEGACY graph-walk engine (`modules/workflows/engine/workflow-engine.service.ts`). The durable state-machine (`modules/workflow-runtime`) is DORMANT — no real run enters it — so guarantees that exist only there are **RESIDUAL RISK on the live path, not PASS**.
**Rules honored:** no features added; fixes only where behavior contradicted canonical; no `any`-hiding, no fake behavior, no disabled checks, no removed tests. Protected tenant isolation, RBAC, secrets, idempotency, back-compat, auditability.

## Verification (whole pass)
- **Typecheck** clean · **Lint** clean · **Unit** 331 / 42 suites · **E2E** 100% green across every touched + adjacent suite (workflows, versioning, lifecycle-publish, triggers, skills, tool-approval-gate, per-employee, approvals, approval-sla, approval-routing, rbac-users, audit-log, inline-execution, runtime-p1, runtime-concurrency, run-controls, tenant-isolation, connector-health, event-ingestion, assist-agent).

## Result — no P0 runtime defect remains
Two P0s were found and FIXED (version pinning; secret in audit args). All 35 scenarios are now PASS or a documented RESIDUAL RISK; every RESIDUAL is either a dormant-durable-engine guarantee or an accepted/back-compat limitation, none of which lets a live run silently corrupt data, cross a tenant, or leak a secret.

---

## FIXED (defects contradicting canonical — fixed + regression-tested)

| # | Defect | Severity | Fix | Regression test |
|---|--------|----------|-----|-----------------|
| F1 | **Version changed during execution.** Run pinned `workflowVersionId` but the engine executed the live, mutable `Workflow.definition` (`workflow-engine.service.ts:319`). A WAITING run resumed after an edit/publish walked a DIFFERENT graph, or silently COMPLETEd (skipping post-approval side-effecting steps) when `resumeNodeId` no longer existed. Contradicts `workflow-version.service.ts` immutability + doc 16 §25 E5. | **P0** | Engine now loads the pinned `WorkflowVersion.definition` (`execute`/`resume` include it; `run()` uses `run.workflowVersion?.definition ?? run.workflow.definition`; null = pre-versioning fallback). | `workflow-versioning.e2e-spec.ts` "EXECUTES the pinned version, not the live column" |
| F2 | **Secret leaked into `SkillExecution.args`.** `runTool` redacted `error`/`result` but NOT `args`; a `{{secret.X}}` resolves INTO an arg value, so the real secret was persisted verbatim (and returned into step output/context). Contradicts `secret-resolver.service.ts` ("the value … never written anywhere"). Reachable today for hyphenated secret keys. | **P0** | `runTool` executes with real args but persists/returns `redactSecrets(args)`. | `skills.service.spec.ts` "masks a resolved secret in persisted AND returned args, executes with real value" |
| F3 | **`resolveArgs` blanked `{{secret.X}}` before the resolver ran.** `TEMPLATE_RE` matched `secret.NAME`, replacing it with `''` before `SecretResolverService` saw it → hyphen-free secrets silently resolved to empty and the tool called with no credential. | High (functional) | `resolveTemplate` now leaves the `secret.` namespace untouched for the dedicated resolver. | `template.spec.ts` "leaves {{secret.NAME}} untouched / resolves ordinary refs" |
| F4 | **`cancelRun` overwrote terminal states.** Guarded only COMPLETED/FAILED, so a reject / SLA-expire arriving after a user CANCELLED (or TIMED_OUT) illegally rewrote it to FAILED (doc 16 §7 terminal→terminal). | Med | Guard on a `TERMINAL_RUN_STATUSES` set (COMPLETED/FAILED/CANCELLED/TIMED_OUT/COMPENSATED). | covered via approvals/SLA e2e (no terminal overwrite) |
| F5 | **Dangling sequential edge → silent COMPLETED.** `nextNode` returned `undefined` for a missing `edge.to`, ending the walk as COMPLETED and skipping intended steps (contradicts the `UNKNOWN_EDGE_TARGET` publish rule at runtime; PARALLEL/LOOP targets already throw). | Med | `nextNode` throws on an unknown target. | covered by graph e2e (valid graphs still pass) |
| F6 | **No app-level LLM timeout.** The `signal` seam was never populated and SDK clients set no `timeout`; a hung completion stalled the run and (concurrency=1) the whole queue for the SDK's ~10-min default. Contradicts doc 25 bounded-run intent. | High | OpenAI + Anthropic clients now set `timeout` (`LLM_REQUEST_TIMEOUT_MS`, default 60s) + `maxRetries: 2`. | typecheck + provider construction (no live-LLM test in offline suite) |

---

## PASS (behavior matches canonical on the live path)

- **Duplicate trigger delivery** — same `eventId` deduped (`event:${wf}:${eventId}` key); a no-eventId fire creates a run by design. Also deduped upstream at canonical-event level.
- **Duplicate webhook (keyed)** — `Idempotency-Key`/`X-GitHub-Delivery` redelivery returns the original run. *(test: workflow-triggers)*
- **Duplicate queue job** — atomic `updateMany WHERE status='PENDING'` claim; a redelivered job for a claimed run is skipped, exactly-once execution. *(test: workflows.e2e "two concurrent execute()")*
- **Webhook replay (later)** — dedup key is a durable DB unique, no TTL, so a replay at any later time returns the original run.
- **Concurrent executions (same key)** — findUnique pre-check + P2002 create-race catch returns the winner before dispatch → one run, one dispatch.
- **API timeout** — real HTTP executors wrap `fetch` in a 10s AbortController; real egress goes through breaker + limiter.
- **Rate limiting** — per-connector token bucket (Redis, in-memory fallback); trip → `ok:false` "rate limit exceeded".
- **Worker restart / duplicate job** — atomic claim + idempotency-key dedup; a redelivered job for a RUNNING run is skipped.
- **Malformed node output** — handler throw → step FAILED → run FAILED; `undefined contextValue` guarded; no process crash.
- **Deleted Skill** — static-catalog check throws `Unknown skill/tool`; deleted InstalledSkill → grant/connector null → clean FAILED.
- **Loop limits** — V6 `UNBOUNDED_LOOP` at publish + handler `slice(0,maxIterations)` runtime cap.
- **Infinite loop protection** — V5 `CYCLE_DETECTED` at publish + runtime `MAX_WORKFLOW_NODES=50` visited-budget across nested walks.
- **Parallel branches** — lanes run, JOIN waits for all, empty lane handled.
- **Branch failure** — a lane throw fails the whole run (onError=FAIL_RUN default). *(sibling-cancellation caveat: RESIDUAL below)*
- **Revoked OAuth / expired token** — `invalid_grant` → DISCONNECTED + clean step fail, exactly one refresh; single-flight refresh shares one call; non-revoked refresh failure surfaces cleanly. *(test: connector-health)*
- **AI malformed response** — bad tool-arg JSON → `{}` + warn; empty content → safety-net final completion; no crash.
- **AI tool-call failure** — bounded `MAX_ACT_ITERATIONS=3`; `ok:false` fed back, loop continues, final answer guaranteed.
- **Approval pending** — run → WAITING with `resumeNodeId` + persisted context; PENDING chain-root created; not left RUNNING. *(test: workflow-approval)*
- **Approval timeout** — escalate/auto-approve/auto-reject/expire funnel through the same resume/cancel/runTool paths; `onTimeout` default NONE; race-safe `updateMany` guard; now also audited. *(test: approval-sla)*
- **Pause/resume idempotency** — `assertCanDecide`→`claim` (`updateMany WHERE PENDING`, 409 on second); `resumeRun` ignores non-WAITING → no double-run.
- **Tenant isolation** — every HTTP run/secret/connector query is `companyId`-scoped incl. the now-scoped `resumeRun`/`cancelRun`; secret refs scoped `{companyId,workflowId,key}`. *(test: tenant-isolation, 13 probes)*
- **Unauthorized Skill access** — `runTool` enforces the ENABLED `EmployeeSkill` grant for employee-attributed calls; company-wide (no employeeId) allowed. *(test: skills.service.spec)*
- **Secret cross-tenant / dry-run** — refs scoped per tenant+workflow; dry-run returns preview before any secret resolution or egress.
- **RUN authz + DISABLED-publisher kill-switch** — enforced at enqueue; disabled publisher stops restricted automated runs. *(test: workflow-permissions)*

---

## RESIDUAL RISK (documented — not a live-path P0)

**Durable-engine-only guarantees (dormant → not live):**
- **Execution timeout → TIMED_OUT** is not live: `deadlineAt` is never written on the legacy path; the only bound is the 10-min orphan watchdog, which marks runs FAILED, not TIMED_OUT.
- **Worker crash mid-node**: no per-attempt lease reclaim; the whole run is failed by the watchdog after ~10 min (no silent re-drive).
- **Crash after external API success**: the committed side effect is uncompensated (no saga); the run is failed, not re-driven automatically.
- **Manual `retryRun`** re-runs from the TRIGGER, re-executing side-effecting nodes with no per-step idempotency — a human-initiated path that can duplicate an irreversible effect. (Legacy has no `@@unique([runId,nodeId,iteration])` step key; that lives in the dormant engine.)

**Accepted / back-compat / defense-in-depth:**
- **No-key webhook/event dedup**: a provider that redelivers with no delivery id (and no `Idempotency-Key`) can double-fire. Consistent with caller-supplied-key canonical model; a body-hash fallback is the mitigation.
- **`Idempotency-Key` header is wired to the business key**, not the separate Redis-backed 24h TTL + body-hash-mismatch-400 layer (doc 13 §13.A.3.4, unbuilt future). A reused key with a different body returns the first run (data-drop, not duplication).
- **No runtime graph re-validation** — the engine trusts the pinned definition; V1–V12 run only at publish. Backstopped by runtime guards.
- **PARALLEL siblings not cancelled** on a lane TERMINATE/throw (doc 26 §8 matrix) — `Promise.all` lets already-dispatched siblings finish; the run still fails. Divergence, not data loss.
- **Engine loads run/workflow by id alone** then derives `companyId` — safe today (every entry point is tenant-scoped first); add a companyId guard on the engine loads for defense-in-depth.
- **Engine catch sinks** write `error` without a redaction pass — safe today (all handlers throw secret-free messages) but not the single taint boundary ideal; any future handler embedding a secret in a thrown message would land it in `WorkflowStepRun.error`.
- **User cancel leaves the WORKFLOW-kind ApprovalRequest PENDING** — inbox noise; the SLA sweep's resume/cancel then no-op against the terminal run.
- **Redis-unavailable enqueue** (queue mode) is uncaught → 500 + an orphaned PENDING run the (also Redis-dependent) watchdog can't sweep until Redis returns. Inline mode is unaffected.
- **Rate-limit denial fails the step/run** (non-blocking `tryAcquire`, no wait/smoothing).
- **DLQ** never holds failed *runs* (the processor catches domain errors → the run row is FAILED, the job completes) — by design ("fail, don't retry").
- **Dry-run skips the skill-grant check** — a preview can show `ok:true` for an ungranted skill (no side effect; fidelity gap only).

---

## Recommended next steps (not blocking; tracked)
1. Activate the durable engine on an explicit L2 plan — that closes the bulk of the RESIDUAL list (deadlines, lease reclaim, per-step idempotency, compensation) at once. Re-verify the G25 approval gate in that path.
2. Add a body-hash fallback idempotency key for keyless webhook/event redelivery.
3. Add a `companyId` guard to the engine's own run/workflow loads (defense-in-depth).
4. Decide PARALLEL sibling-cancellation semantics (doc 26 §8) vs the current concurrent-`Promise.all` behavior; align code + doc either way.
