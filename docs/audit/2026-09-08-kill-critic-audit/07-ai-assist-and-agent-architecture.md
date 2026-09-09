# Cluster 7 — AI Assist Full Trace + AI Employee/Agent Architecture Audit

Source: direct code read, 2026-09-09. Evidence hierarchy: executable code > schema > docs. All paths
relative to `d:/Vertical AI/platform` unless noted. Every claim in the task prompt (from `CLAUDE.md`,
project memory and doc 30/31) was treated as a hypothesis and re-verified against the actual files listed
below — not assumed true.

**Correction to the task brief up front:** AI Assist is **not** spec-only. `docs/architecture/workflow-system/30-orlixa-ai-assist-spec.md`
was a spec, but the module at `apps/api/src/modules/assist/*` + `apps/web/src/features/assist/*` +
`apps/web/src/app/(app)/assist/*` is a fully built, wired, non-mock conversational workflow builder — a
different (and later, superseding) feature from the older `POST /workflows/generate` one-shot generator
CLAUDE.md also describes. Both endpoints exist in the codebase today; `/assist/*` is the one the `/assist`
route actually calls.

---

## A. AI Assist full trace

### A.0 Module inventory (files actually read for this audit)

| Layer | File |
|---|---|
| Session lifecycle | `apps/api/src/modules/assist/assist.service.ts`, `.controller.ts`, `.module.ts`, `dto/assist.dto.ts`, `assist.mapper.ts`, `assist.constants.ts` |
| Agent loop | `apps/api/src/modules/assist/agent/assist-agent.service.ts` |
| Tools | `agent/assist-read-tools.ts`, `agent/assist-write-tools.ts`, `agent/assist-test-tool.ts`, `agent/assist-tool-registry.ts` |
| Graph safety | `agent/graph-patch.ts`, `agent/graph-references.ts`, `agent/frozen-node-types.ts` |
| Prompt | `agent/assist-prompt.ts` |
| Streaming | `sse/assist-sse.ts` |
| Frontend feature | `apps/web/src/features/assist/{api.ts,hooks.ts,useAssistStream.ts,components/*}` |
| Frontend routes | `apps/web/src/app/(app)/assist/page.tsx`, `assist/[sessionId]/page.tsx` |

### A.1 Hop-by-hop trace

| Hop | Real or stubbed | Evidence |
|---|---|---|
| **User Prompt** | Real | `AssistPage` composer → `POST /assist/sessions {prompt}` → stored as first `AssistMessage` (`assist.service.ts:71-85`); no canned responses found. |
| **Intent** | Real (agent-driven, no separate intent classifier) | The LLM itself decides what to do via a bounded tool-calling loop (`assist-agent.service.ts:104-249`); no keyword/regex intent router exists — intent IS the model's tool choices. |
| **Employee Resolution** | Real, but **assist never creates or configures an employee** | `list_employees` (`assist-read-tools.ts:176-222`) reads `AiEmployee` rows filtered `status:'ACTIVE'` only (G37 fix). If no employee fits a role, the prompt (`assist-prompt.ts:66`) instructs the agent to leave `employeeId` blank and tell the user which role to hire — **no auto-hire tool exists** (confirmed: `makeWriteTools` = `[proposeGraph, requestConnection, finish]`, `makeTestTools` = `[patchGraph, dryRunTest]` — none touches `AiEmployee`). |
| **Skill Resolution** | Real | `list_skills` (`assist-read-tools.ts:99-168`) reads real `InstalledSkill` rows + `SkillCatalog` tool contracts (full `parameters`, not just names — closes G34). `resolveReferences` (`graph-references.ts:55-102`) checks the skill/tool pair is real **before** checking whether it's connected, deliberately (comment at `:66-74` documents a real bug this ordering fixed). |
| **Connection Resolution** | Real, live-wired | `request_connection` tool (`assist-write-tools.ts:50-100`) + in-chat `SkillRequirementCard.tsx` + OAuth `returnTo=/assist/<sessionId>` (`SkillRequirementCard.tsx:193`) + auto-resume on the not-ready→ready edge, guarded by 3 refs (`SkillRequirementCard.tsx:105-118`). Confirmed still wired end to end as of this pass — this is the "doc 30 §12" flow project memory flagged as shipped 2026-08-07, and it is still live, not regressed. |
| **Knowledge Resolution** | Real, but **not surfaced as a first-class assist concept** | `RETRIEVE` is in the frozen-17 (`frozen-node-types.ts:31`) and gets validated the same as every other node type, but no `list_knowledge` read-tool exists — the agent has no way to check what's actually in the knowledge base before wiring a `RETRIEVE` step (unlike skills/employees, which it explicitly enumerates first). Minor gap, not a blocker. |
| **Workflow Generation** | Real | `propose_graph` (whole-graph, for creation) / `patch_graph` (ops-based, for edits) — `assist-write-tools.ts:227-448`, `assist-test-tool.ts:50-147`. Both run the **same** `collectDefinitionIssues` publish uses (`assist-write-tools.ts:393`, `assist-test-tool.ts:108`) — see A.4. |
| **Graph** | Real, held server-side | Draft lives on `AssistSession.draftDefinition`/`draftVersion` (Prisma `Json`), never on a real `Workflow` row until accept (doc 30 AD-30-05, confirmed: `workflows.service.ts:236-239` filters `isAssistScratch:false` from the list, and dry-run tests use a scratch `Workflow` deleted in a `finally` — `assist-test-tool.ts:209-259`). |
| **Validation** | Real, shared with manual publish | See A.4 below — this is the strongest-verified hop. |
| **Persistence** | Real, explicit human action | `POST /assist/sessions/:id/accept` (`assist.controller.ts:166-174` → `assist.service.ts:138-191`), OWNER/ADMIN-gated **in the service**, not just a decorator (deliberately, per the class doc at `assist.service.ts:44-50`, to avoid repeating "G36" where a MEMBER could generate a draft they could never save). |
| **Publish** | Real, unchanged path | Accept calls the ordinary `WorkflowsService.create()` (`assist.service.ts:161-169`) — "no assist-specific bypass" is true: same validation, same audit, same `ownerUserId` semantics as a hand-built workflow. |
| **Runtime** | Real, and deliberately narrow | See A.3 — `AI_EMPLOYEE_STEP` delegates to the exact same runtime as chat, with tools forcibly disabled. |

### A.2 Answers to the numbered questions

**1. Does AI Assist select/create the correct AI Employee identity, or does it generate an ownerless graph?**
Neither, precisely — it's a *third* thing: the agent **binds to an existing, ACTIVE employee by id** (`assist-write-tools.ts` frozen-node check + `graph-references.ts:105-135`), matched to the task's role by prompt instruction (`assist-prompt.ts:61-65`, with a live-QA anecdote of the bug this replaced: HR being handed a RECRUITER's CV-screening task). If no matching employee exists it leaves the step **unassigned but explicitly flagged** as `unresolved` (not silently dropped, not auto-hired). So: real employee resolution against real data, zero creation capability.

**2. Does a generated TRIGGER node become the real `Workflow.triggerType`/`triggerConfig`, or is that translation missing?**
🔴 **Missing — confirmed by reading the code, not inferred.** The frozen-17 `TRIGGER` node type has `configSchema: []` — **zero configurable fields** (`node-catalog.ts:99-110`). `Workflow.triggerType` defaults to `MANUAL` at the schema level (`schema.prisma:914`) and is set **only** via a separate `PATCH /workflows/:id` path (`workflows.service.ts:318-336`) — i.e. only through the manual `TriggerPanel`/`TriggerInspector` UI. `AssistService.accept()` calls `WorkflowsService.create()` with `{name, description, definition}` only (`assist.service.ts:161-169`); `create()` never reads or writes `triggerType`/`triggerConfig` (`workflows.service.ts:198-228`). **Net effect:** a user can prompt "When a CV arrives by email, screen it…", the agent will faithfully build every downstream step, `dry_run_test` it, and accept it — and the resulting `Workflow` row is `triggerType: MANUAL`. Nobody is told this. `evaluateReadiness` (`workflow-readiness.ts:159-186`) only fails the TRIGGER check for `SCHEDULE`/`EVENT` with missing config; `MANUAL` is unconditionally `PASS` (`describeTrigger` default case: `"Manual — someone starts it"`, `:78`). So the workflow reports **ready to publish and ready to run**, while never actually firing on the event the user described until a human separately opens the Trigger panel and reconfigures it. This is a real instance of the "silent-success" defect class (green run/green readiness, wrong behaviour) and it is **not** caught anywhere in the assist pipeline — `dry_run_test` runs the graph directly (`workflows.createRun(..., dryRun: true)`), which never touches `triggerType` at all, so testing the workflow gives no signal about this gap either.

**3. Does the generated workflow execute with an explicit AI Employee identity attached (`actingEmployeeId`)?**
Yes, and genuinely so — not assist-specific plumbing, the **generic** run-creation path. `WorkflowsService.createRun` derives `actingEmployeeId` from `actingEmployeeIdForGraph(nodesOf(pinned.definition))` (`workflows.service.ts:997-999`, using `engine/employee-references.ts`) for every run regardless of how the workflow was built. The rule (`employee-references.ts:19-46`): the first employee-bearing node in definition order, scanning any node whose `config.employeeId` is set (not just `AI_EMPLOYEE_STEP`). This column was a documented dead column until 2026-09-03 (per its own doc comment) and is now live and applies uniformly to assist-built workflows with no special-casing needed.

**4. Are AI outputs schema-validated the same way manual publish is?**
Yes, directly confirmed, not just architecturally implied. `propose_graph` calls `collectDefinitionIssues(parsed)` (`assist-write-tools.ts:393`) — the exact function `workflow-readiness.ts:104` and the manual publish path both call — **plus** four assist-specific pre-checks the manual builder's UI already prevents by construction: misplaced config keys (`CONFIG_ONLY_KEYS`, `:111-123, 301-332`), node-id-instead-of-outputKey template refs (`findNodeIdRefs`, `:132-165, 344-357`), untestable AI-vs-string `CONDITION`s (`findUntestableConditions`, `:183-218, 359-374`), and frozen-17 enforcement in code (`:378-389`, not just the prompt — "G32" fix). `patch_graph` runs the **same** `collectDefinitionIssues` gate on every edit (`assist-test-tool.ts:108`). One narrow, deliberate carve-out: `MISSING_EMPLOYEE` issues are excluded from the hard-rejection list (`assist-write-tools.ts:406`) so the agent isn't forced into an unanswerable corner — but `resolveReferences` still reports it as `unresolved`, and publish still blocks on it independently. This is the single best-engineered hop in the whole feature.

**5. Does AI Assist configure guardrails (approvals, budgets), or just the workflow skeleton?**
Partial, and precisely so. The prompt explicitly instructs the agent to place an `APPROVAL` node "before anything that spends money, contacts a customer or candidate outside the company, or publishes publicly" (`assist-prompt.ts:77`) — this is real guardrail *authoring* behaviour, not just skeleton generation, and `AI_EMPLOYEE_STEP` is architecturally guardrailed regardless of what the agent writes (see A.3: `disableTools: true` always). But: (a) **approval routing is never configured by assist** — an assist-built `APPROVAL` node ships with no `cfg.routing`, which `workflow-readiness.ts:211-226` correctly treats as a `WARNING` ("will be sent to any owner or admin"), not a blocker, so it silently ships unrouted unless a human later opens `ApprovalRoutingEditor`; (b) **employee-level guardrails are completely out of scope** — `list_employees` returns only `{id, name, role, persona}` (`assist-read-tools.ts:199`), never `budgetLimit`/`permissions`/`approvalRules`, and no assist tool reads or writes them. Guardrails at the *workflow-authoring* level: real. Guardrails at the *employee-hire* level: untouched, by design.

**6. Does AI Assist create only a workflow, or also hire/configure the employee that runs it?**
Confirmed: **workflow only.** Full tool inventory checked (`makeReadTools`/`makeWriteTools`/`makeTestTools` across `assist-read-tools.ts`, `assist-write-tools.ts`, `assist-test-tool.ts`) contains zero employee-mutation capability. The "connect a skill" in-chat flow (question asks to re-verify the 2026-08-07 ship) is confirmed **still wired and working**: `request_connection` tool → `assist-agent.service.ts:327-350` server-side detection via the real `SkillRequirementsService` (not the model's say-so) → `AssistMessage{role:'CONNECTION'}` persisted (`assist.service.ts:269-288`) → `SkillRequirementCard.tsx` renders live status (polls every 4s while unconnected, `:289`) → OAuth `returnTo=/assist/<id>` → `[sessionId]/page.tsx:41-52` handles the `?connected=`/`?skillError=` return and invalidates the requirements query. Independently re-verified end to end from the code, not assumed from memory.

**7. Auto-create-on-complete-graph and the accept-idempotency ref guard — still correct/safe?**
Confirmed accurate and still the current behaviour (this is **not** a stale CLAUDE.md claim — it matches the code exactly). `[sessionId]/page.tsx:74-122`: an effect auto-fires `accept.mutate({name: sessionTitle})` once `simplifiedWorkflowUX` is on, the stream is idle, the user `canAccept` (OWNER/ADMIN), no `createdWorkflowId` yet, the graph has ≥2 nodes, and `unresolved.length === 0` — gated by **two refs**, `streamedRef` (a stream really ran in this page view) and `autoCreateRef` (fires once), specifically because React's dev-mode double-effect-invocation would otherwise double-fire it. 🔴 **But the safety net is entirely client-side.** `AssistService.accept()` (`assist.service.ts:138-191`) has **no server-side check** that `session.createdWorkflowId` is already set before creating another `Workflow` and overwriting it — confirmed by re-reading the method: it unconditionally calls `workflows.create()` then `prisma.assistSession.update({data:{createdWorkflowId: workflow.id, ...}})`. Two tabs open on the same session, a retried network request, or any future caller that doesn't replicate the `autoCreateRef` pattern would each create a **real, separate `Workflow` row** — the first one silently orphaned (no error, no cleanup, just absent from the session's `createdWorkflowId` pointer, but still fully live in the tenant's workflow list). This is exactly what the code's own doc comment warns about ("`accept` is NOT idempotent server-side") — verified still true, not fixed.

**Bonus finding — half-wired plumbing:** `CreateAssistSessionDto.targetWorkflowId` (edit-existing-workflow) and `.originRunId` ("Fix with AI" from a failed run) are fully modelled server-side — accepted, stored, mapped back out (`assist.dto.ts:21-29`, `assist.service.ts:67-77`, `assist.mapper.ts:55`) — but a repo-wide grep of `apps/web/src` found **zero callers passing either field**; the only session-creation call site that isn't the plain composer (`CreateWorkflowChooser.tsx:38`) passes `{prompt}` alone. There is no "Fix with AI" button anywhere in the runs UI (`RunFailureCard.tsx` has no such affordance) and no "Edit with AI" entry point from an existing workflow. This matches CLAUDE.md's own "NOT done" list (`§9 AI-Assist diff-on-existing-workflow`) — independently confirmed rather than taken on faith.

---

## B. AI Employee / Agent architecture

### B.8 Relationship map

| Pair | Classification | Evidence |
|---|---|---|
| **AiEmployee ↔ Workflow** (AI_EMPLOYEE_STEP binding) | **FULL** | Bound by string `config.employeeId`, re-verified for tenancy at BOTH build time (`graph-references.ts:121-134`, ACTIVE-only) and execution time (`ai-employee-step.handler.ts:82-89`, independent DB check) — genuine defense in depth, not one check assumed to cover both. |
| **AiEmployee ↔ WorkflowRun** (attribution) | **FULL** | `actingEmployeeId` derived generically at run creation (`workflows.service.ts:997-999`); real FK + `[companyId, actingEmployeeId, createdAt]` index; was dead until 2026-09-03, confirmed now live and unconditional. |
| **Workflow ↔ TriggerType/TriggerConfig** (graph → execution semantics) | **BROKEN** | See A.2 Q2 — the TRIGGER node carries zero information; the columns that actually drive when a workflow fires are a wholly separate, manually-configured surface. This is the deepest single gap found in this cluster. |
| **AiEmployee ↔ Skill** (EmployeeSkill / per-employee `InstalledSkill`) | **FULL** | Confirmed ACTIVE in cluster 01's table audit; assist reads real `InstalledSkill` rows scoped by company (`assist-read-tools.ts:113-126`), counting a skill connected if EITHER its company-wide or per-employee installation is `CONNECTED`. |
| **Skill ↔ Connection** (OAuth/api_key, `InstalledSkill.connectionType/connectionStatus`) | **FULL for skills with a real executor; PARTIAL otherwise** | Per platform `CLAUDE.md`, `OAuthService.assertCanActuallyAct` now refuses to open OAuth for skills with no real executor (hubspot/jira) — i.e. the connection layer itself is honest about which skills are real vs consent-screen-only. |
| **AiEmployee ↔ Knowledge** (`knowledgeAccess`, category scoping) | **FULL** | Confirmed active in cluster 01 (`KnowledgeDocument`/`Chunk` both ACTIVE, role-scoped). Assist's `RETRIEVE` node inherits this at run time; assist itself has no dedicated knowledge-browsing tool (minor gap, noted in A.1). |
| **AiEmployee ↔ Memory** (`EmployeeMemory`, feedback loop) | **FULL** | `MEMORY_READ`/`MEMORY_WRITE` are in the frozen-17; `AgentRuntimeService`'s plan→retrieve→memory→act→validate loop is the SAME loop for chat and for `AI_EMPLOYEE_STEP` (see below) — memory is not a chat-only concept that workflows bypass. |
| **AiEmployee ↔ Policy** (`budgetLimit`, `permissions`, `approvalRules`) | **PARTIAL** | `budgetLimit` is genuinely enforced in the `AI_STEP` path (`ai-step.handler.ts:106-117`, monthly spend check) and (per platform CLAUDE.md) in chat via `ToolExecutorService`. But `maxCreditsPerExecution`/`maxCreditsPerTask` are explicitly commented **"inert until [credit enforcement] phase"** in the schema itself (confirmed independently in cluster 01) — so Policy is a real mix of enforced and dormant fields on the SAME model, not a clean yes/no. |
| **Workflow ↔ Approval** (APPROVAL node, routing, SLA) | **FULL mechanism, optional adoption** | Routing/SLA/chains are real (P3-05, confirmed cluster 01/06), but nothing forces a workflow author (human or assist) to actually configure routing — unrouted is a supported, non-blocking fallback. Assist never configures routing (A.2 Q5). |
| **AiEmployee ↔ Runtime** | **FULL, unified, not duplicated** | `AiEmployeeStepNodeHandler` (`apps/api/src/modules/employees/runtime/ai-employee-step.handler.ts:124-137`) delegates to the exact same `AgentRuntimeService.run()` chat uses, parameterised with `disableTools: true` (workflow steps "recommend only" — a deliberate, documented safety design: no tool access means no person-facing or irreversible action can be taken autonomously inside an `AI_EMPLOYEE_STEP`, even if the bound employee has the skill granted; real side effects are pushed to explicit, separately-gated `TOOL_ACTION` nodes) and `source: 'workflow_employee_step'` for cost/usage attribution. A real `Conversation` row is created per step so workflow-driven turns are auditable in the same place chat history lives (`:107-113`). This is architecturally clean: one runtime, two entry points, not two parallel agent implementations. |
| **Workflow ↔ Runtime** (execution engine) | **FULL, dual-mode by design** | `legacy_walk` / durable `state_machine`, both documented and both tested per platform CLAUDE.md; out of scope for this cluster beyond confirming `dry_run_test` genuinely executes through this same engine rather than a parallel test-only path (`assist-test-tool.ts:214-227`, explicit comment: "Inventing a parallel in-memory execution path would fork engine behaviour"). |

### B.9 Is there a separate "Agent" DB subsystem distinct from `AiEmployee`?

**No — confirmed by direct grep of the full 2872-line `schema.prisma`.** Searched for `model Agent`,
`model AgentWorkflow`, `model AgentSkill`, `model AgentConnection`, `model AgentRuntime` — **zero matches**.
The word "agent" appears in this codebase only as: `AssistAgentService` (a stateless orchestrator class, not
a persisted entity — its state lives on `AssistSession`), `AgentRuntimeService` (same — a singleton service,
not a table), and doc comments. There is exactly one persisted identity primitive for "a thing that acts":
`AiEmployee`.

**Verdict: building a separate Agent subsystem would duplicate the existing architecture, and no evidence in
this codebase supports doing it.** The concrete reasoning, not a general preference:

- **Identity** is already `AiEmployee` — tenant-scoped, role-typed, with its own status lifecycle
  (ACTIVE/paused/disabled/archived), persona, model override, and policy fields (budget/permissions/approvalRules)
  on one row.
- **Behaviour** is already `Workflow` — and it is explicitly *not* owned by the employee (a workflow can name
  zero, one, or several employees; `actingEmployeeIdForGraph` handles the "several" case by convention rather
  than needing a new join model).
- **Runtime** — the one role an "Agent" abstraction most often exists to own — is already cleanly unified:
  `AgentRuntimeService` is reused verbatim by both the chat surface and the workflow engine's
  `AI_EMPLOYEE_STEP` handler, via dependency injection across a module boundary specifically engineered to
  avoid a cycle (`Employees → Workflows`, documented in `ai-employee-step.handler.ts:29-41`). Splitting this
  into a separate `AgentRuntime` table/service would not add capability; it would fork one working
  implementation into two that must be kept in sync by hand — the exact failure mode the codebase has
  visibly gone out of its way to avoid elsewhere (e.g. the `LlmModule` fork pattern used identically for
  `WorkflowsModule` and `AssistModule`, per `assist.module.ts:17-21`).
- The one genuine, evidenced architectural gap found in this whole cluster — TRIGGER-node-to-`triggerType`
  translation (A.2 Q2 / B.8) — is a **workflow-authoring bug**, not a missing identity/runtime concept. An
  Agent table would not fix it; fixing `propose_graph`/`accept()` to translate trigger intent would.

---

## Top 5 most severe findings

1. 🔴 **AI Assist never wires the trigger it was asked for.** The frozen `TRIGGER` node has an empty
   `configSchema` (`node-catalog.ts:99-110`); `Workflow.triggerType` defaults to `MANUAL`
   (`schema.prisma:914`) and is only ever set through a separate manual UI path
   (`workflows.service.ts:318-336`). `AssistService.accept()` never touches it
   (`assist.service.ts:161-169`). A user can describe "When a CV arrives by email…", get a fully-validated,
   dry-run-tested, "ready" workflow — and it will only ever run when a human clicks Run, until someone
   separately reconfigures the Trigger panel. `evaluateReadiness` reports this as fully PASS for MANUAL
   (`workflow-readiness.ts:159-186`), so nothing in the product tells the user their described trigger
   didn't take effect.

2. 🔴 **`AssistService.accept()` has no server-side idempotency guard**, confirmed still true by re-reading
   the method (`assist.service.ts:138-191`) — calling it twice for one session creates two real `Workflow`
   rows, the first silently orphaned. The only protection is a client-side React ref pattern
   (`[sessionId]/page.tsx:92-122`) that does not survive two browser tabs, a retried request, or any future
   caller that doesn't replicate it exactly.

3. **Two backend-complete assist entry points have zero frontend callers**: `targetWorkflowId` (edit an
   existing workflow via assist) and `originRunId` ("Fix with AI" from a failed run) are fully modelled,
   stored and mapped end to end (`assist.dto.ts`, `assist.service.ts`, `assist.mapper.ts`) but a repo-wide
   grep of `apps/web/src` found no caller passing either — confirms, rather than merely repeats, CLAUDE.md's
   own "not done" note.

4. **AI Assist's approval guardrails are workflow-shape-only, never routing.** The agent is correctly
   instructed to add `APPROVAL` nodes before risky actions, but never configures who decides — an
   assist-built approval ships unrouted (falls back to any OWNER/ADMIN) unless a human separately opens
   `ApprovalRoutingEditor`. Not a defect (unrouted is a documented valid fallback) but a real completeness
   gap between "the agent added a safety gate" and "the safety gate goes to the right person."

5. **No separate Agent DB subsystem exists, and none should be built.** Direct schema grep confirms zero
   `Agent*` models. `AiEmployee` (identity) + `Workflow` (behaviour) + `Skill`/`InstalledSkill` (capability/
   connection) + a single shared `AgentRuntimeService` (reused, not duplicated, across chat and
   `AI_EMPLOYEE_STEP`) already cover every role a new Agent abstraction would nominally add. The one real gap
   found (#1) is a bug in the existing pipeline, not evidence of a missing abstraction.
