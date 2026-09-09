# Cluster 4 — Workflow Templates & Engine Audit

Source: direct code read, 2026-09-09. Evidence hierarchy: executable code > schema > CLAUDE.md (treated as hypothesis, not ground truth). All paths relative to `d:/Vertical AI/platform` unless noted. Classifications restricted to: FULLY IMPLEMENTED, PARTIALLY IMPLEMENTED, BROKEN, UNREACHABLE, MOCK/FAKE, UNUSED, LEGACY, DUPLICATE, PLANNED ONLY, PRODUCTION READY.

---

## A. Workflow Template inventory

### A.1 Two systems — the "coexist" claim in CLAUDE.md is now stale

CLAUDE.md's Wave P3-02 entry says the DB-backed `WorkflowTemplate` model "coexists with the older marketplace code-catalog (`marketplace.catalog.ts` `WORKFLOW_TEMPLATES`, delegate-to-create) — the marketplace shim is untouched." **That is no longer true.** `apps/api/src/modules/marketplace/marketplace.catalog.ts:165-182` and `marketplace.controller.ts:8-29` both carry an explicit "Phase 4 §4" header stating the three marketplace-catalog workflow templates (`recruiting-resume-score-schedule`, `sales-outreach`, `support-triage`) were **removed**, not merely deprecated:

- `MarketplaceCatalog` (`marketplace.catalog.ts:184-193`) exposes only `employees()`/`getEmployee()` — no `templates()` method exists any more.
- `MarketplaceService.catalog()` (`marketplace.service.ts:32-38`) returns `{ employees, skills }` — `workflows` is explicitly commented as "gone."
- The retired names are kept as a **name-only list** (`MARKETPLACE_RETIRED_WORKFLOWS`, `marketplace.catalog.ts:178-182`) for audit traceability, not as live graphs — they used the banned legacy `AI_STEP`/`NOTIFY` node types and were never ported.
- Net effect: this is **not a live duplication** any more. It was consolidated. The DB-backed `WorkflowTemplate` model (`/workflow-templates`) is the sole live workflow-template system today. CLAUDE.md's "coexists" framing is a doc-drift finding in its own right — the memory/CLAUDE.md log has no "Phase 4" entry describing this cleanup.
- Direct consequence, corroborated by Cluster 6: `/marketplace` still renders a "Workflow Templates" section header with nothing under it (`app/(app)/marketplace/page.tsx:41-45`) — dead UI left over from the retirement.

### A.2 First-party catalog — count is 24, not 22

CLAUDE.md states "22 first-party templates — 11 HR + 11 Marketing." Current code (`workflow-templates.catalog.ts:1-15`) aggregates **three** catalogs, not two:

| Catalog file | Count (verified) | Category |
|---|---|---|
| `hr-workflow-templates.catalog.ts` | 11 | HR |
| `marketing-workflow-templates.catalog.ts` | 11 | Marketing |
| `sales-workflow-templates.catalog.ts` | **2** (`sales.whatsapp-lead-qualify`, `realestate.whatsapp-lead-qualify`) | SALES |
| **Total** | **24** | — |

The Sales catalog is a real, undocumented-in-CLAUDE.md addition — well-formed, `requires: {skills:['whatsapp',...], employeeRoles:['SALES'], minPlan:'BUSINESS'}`, and it fixes a real bug in its own comment history (`sales-workflow-templates.catalog.ts:19-27`: an earlier version referenced the wrong trigger-context path, `{{trigger.body}}` instead of `{{trigger.data.body}}`, which would have silently handed the qualification step an unresolved literal string).

### A.3 Template lifecycle table

| Template group | Source | Reachable from UI? | Install → real Workflow? | Passes `validateManifest`/`validateDefinitionStructure`? | Node vocab | Status |
|---|---|---|---|---|---|---|
| HR (11) | First-party catalog, `companyId=null`, seeded on boot (`workflow-templates.service.ts:60-98`) | Yes — `/workflows/templates` → `GET /workflow-templates` (`workflow-templates.controller.ts:46-56`) | Yes — deep-copy transaction, DRAFT workflow + PUBLISHED v1 (`workflow-templates.service.ts:222-254`) | Yes — asserted by `workflow-templates.catalog.spec.ts` + boot seed | `AI_EMPLOYEE_STEP`+`TOOL_ACTION` only, self-checked by `hr-workflow-templates.catalog.spec.ts:39` (`BANNED = {AI_STEP, NOTIFY}`) | FULLY IMPLEMENTED |
| Marketing (11) | Same | Yes | Yes | Yes | Same discipline, own spec also bans `LOOP` (`marketing-workflow-templates.catalog.spec.ts:38`) | FULLY IMPLEMENTED |
| Sales (2) | Same | Yes | Yes | Yes | Same discipline (no dedicated banned-list spec file, but catalog comment states the same rule, `sales-workflow-templates.catalog.ts:4-10`) | FULLY IMPLEMENTED |
| Tenant-authored (`POST /workflow-templates`) | DB, `companyId=<tenant>`, OWNER/ADMIN-gated (`workflow-templates.controller.ts:66-74`) | **UNREACHABLE from the frontend** — Cluster 6 confirmed zero callers of `POST /workflow-templates` in `apps/web/src` | Would be, if called | Yes, same `validateManifest` | **Not restricted to frozen-17** — see A.4 | PARTIALLY IMPLEMENTED (backend-complete, no UI) |
| Marketplace employee templates (11, `marketplace.catalog.ts:17-163`) | Code catalog, unrelated to workflows | Yes, `/marketplace` | Delegates to `EmployeesService.create` | N/A (not a workflow) | N/A | FULLY IMPLEMENTED (separate feature, out of scope here except as context) |
| Marketplace workflow templates (3, retired) | Code, name-list only | No — code deleted, only names remain | No | N/A | N/A | **RETIRED / LEGACY** (correctly retired, not a live defect) |

### A.4 The "frozen-17, no banned AI_STEP/NOTIFY" claim is real but narrower than CLAUDE.md implies

CLAUDE.md's workflow-templates entry says templates use "frozen-17 vocab only (`AI_EMPLOYEE_STEP` + `TOOL_ACTION`; the legacy `AI_STEP`/`NOTIFY` are banned by doc 27 §0.4 and the DB catalog's boot-time `validateManifest` rejects them)". **The second half of that sentence is not accurate as written.**

- `NODE_TYPES` (`packages/types/src/index.ts:1632-1652`) is a **19**-type union that still includes `AI_STEP` and `NOTIFY`.
- `validateDefinitionStructure`/`collectDefinitionIssues` (`apps/api/src/modules/workflows/engine/definition-validator.ts:83-422`) — the function `validateManifest` calls to check a template's definition — validates against `NODE_TYPES`, the full 19-type set. **It does not reject `AI_STEP` or `NOTIFY`.** There is no `INTEGRITY`/`READINESS` rule anywhere in this file that bans them.
- The actual ban is a **17-type allow-list enforced only inside the AI Assist agent** (`apps/api/src/modules/assist/agent/frozen-node-types.ts:19-63`, `isFrozenNodeType`/`rejectionFor`), i.e. it constrains what the conversational graph-authoring tool may *write*, not what the generic template/workflow validator will *accept*.
- The first-party HR/Marketing catalogs stay inside the 17-type vocabulary only because their own unit-test specs assert it (`hr-workflow-templates.catalog.spec.ts:39`, `marketing-workflow-templates.catalog.spec.ts:38`) — a convention enforced by test, not by the shared validator.
- Consequence: **a tenant-authored template via `POST /workflow-templates` (or a hand-built workflow via `POST /workflows`) can legally contain `AI_STEP` and `NOTIFY` today** — nothing in `validateManifest`/`validateDefinitionStructure` stops it. This is currently moot in practice because that endpoint has no frontend caller (A.3), but it is a real, unenforced gap in the "no side door" invariant if that endpoint is ever wired up.

### A.5 A second, older AI-generation path still emits the banned vocabulary — reachable only via a feature-flag default

`WorkflowGeneratorService` (`apps/api/src/modules/workflows/engine/workflow-generator.service.ts`) backs `POST /workflows/generate`, still wired into `workflows.controller.ts` and plan-gated (`PlanGuard`/`@RequirePlan`, per CLAUDE.md). Its own prompt text is the exact G32 gap `frozen-node-types.ts` documents as the reason the newer assist agent exists (`frozen-node-types.ts:12-17`):

- `workflow-generator.service.ts:178`: `'Node "type" must be one of: TRIGGER, RETRIEVE, AI_STEP, TOOL_ACTION, WAIT, CONDITION, NOTIFY, APPROVAL.'` — the legacy 8-type dialect, `AI_STEP`/`NOTIFY` included.
- `workflow-generator.service.ts:218`: its own **fallback template** literally hardcodes `{ id: 'notify', type: 'NOTIFY', config: { message: 'Configure this workflow further.' } }` — a graph this service can hand back to a user that both (a) uses the type `frozen-node-types.ts` calls a trap because it "only writes a log line" in the historical description, and (b) — per A.6 below — is now stale in that specific claim.
- Frontend reachability: `useGenerateWorkflowDraft`/`generateWorkflowDraft` (`apps/web/src/features/workflows/hooks.ts:600-602`, `api.ts:253`) back **`GenerateWorkflowChat.tsx`**, which is rendered from `apps/web/src/app/(app)/workflows/page.tsx:88-92` **only when `!simplifiedWorkflowUX`** (`page.tsx:12,50-52,88`). CLAUDE.md confirms the flag defaults ON. So in a default deployment this path is **dead by configuration, not by code removal** — flipping one env var re-exposes a generator that authors the exact node types the rest of the system spent real engineering effort banning.
- Classification: **LEGACY** (superseded by the `/assist` chat agent, which correctly uses `frozen-node-types.ts`) and **PARTIALLY UNREACHABLE** (gated off by default, not deleted).

### A.6 A stale comment inside the codebase itself (not just CLAUDE.md)

`frozen-node-types.ts:12-17` describes `NOTIFY` as a node that "only writes a log line" and "does NOT message anyone" per "doc 27 §0.4." That description is now **wrong** — `NotifyNodeHandler` (`apps/api/src/modules/workflows/engine/nodes/notify.handler.ts:13-44`) was hardened (its own doc comment narrates the fix) to really deliver through `NotificationsService.workflowNotify` when a node declares recipients (`userIds`/`roles`/`departmentId`); it only degrades to a no-op log line when none are configured — the historical default, not a structural limitation any more. `NODE_CATALOG.NOTIFY.hasSideEffects: true` (`node-catalog.ts:588`) agrees with the current, corrected behaviour. This is a second, independent instance (beyond CLAUDE.md itself) of an authoritative-sounding in-repo comment describing an already-fixed behaviour as still broken — worth a repo-wide sweep for "this only writes a log line" style comments before trusting them.

---

## B. Workflow Engine

### B.1 Lifecycle stage table (both engine modes)

| Stage | legacy_walk (`workflow-engine.service.ts`) | state_machine (`workflow-runtime/*`) | Shared? |
|---|---|---|---|
| Create/Draft/Validate | `WorkflowsService` + `validateStorableDefinition`/`collectDefinitionIssues` | Same | Fully shared — engine-agnostic |
| Version/Publish/Activate | `workflow-version.service.ts`, `assertRunnable` | Same | Fully shared |
| Trigger (MANUAL/SCHEDULE/WEBHOOK/EVENT) | `enqueueRun` is the **sole** run-creation path for every trigger type (`workflows.service.ts:953-1068`) | Same | Fully shared — one dispatcher |
| Engine dispatch | `WorkflowEngine.execute()` checks `engineMode.usesStateMachine(companyId)` and hands off to the durable advance queue if opted in (`workflow-engine.service.ts:199-220`) | `RunAdvanceProcessor`/`NodeAttemptProcessor` | Single decision point, no drift risk found |
| Node execution | `executeNode` → `NodeRegistry.get(type).execute()` (`workflow-engine.service.ts:1162-1174`) | `NodeAttemptProcessor` → same `NodeRegistry.get(type).execute()` (`node-attempt.processor.ts:182`) | **Shared** — both engines call the identical handler instances (`engine/nodes/*.handler.ts`); this is the single biggest de-risking fact in the whole audit — node *semantics* cannot drift between engines even though *control flow* is reimplemented twice |
| Approval gate (explicit APPROVAL node) | Inline in `walkFrom`/`pauseForApproval` (`workflow-engine.service.ts:504-584, 962-965`) | `ApprovalGateService.evaluate` (`approval-gate.service.ts:81-148`) | **NOT shared — duplicated.** Same `ApprovalRequest` row shape, same routing service, explicitly designed to be "byte-compatible" (`approval-gate.service.ts:158-163`) so an approval opened under one engine resolves under the other — but it is two independent implementations of the same rule, not one function two call sites. A future change to the gate logic must be made twice or the engines silently diverge again (exactly what happened once already — see B.3). |
| Approval gate (G25 high-risk TOOL_ACTION) | Inline `pauseIfToolNeedsApproval`/`hasAnyGrantedApprovalThisRun` (`workflow-engine.service.ts:604-716`) | `ApprovalGateService.evaluateToolAction`/`hasAnyGrantedApprovalThisRun` (`approval-gate.service.ts:70-79, 165-286`) | **DUPLICATE**, same caveat as above |
| Retry | **None.** A node failure marks the step+run `FAILED` and returns; no backoff, no re-attempt, no `failureClass` ever written to `WorkflowRun`/`WorkflowStepRun` (confirmed: zero occurrences of `failureClass` in `workflow-engine.service.ts`) | `RetryPolicyService` (`retry-policy.service.ts`) — up to `RETRY_MAX_ATTEMPTS=3` (`workflow-runtime.constants.ts:91`), full-jitter exponential backoff (`RETRY_BASE_MS=1000`/`RETRY_CAP_MS=300000`), 13-way `FailureClass` taxonomy | **DURABLE-ONLY.** Real functional gap, not just an implementation-quality gap — legacy_walk workflows have no retry story at all. |
| Failure classification | Unclassified `error` string only | `FailureClass` enum written to `WorkflowStepAttempt.failureClass` and rolled up to `WorkflowRun` (`run-advance.processor.ts:221-239`) | DURABLE-ONLY |
| SLA/deadline | Watchdog sweep only (`sweepStuckRuns`, 5-min stuck timeout, `workflow-engine.service.ts:281-344`) | `ReaperService.sweepOverdueRuns` (real `deadlineAt` column, `TIMED_OUT` status, `reaper.service.ts:279-301`) plus the watchdog (mutually exclusive by an `attempts:{none:{}}` filter, see B.4) | PARTIALLY SHARED — different mechanisms, deliberately partitioned so they don't race |
| Scheduler | `WorkflowsService.fireSchedule` → BullMQ repeatable (`addSchedule`) **or** `/admin/cron/workflow-schedules` HTTP sweep in inline mode — both converge on the same `fireSchedule`/`enqueueRun` call (`workflows.service.ts:1110-1152`) | Same entry point; the durable engine only changes what happens *after* the run row is created | Fully shared |
| WAIT node | Bounded sleep, capped `MAX_WAIT_MS=10s`, same cap for BOTH modes (`simple.handlers.ts:3,38-53`) | Same handler (shared node registry) | Shared, and **still not durable in either mode** — see B.5 |
| EVENT single-active enforcement | `assertNoConflictingEventTrigger` at `activate()` (`workflows.service.ts:522-556`) | Same (engine-agnostic, checked before dispatch) | Fully shared |
| Idempotency | `companyId_idempotencyKey` unique constraint + P2002 race-safe fallback, namespaced per trigger type (`event:`, `webhook:`, `run:`, schedule-slot key) (`workflows.service.ts:970-1056`) | Same — created once in `enqueueRun`, both engines execute against the same row | Fully shared |

### B.2 `WORKFLOW_ENGINE_MODE` / `WORKFLOW_EXECUTION_MODE` interaction — CLAUDE.md's claim verified accurate and current

Confirmed exactly as documented, with no drift found:

- `EngineModeService` (`workflow-runtime/engine-mode.ts:36-40`) defaults to `state_machine` unless `WORKFLOW_ENGINE_MODE=legacy_walk` is set explicitly (opt-OUT design, so a typo lands on the safer engine).
- `modeFor()` (`engine-mode.ts:74-87`) **unconditionally returns `legacy_walk` whenever `isInlineExecution()` is true**, regardless of `WORKFLOW_ENGINE_MODE` — because `inline` has no worker to consume the durable engine's advance/attempt jobs.
- This is loudly logged at boot (`engine-mode.ts:61-71`, an ERROR-level line) and surfaced at runtime via `GET /admin/runtime` (`apps/api/src/modules/admin/dlq.controller.ts:66-108`), which reports `durableExecution: boolean` computed from `EngineModeService.isDurableActive()` (`engine-mode.ts:100-102`) — i.e. ground truth, not configured intent. The endpoint's own doc comment (`dlq.controller.ts:49-61`) narrates exactly the bug CLAUDE.md describes: `isDurableActive()` existed and had no caller until this endpoint was added.
- **Practical consequence not fully spelled out in CLAUDE.md**: because `inline` always forces `legacy_walk`, and `legacy_walk` has zero retry/failureClass support (B.1), **any serverless/Vercel-shaped deployment of this platform — the shape the codebase explicitly built `inline` mode to support — runs every workflow on the engine with no retry, no backoff, and no failure taxonomy.** The durable engine's substantial reliability investment (leases, reaper, retry, `OUTCOME_UNKNOWN` safety) is unreachable in that deployment shape by construction, not by oversight — but it means "the durable engine is THE engine" (`engine-mode.ts:12-15`) is only true for a worker-backed deployment.

### B.3 The "5 durable-only gaps" CLAUDE.md cites — verified fixed, with inline evidence

CLAUDE.md ("Durable engine is the DEFAULT") claims 5 gaps were found and fixed when the durable engine was turned on for the first time. Checked each against current code:

| Gap | Evidence it is fixed today |
|---|---|
| High-risk `TOOL_ACTION` executing with no approval gate (G25) | `ApprovalGateService.evaluate` explicitly branches on `node.type === 'TOOL_ACTION'` before the generic APPROVAL check (`approval-gate.service.ts:99-101`), with a doc comment naming the exact regression: "`stripe.create_payment_link` and `postiz.publish_now` executed with no human gate at all." |
| Disabled node executed instead of skipped | `run-advance.processor.ts:290-333` — explicit `if (next.disabled)` branch writes a `SKIPPED` step row and routes past it, with a doc comment naming the original bug: "a deactivated 'email the candidate' step would have sent the email." |
| JOIN losing fanned-out lane outputs | `run-advance.processor.ts:338-360` — comment: "the durable path never [set `context.__lanes`]... Fan-out worked and fan-in silently lost the results," now fixed by merging lane output before `recordLaneArrival`. |
| LOOP only running once | `traversal.service.ts:119-134` — comment: "`readLoopCursor` existed for precisely this and had no caller... exactly like the runtime itself before WAVE 1," now driven by `continueLoopIfBody`. |
| (Attempt-lease / stalled-PENDING recovery, implied by the same wave) | `reaper.service.ts:83-121` (`sweepStalledPendingRuns`) + `workflow-engine.service.ts:304-327` (engine-aware watchdog filter) — cross-checked, mutually exclusive by construction (see B.4). |

All five read as genuinely fixed, with the fix comments themselves serving as regression documentation. No evidence of any of the five having regressed.

### B.4 Watchdog/reaper mutual exclusion — correctly partitioned

The legacy 5-minute watchdog (`workflow-engine.service.ts:281-344`) and the durable reaper (`reaper.service.ts`) both sweep for stuck runs but are explicitly designed never to race: the legacy watchdog filters `attempts: { none: {} }` and then additionally re-filters by `!engineMode.usesStateMachine(companyId)` (`workflow-engine.service.ts:304-327`, a documented second-layer fix — gap G-B3 — because a durable run can be `PENDING` with zero attempt rows too, before its first advance job lands). The reaper's own `sweepStuckRuns` requires `attempts: { some: {} }` (`reaper.service.ts:261-277`) and its `sweepStalledPendingRuns` is scoped to `usesStateMachine` companies only (`reaper.service.ts:112-113`). Verified no gap in the partition — every `PENDING`/`RUNNING` run is owned by exactly one sweep.

### B.5 WAIT node and `WorkflowRunTimer` — durable timer infrastructure is real but has zero producers

- `WaitNodeHandler` (`engine/nodes/simple.handlers.ts:30-53`) is a plain bounded sleep, capped at `MAX_WAIT_MS` (10 000 ms), identical in both engines because both call the same handler via the shared `NodeRegistry`.
- The `WorkflowRunTimer` model exists in the schema and the reaper actively sweeps it (`reaper.service.ts:228-247`, `sweepDueTimers`), and `WorkflowTimerProcessor` runs that sweep every `WF_TIMER_SWEEP_EVERY_MS` on a repeatable job (`timer.processor.ts:36-45`).
- **However, a repo-wide search for `workflowRunTimer` found exactly two files: `reaper.service.ts` and its own spec.** Nothing in the codebase ever calls `prisma.workflowRunTimer.create(...)`. The durable-timer machinery — the piece that would make WAIT (or any future timed pause) genuinely resumable across a restart — is fully wired on the *read* side and has **no writer anywhere**. It is currently dead code: the sweep will always find zero rows.
- Classification: **UNUSED** (the timer sweep itself) / **PLANNED ONLY** (durable, resumable WAIT — the doc comment in `simple.handlers.ts:38-42` says "revisit if WAIT ever becomes durable/resumable," confirming this was never wired, not regressed).

### B.6 EVENT trigger + idempotency — solid, matches CLAUDE.md

`fireEvent` (`workflows.service.ts:571-615`) correctly scopes by `connectorId` when the trigger declares one, evaluates the condition DSL, and derives a per-workflow idempotency key `event:${wf.id}:${eventId}` so the same canonical event cannot double-fire the same workflow. `fireWebhook` and `fireSchedule` follow the identical pattern with their own namespaces (`webhook:`, schedule-slot key). All three converge on `enqueueRun`'s single `companyId_idempotencyKey` unique-constraint dedup with a `P2002` race fallback that returns the winning row rather than erroring. No gaps found here.

---

## Top 5 most severe findings

1. **CLAUDE.md's "22 first-party templates, coexists with the marketplace catalog" description is stale on both counts.** The real number is 24 (11 HR + 11 Marketing + 2 Sales, the Sales catalog undocumented in CLAUDE.md), and the marketplace code-catalog workflow templates were actually **retired** in a "Phase 4 §4" cleanup (`marketplace.catalog.ts:165-182`, `marketplace.controller.ts:8-29`) that CLAUDE.md's module-status log never recorded — the two-system duplication this audit was asked to verify no longer exists as live code, only as a name-only historical record.

2. **The "frozen-17, banned AI_STEP/NOTIFY" rule is enforced only inside the AI Assist agent and by first-party catalog unit tests — not by the shared `validateManifest`/`validateDefinitionStructure` validator every template and workflow actually passes through.** A tenant-authored template (`POST /workflow-templates`, currently unreachable from the frontend per Cluster 6) or a hand-built workflow can legally contain `AI_STEP`/`NOTIFY` today. Separately, the OLDER `POST /workflows/generate` (`WorkflowGeneratorService`) still actively emits both banned types — including in its own hardcoded fallback template (`workflow-generator.service.ts:218`) — and remains fully wired behind `GenerateWorkflowChat.tsx`, reachable the moment `NEXT_PUBLIC_SIMPLIFIED_WORKFLOW_UX` is set to `false` (its documented, supported rollback path).

3. **legacy_walk has no retry mechanism and never writes a `failureClass` at all**, while `WORKFLOW_EXECUTION_MODE=inline` unconditionally forces every run onto legacy_walk regardless of `WORKFLOW_ENGINE_MODE`. This means the serverless/Vercel deployment shape this codebase explicitly built `inline` mode to support gets zero retry, zero backoff, and zero failure taxonomy for every workflow run — the durable engine's substantial reliability investment (leases, reaper, retry, `OUTCOME_UNKNOWN` handling) is architecturally unreachable in that shape, not merely under-tested in it.

4. **The G25 approval gate (and the ordinary APPROVAL-node gate) is duplicated, not shared, between the two engines** (`workflow-engine.service.ts`'s inline `pauseIfToolNeedsApproval`/`hasAnyGrantedApprovalThisRun` vs. `ApprovalGateService.evaluateToolAction`/`hasAnyGrantedApprovalThisRun`). The two implementations are deliberately kept "byte-compatible" by convention and comment discipline, and today they agree — but this is the exact category of divergence that already caused a real production-safety gap once (G25 shipping in the durable engine with no gate at all). A future change to approval-gating logic must be made twice by hand, in two files, with no shared test or type forcing them to match.

5. **The durable, resumable-timer infrastructure (`WorkflowRunTimer` + the reaper's `sweepDueTimers`) is fully built on the read side and has zero writers anywhere in the codebase.** WAIT remains a bounded (max 10s) in-process sleep in both engine modes, identical to before the durable engine existed. This is the one piece of the durable-engine story that is still purely aspirational — verified dead code today, not a regression.
