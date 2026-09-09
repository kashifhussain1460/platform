# Verify-02 — Employee lifecycle enforcement in workflow execution

**Task:** verify and deepen the prior finding in
`08-execution-identity-and-lifecycle.md` §C — *"pausing, disabling or archiving an AI Employee
does not stop workflow execution."*

**Method:** read-only code read, 2026-09-09. Every claim below is cited `file:line`, paths relative
to `d:/Vertical AI/platform`. The prior doc was treated as a hypothesis; where it is wrong or
imprecise, that is called out explicitly.

**Verdict: the finding is CONFIRMED, and it is worse in one respect and better in another than the
prior doc says.**

- **Worse:** `TOOL_ACTION` — the node type that actually sends email, posts to Slack, publishes,
  charges cards — does **not query `AiEmployee` at all**. The prior doc claims it does a bare
  `findFirst` with no status filter. It doesn't; there is no lookup to add a filter to
  (`tool-action.handler.ts:92-95`). So there is literally nothing between "employee paused" and
  "irreversible side effect executes as that employee".
- **Better:** `AI_EMPLOYEE_STEP` (the frozen-17 vocabulary's primary employee node, used by all 22
  first-party templates) **is** blocked today — but *accidentally and badly*: via a transitive
  `ConflictException` from the chat runtime that the workflow retry classifier files as a
  **retryable `NODE_ERROR`**, so a paused employee's step is retried with backoff before the run
  finally fails with a message written for a chat client.

---

## Part 1 — Confirming the gap, site by site

### 1.0 The schema facts (baseline)

`prisma/schema.prisma:687-745` — `model AiEmployee`:
- `status EmployeeStatus @default(ACTIVE)` at `:693`; enum `ACTIVE | PAUSED | DISABLED` at
  `:53-57`.
- `archivedAt DateTime?` at `:730` (soft delete, orthogonal to `status`).
- Indexes: `@@index([companyId])`, `@@index([companyId, archivedAt])`. There is **no**
  `[companyId, status]` index — not needed, every execution-path lookup is by primary key.

**Both fields must be checked, not just `status`.** Two reasons:

1. `remove()` sets `status:'DISABLED'` **and** `archivedAt` together
   (`employees.service.ts:402-405`), so an archived employee is also DISABLED *today*…
2. …but `update()` (`PATCH /employees/:id`, `employees.service.ts:189-238`) writes `dto.status`
   with **no transition validation and no clearing of `archivedAt`**, and
   `findOwnedEmployee` (`employees.service.ts:504-516`) does **not** filter `archivedAt`. So
   `PATCH /employees/:id {status:'ACTIVE'}` on an archived employee produces an employee that is
   `ACTIVE` with `archivedAt` still set — invisible in the roster (`list()` filters
   `archivedAt: null`, `employees.service.ts:145`) but fully "active" to any check that looks only
   at `status`. There is no restore/unarchive endpoint, so this is the only way back and it leaves
   the row in that split state.

**Also worth recording:** `update()` writes **no audit row**. Only archive
(`employees.service.ts:410-417`) and hard delete (`:382-389`) are audited. So "who paused Emma, and
when" is not answerable today.

### 1.1 Every site that resolves an `AiEmployee` for execution purposes

Grep basis: `aiEmployee.(findFirst|findUnique|findMany)` across `apps/api/src` (40 hits, all
reviewed). Only the execution-relevant ones are tabulated.

| # | Site | `status` filter? | `archivedAt` filter? | What happens today |
|---|---|---|---|---|
| 1 | `workflows/engine/nodes/ai-step.handler.ts:98-100` (`AI_STEP`) | **NO** | **NO** | Persona/model/budget of a paused, disabled or archived employee are used verbatim. **And if the lookup returns nothing it silently degrades** — see §1.2. |
| 2 | `workflows/engine/nodes/tool-action.handler.ts` (`TOOL_ACTION`) | **NO LOOKUP AT ALL** | — | `cfg.employeeId` is read at `:92-95`, used only to pick the employee's `InstalledSkill` connector (`:134-145`) and passed as `ctx.employeeId` into `skills.runTool(...)` at `:184-196`. The employee row is never fetched. This is the highest-severity site: it is the node with `hasSideEffects`. |
| 3 | `workflows/engine/nodes/memory.handlers.ts:54-62` (`MEMORY_READ`) | **NO** | **NO** | Tenant check only (`select: { id: true }`); throws only when the id is not in this company. |
| 4 | `workflows/engine/nodes/memory.handlers.ts:114-122` (`MEMORY_WRITE`) | **NO** | **NO** | Same — writes durable memory onto a paused/archived employee. |
| 5 | `workflows/engine/nodes/retrieve.handler.ts:134-137` (`RETRIEVE`) | **NO** | **NO** | Reads `role`/`knowledgeAccess`/`permissions` to scope knowledge; a paused employee still scopes retrieval normally. (It *does* fail-closed on a missing employee — `:146-148`, `return { denied: true }` — which is the correct shape and a useful precedent.) |
| 6 | `workflows/engine/approval-gate.service.ts:185-190` (durable engine's gate) | **NO** | **NO** | Reads `approvalRules` to decide whether the tool needs approval. `select: { approvalRules: true }`. |
| 7 | `workflows/engine/workflow-engine.service.ts:635-640` (legacy walk's identical gate) | **NO** | **NO** | Byte-for-byte the same query and comment as #6. |
| 8 | `employees/runtime/ai-employee-step.handler.ts:82-89` (`AI_EMPLOYEE_STEP`) | **NO** (own query) | **NO** | Throws only on "not found in this company". **But** it then passes the loaded row to `AgentRuntimeService.run(employee, …)` at `:124`, and that method's first statement is the status guard — so this node *is* blocked transitively. See §1.3 for why that is not good enough. |
| 9 | `skills/skills.service.ts:612-616` (`employeePermissionDenial`, reached from `runTool`) | **NO** | **NO** | `if (!employee) return null` at `:617` — a missing employee means "no permission denial found", i.e. **the tool is allowed**. Second instance of the silent-degrade class. |
| 10 | `credits/credit-limits.service.ts:117-124` | **NO** | **NO** | `findUniqueOrThrow({ where: { id } })` — no `companyId` either (safe in practice: callers already scoped it). Budget/ceiling enforcement therefore keeps working for a paused employee, which is harmless but confirms lifecycle state reaches nothing. |
| 11 | `approval-routing/approval-routing.service.ts:115-120` (`EMPLOYEE_MANAGER` rule) | **NO** | **NO** | Reads `managerUserId`; routes an approval to a paused employee's manager as normal. |
| 12 | `approvals/approval.service.ts:334-341` (`resolveEmployeeRouting`, TOOL-kind) | **NO** | **NO** | Reads `approvalRules`. |
| 13 | `workflows/engine/workflow-generator.service.ts:79-82` (AI workflow generator grounding) | **NO** | **NO** | `findMany({ where: { companyId } })` — the AI is offered paused/disabled/archived employees to author a graph around. **Inconsistent with #14.** |
| 14 | `assist/agent/assist-read-tools.ts:190-199` (AI Assist `list_employees` tool) | **YES** `status:'ACTIVE'` | no | **The precedent.** Its comment: *"G37: ACTIVE only. A paused or disabled employee cannot run a step, so offering one produces a workflow that fails the moment it fires."* That stated rationale is **false today** for sites 1-7 — which is exactly the gap. |
| 15 | `engines/whatsapp/whatsapp-webhook.controller.ts:297-306` (inbound fallback) | **YES** `status:'ACTIVE', archivedAt: null` | **YES** | **The correct filter shape already exists in this codebase.** But the pinned path short-circuits it: `if (account.employeeId) return account.employeeId;` at `:293` — a paused pinned WhatsApp employee still gets a `Conversation` created for it (`:222-228`). Low severity (no auto-reply is generated), but it is the same class. |
| 16 | `assist/assist.service.ts:326-329` | YES `status:'ACTIVE'` | no | Entry-screen suggestion chips only. Correct already. |

**The ONLY status check that gates real work today** is
`employees/runtime/agent-runtime.service.ts:126-131`:

```ts
    // Guard: only ACTIVE employees accept new work.
    if (employee.status !== 'ACTIVE') {
      throw new ConflictException(
        `Employee is ${employee.status.toLowerCase()} and cannot accept messages`,
      );
    }
```

It throws a **`ConflictException` (HTTP 409)** and it does **not** check `archivedAt` — it relies on
archive also setting DISABLED, which §1.0 shows is not a safe assumption after a status PATCH.

### 1.2 CONFIRMED: `ai-step.handler.ts` silently degrades to a generic persona

The prior audit's claim is **correct**. Evidence, `ai-step.handler.ts:92-119`:

```ts
    let persona = '';
    let name = 'the workflow assistant';
    ...
    if (employeeId) {
      const employee = await this.prisma.aiEmployee.findFirst({
        where: { id: employeeId, companyId },
      });
      if (employee) {
        persona = employee.persona ?? '';
        name = employee.name;
        ...
      }
    }
```

There is **no `else`**. When `cfg.employeeId` names an employee that was hard-deleted, or belongs to
another tenant, or is a typo, the handler proceeds with `name = 'the workflow assistant'`, an empty
persona, **no `employeeModel`** (so the wrong model and the wrong price), **no budget check**
(`:106-117` is inside `if (employee)`), and `employeeId` still non-empty so credit reservations and
usage rows are attributed to a nonexistent employee (`:186`, `:256`). The step then records
COMPLETED and the run goes green.

This is a textbook instance of the documented **silent-success defect class** (memory:
`silent-success-defect-class`). Compare the two handlers that get it right:
`retrieve.handler.ts:146-148` (*"An employee id that resolves to nothing must NOT fall through to
company-wide: that would make a typo the widest possible scope"*) and
`ai-employee-step.handler.ts:85-89` (throws). `AI_STEP` and `skills.service.ts:617` are the two
outliers and both must be fixed in the same pass.

### 1.3 Why `AI_EMPLOYEE_STEP` being "protected" is not good enough

`ai-employee-step.handler.ts:124` → `agent-runtime.service.ts:127` throws
`ConflictException('Employee is paused and cannot accept messages')`. Three problems:

1. **It classifies as retryable.** `RetryPolicyService.classifyError`
   (`workflow-runtime/retry-policy.service.ts:151-217`) matches on typed classes then message
   substrings. `"Employee is paused and cannot accept messages"` matches none of them, so it falls
   through to `return 'NODE_ERROR'` at `:216` — and `NODE_ERROR` is **retryable**
   (`:123-127`). So a paused employee's step is retried with exponential backoff up to
   `RETRY_MAX_ATTEMPTS` before the run fails. Retrying a lifecycle decision cannot change the
   outcome; the file's own doc comment (`:116-120`) says exactly that.
2. **The message is written for a chat client**, not a workflow operator. It says "cannot accept
   messages" and lands in `WorkflowRun.error`. The run page shows it as-is.
3. **Only the durable engine classifies at all.** `workflow-engine.service.ts` never sets
   `failureClass` (grep: zero matches; it writes only `status:'FAILED'` + `error`, e.g.
   `:481-483`, `:813`). So under `WORKFLOW_ENGINE_MODE=legacy_walk` the failure has no class at
   all. Any fix must be verified in **both** engine modes (standing rule in
   `platform/CLAUDE.md`).

### 1.4 Run-creation / trigger sites: none check the employee

| Site | Checks | Employee status? |
|---|---|---|
| `workflows.service.ts:652-681` `createRun` (MANUAL) | `assertNotArchived(workflow)` `:661`; `assertScope(… 'workflow:run')` `:665`; `assertRunnable(definition)` `:670-672` | **NO** |
| `workflows.service.ts:571-615` `fireEvent` (EVENT) | workflow `status:'ACTIVE'` `:580`; connector scope `:596`; condition DSL `:602` | **NO** |
| `workflows.service.ts:627-647` `fireWebhook` (WEBHOOK) | workflow ACTIVE + type WEBHOOK `:635-641` | **NO** |
| `workflows.service.ts:1110-1159` `fireSchedule` (SCHEDULE) | workflow `status !== 'ACTIVE' \|\| archivedAt` → skip `:1131-1137` | **NO** |
| `workflows.service.ts:953-1068` `enqueueRun` (**all four funnel here**) | idempotency `:970-976`; pin version `:981-991`; derive `actingEmployeeId` `:997-999`; `permissions.assertCanRun` `:1008` | **NO** |
| `workflows.service.ts:450-500` `activate` | not archived `:453`; ≥1 runnable step `:455-459`; `assertRunnable` `:464-466`; `validateTrigger` `:470`; EVENT conflict `:476-478` | **NO** |
| `workflow-version.service.ts:168-193` `publish` | `validate(draftDefinition)` `:189`; `skillRequirements.assertPublishable` `:193` | **NO** |

**`enqueueRun` is the single chokepoint for every run in the system** — MANUAL, SCHEDULE, EVENT and
WEBHOOK all reach it — and it **already loads the pinned graph and already computes the employee
set** at `:997-999`. That is the natural insertion point (§3).

---

## Part 2 — The right enforcement architecture

### 2.1 Is there a shared employee-resolution helper? **No.**

Each handler queries Prisma directly, with a **different `select`** each time:
- `ai-step.handler.ts:98-100` — full row (no select).
- `memory.handlers.ts:56` / `:116` — `select: { id: true }`.
- `retrieve.handler.ts:136` — `select: { role, knowledgeAccess, permissions }`.
- `approval-gate.service.ts:188` and `workflow-engine.service.ts:638` — `select: { approvalRules }`.
- `ai-employee-step.handler.ts:82-84` — full row (needed: it is passed to `runtime.run`).

There is also **no shared node-execution wrapper** to hang a guard on. Both engines resolve and call
the handler themselves, in one line each:
- durable: `workflow-runtime/node-attempt.processor.ts:182` `this.registry.get(node.type).execute({…})`
- legacy: `workflows/engine/workflow-engine.service.ts:1171-1173` — same, and its doc comment
  `:1154-1161` **forbids** the engine branching on node type (*"any `if (node.type === …)`
  reintroduced below is a review rejection"*), so a per-type guard inside the engine is out.

Because the `select` shapes differ, a "fetch the employee for me" helper would either lose Prisma's
generated types or force every site onto the widest select. **The smaller and more idiomatic move
for this codebase** (which consistently separates a pure rule from a thin I/O shell —
`authorization.policy.ts`, `workflow-readiness.ts`, `billing.plans.ts`) is a **pure assertion over
an already-fetched row**, plus a typed error class:

**Proposed new file:** `apps/api/src/modules/workflows/engine/employee-lifecycle.ts`

```ts
import type { EmployeeStatus } from '@prisma/client';

/** The lifecycle columns every execution-path lookup must now select. */
export interface EmployeeLifecycleState {
  id: string;
  name: string;
  status: EmployeeStatus;
  archivedAt: Date | null;
}

/**
 * Thrown when a node names an AI Employee that cannot work: paused, disabled,
 * archived, or gone. Its own class so RetryPolicyService classifies it by
 * `instanceof` rather than message text (same reason as
 * EmployeeBudgetExceededError — credit-limits.service.ts:19-30).
 */
export class EmployeeNotWorkableError extends Error {
  constructor(
    readonly employeeId: string,
    readonly nodeId: string,
    readonly reason: 'PAUSED' | 'DISABLED' | 'ARCHIVED' | 'MISSING',
    readonly employeeName: string | null,
  ) {
    super(/* customer-facing sentence, see §2.4 */);
    this.name = 'EmployeeNotWorkableError';
  }
}

/** Pure. Null → MISSING (never a silent fall-through). */
export function employeeWorkableReason(
  employee: EmployeeLifecycleState | null,
): 'PAUSED' | 'DISABLED' | 'ARCHIVED' | 'MISSING' | null;

/** Narrowing assert for the handlers. Generic so each site keeps its own select's type. */
export function assertEmployeeWorkable<T extends EmployeeLifecycleState>(
  employee: T | null,
  ctx: { employeeId: string; nodeId: string },
): T;
```

Why this file path: it is inside `workflows/engine/`, which **`employees/runtime/` already imports
from** (`ai-employee-step.handler.ts:3-9`) and which **`workflow-runtime/` already imports from**
(`node-attempt.processor.ts:6-8`). No new module edge, no cycle. It has no Nest decorators and no
Prisma client import (types only), so `retry-policy.service.ts` can import the error class freely.

Cost at each call site: add `status: true, archivedAt: true, name: true` to the existing `select`,
then one line `assertEmployeeWorkable(employee, { employeeId, nodeId: node.id })` replacing the
existing `if (!employee) throw …`.

### 2.2 Run creation vs node execution: **both** — and this matches existing patterns exactly

Recommendation: **both, with different jobs.**

- **Creation/trigger time = the primary control.** This is exactly how the codebase already handles
  the analogous "the identity behind an automated run lost its right to act" problem: the **User
  kill switch**. `WorkflowPermissionService.loadSubject`
  (`workflow-permissions.service.ts:243-251`) filters `status: 'ACTIVE'`, so a later-DISABLED
  publisher stops authorising the workflow's scheduled runs — enforced at *enqueue*, in
  `enqueueRun` at `:1008`, and proven by `test/workflow-canonical-path.e2e-spec.ts:262-274` and
  `test/workflow-permissions.e2e-spec.ts:177-203`. The employee kill switch should be the same
  shape, in the same function, one line below.
  The second precedent is `assertPublishable`: `skill-requirements.service.ts:128-145` refuses to
  let a workflow become executable when an **external resource's state** (a connector) isn't ready,
  rather than letting it fail at runtime.
- **Node-execution time = defence in depth, and the fix for the silent-degrade bug.** It cannot be
  skipped, for four reasons: (a) a run can sit `PENDING`/`WAITING` for hours or days between
  creation and the node executing — an APPROVAL gate is explicitly designed to
  (`ai-employee-step.handler.ts:150-176`); (b) `employeeIdsInGraph` deliberately ignores
  `{{template}}` ids (`employee-references.ts:79-83`), so a templated `employeeId` is *invisible*
  at creation and only resolvable at execution (`memory.handlers.ts:37`,
  `ai-employee-step.handler.ts:69` both `resolveTemplate` it); (c) a `resume` after an approval
  re-enters the node without going through `enqueueRun` (`workflows.service.ts:760-790`); (d) the
  `AI_STEP` / `skills.service.ts:617` null-employee silent degrade is a node-level bug that a
  creation-time check does nothing about.
- **Publish/readiness = advisory only, NOT a blocker.** Tempting, but it would break the
  documented **`ready === (publish would succeed)` invariant** (`platform/CLAUDE.md`; pinned by
  `test/workflow-ux-simplification.e2e-spec.ts`). Employee status is *mutable after publish*, so a
  blocker there would go stale immediately and would also block re-publishing a workflow while its
  employee is temporarily paused. `workflow-readiness.ts` already reserves the slot for this:
  `checks[]` carries `{ key: 'AI_EMPLOYEE', label: 'AI employees', status: 'PASS' }` at `:275-279`,
  and today it only ever FAILs when the *validator's* `employeeId` rule fired (`:298-306`). Adding
  a **`WARNING`-severity** `EMPLOYEE_NOT_ACTIVE` issue there (with `check.status = 'WARN'`) tells
  the user the truth without touching `ready`. That requires passing employee state into the pure
  evaluator the same way `skillRequirements` is passed
  (`workflow-readiness.ts:38-41`, loaded at `workflow-readiness.service.ts:51-64`).

### 2.3 A run already in flight when the employee is paused mid-run

**Recommendation: do NOT cancel it. Let it stop naturally at the next employee-bearing node.**

Evidence that this is what the existing business semantics imply:

1. **Archive refuses rather than cancels.** `employees.service.ts:361-366`:
   `if (deps.inFlightRuns > 0) throw new ConflictException('Cannot delete … workflow run(s) that
   use it are still in flight. Wait for them to finish or cancel them first.')` — and the comment
   at `:359-360` is explicit: *"archiving an employee whose workflow is mid-run would strand that
   run just as surely as deleting it."* The house rule is **in-flight work is not to be
   interrupted by a lifecycle change; the lifecycle change waits, or the human cancels
   deliberately.** Same for pending approvals (`:367-372`).
2. **Runs snapshot their world at creation on purpose.** `workflowVersionId`, `engineMode` and
   `actingEmployeeId` are all frozen at creation (`workflows.service.ts:1016-1039`) precisely so
   that *"re-deriving it later would let an edit to the workflow rewrite the history of a run that
   already happened"* (`:1022-1026`).
3. **The watchdog precedent refuses to replay side effects.** memory `workflow-run-watchdog`: stuck
   runs are *failed*, never retried, because side effects aren't safe to replay. `OUTCOME_UNKNOWN`
   exists for exactly this (`retry-policy.service.ts:37-47`) and is non-retryable.
4. `cancelRun` exists (`workflows.service.ts:791-827`, `cancelRunByUser` `:828-887`,
   `POST /workflows/runs/:id/cancel`) — so cancelling is already a **deliberate human action** with
   its own endpoint and audit. A sweep that cancels on pause would put machinery in the place the
   product reserves for a person.

**So:** pause/disable writes nothing to any `WorkflowRun`. A run mid-flight keeps going; the moment
it reaches a node naming the now-inactive employee, that node fails (§2.4) and the run ends
`FAILED` with a clear reason. A run whose remaining nodes name nobody completes normally, which is
correct — no work was done "as" the paused employee.

**One recommended additive nicety, not a blocker:** `PATCH /employees/:id` setting `PAUSED`/`DISABLED`
should return (or log) the `inFlightRuns` count from the existing `dependencies()` computation
(`employees.service.ts:274-283`), so the operator is *told* "3 runs are still finishing" instead of
guessing. Informational only — do **not** make it a 409, or pausing becomes impossible exactly when
it is most needed.

### 2.4 The correct failure mode: `FAILED`, not `SKIPPED`, not pause

`FailureClass` values today (`workflow-runtime/retry-policy.service.ts:16-47`):
`NODE_ERROR · CONNECTOR_UNAVAILABLE · RATE_LIMITED · TIMEOUT · APPROVAL_REJECTED · BUDGET_EXCEEDED ·
SUBSCRIPTION_BLOCKED · VALIDATION_ERROR · CANCELLED · INTERNAL · AUTHORIZATION_DENIED ·
INSUFFICIENT_CREDITS · EMPLOYEE_BUDGET_EXCEEDED · WORKFLOW_LIMIT_EXCEEDED ·
EMPLOYEE_EXECUTION_CEILING_EXCEEDED · EMPLOYEE_TASK_CEILING_EXCEEDED · OUTCOME_UNKNOWN`.
`isRetryable` (`:121-149`) returns true for only the first four.

- **`SKIPPED` is not available to a handler.** `NodeResult` (`nodes/node-handler.ts:17-97`) has no
  skip directive — its only outcomes are a value, a branch, `terminate`, `fanOut`, `iterate`,
  `pause`. `SKIPPED` exists in `StepRunStatus` but is written **only** by the engines for an
  author-`disabled` node (`workflow-runtime/run-advance.processor.ts:290-310`, whose own comment at
  `:298` says *"A real SKIPPED row, not a silent hop: the timeline has to explain why a node did not
  run"*). Making it reachable from a handler means a new `NodeResult` field plus matching support in
  **both** engines. And it is the wrong semantics anyway: skipping means the following steps run
  with a hole where the employee's output should be — the exact "green run that did nothing"
  pattern.
- **Pause is wrong** because nothing will ever resume it. Pause/`WAITING` is reserved for a pending
  approval that a human will decide (`node-handler.ts:85-96`). "Employee is paused" has no decision
  event to wait on.
- **`FAILED` is correct**, and the closest existing class is **`AUTHORIZATION_DENIED`**
  (non-retryable, `:133`) — *"this identity is not allowed to act"* is precisely the situation, and
  it is the same class the User kill switch's 403 would map to. Message-substring classification
  would already catch it if the sentence contains "not permitted" (`:213-215`), **but do not rely on
  that** — follow the documented rule at `:151-157` and classify **by type**: add
  `if (error instanceof EmployeeNotWorkableError) return 'AUTHORIZATION_DENIED';` alongside the five
  existing `instanceof` checks at `:158-162`.
- **Do not add a new `FailureClass` value** unless the plan also wants a distinct metric label. If it
  does, `EMPLOYEE_NOT_ACTIVE` is the name to use, added to the union at `:16-47` and to the
  non-retryable arm of `isRetryable` at `:132-145`. Note `RunFailureClass` is a **plain `String?`
  column** in the schema (`prisma/schema.prisma:1023` on `WorkflowRun`, `:2376` on
  `WorkflowStepAttempt`), so no migration is needed either way. *Recommendation: reuse
  `AUTHORIZATION_DENIED` — fewer moving parts, and it is already non-retryable and already surfaced
  by `RunFailureCard`.*
- **Message wording** must name the employee, its state and the fix, in plain language, e.g.
  `Step "summarize_application" is assigned to Emma, who is paused. Resume Emma, or give this step a
  different AI Employee.` (mirrors the tone of the existing out-of-scope failure,
  `ai-employee-step.handler.ts:193-199`).

---

## Part 3 — Scheduled and event triggers: the exact insertion point

### 3.1 What fires a SCHEDULE workflow (two drivers, one funnel)

1. **Worker deployment:** `activate()` registers a BullMQ repeatable —
   `workflows.service.ts:495-497` → `addSchedule()` `:1273-1300`. It fires
   `workflow.processor.ts:100` → `this.workflows.fireSchedule(data.workflowId, source)`.
   `addSchedule`/`removeSchedule` **no-op in inline mode** (`:1279`).
2. **Serverless deployment:** `GET/POST /admin/cron/workflow-schedules`
   (`admin/cron.controller.ts:81`, dispatched at `:158`) → the sweep at `:224-267`. It selects
   `where: { status:'ACTIVE', triggerType:'SCHEDULE', archivedAt: null }` at `:225`, checks
   `everyMs` elapsed, then calls `await this.workflows.fireScheduled(wf.id)` at **`:253`**.
   `fireScheduled` is a one-line pass-through to `fireSchedule` (`workflows.service.ts:1087-1089`).

Both drivers converge on **`WorkflowsService.fireSchedule` (`:1110-1159`)**, which converges on
**`enqueueRun` (`:1140-1146`)**.

### 3.2 What fires an EVENT workflow

`WorkflowsService.fireEvent` (`:571-615`) — called by the event-normalization pipeline
(`modules/events`), by `POST /connectors/:id/webhook`, and by the Gmail inbound poll. It filters
workflows by `status:'ACTIVE'` + `triggerType:'EVENT'` + `eventType` (`:577-583`), then per
workflow applies connector scoping (`:596`) and the condition DSL (`:602`), then calls
`enqueueRun(...)` at **`:605-611`**.

### 3.3 The one insertion point

**`WorkflowsService.enqueueRun`, `workflows.service.ts:997-1008`** — between the
`actingEmployeeId` derivation and the `assertCanRun` call:

```ts
    const actingEmployeeId = actingEmployeeIdForGraph(          // :997  (existing)
      nodesOf(pinned?.activeVersion?.definition ?? pinned?.definition),
    );
    // ← INSERT HERE: assertGraphEmployeesWorkable(companyId, graphNodes, workflowId)
    await this.permissions.assertCanRun(companyId, workflowId, subjectUserId); // :1008 (existing)
```

Why here and nowhere else: all four trigger paths funnel through it; the pinned graph is **already
loaded** at `:981-991` (no extra query for the graph); `employeeIdsInGraph` runs on the exact same
node array; and it sits next to the structurally identical User kill switch, so the two read as one
policy.

**Per-caller error handling that the plan must get right** (this is where a naive throw does
damage):

| Caller | Today | Required |
|---|---|---|
| `fireSchedule` `:1139-1158` | already wraps `enqueueRun` in try/catch and **logs + swallows** (comment `:1148-1152`: a background job has no caller to receive a 403) | **No change** — a paused employee's schedule silently stops firing and logs why. Exactly right. |
| `fireEvent` `:591-613` | **no per-workflow try/catch** — a throw aborts the whole loop | **Must add a per-workflow try/catch that logs and `continue`s.** Otherwise one tenant's paused employee stops every other matching workflow in the same `fireEvent` call, and can 500 the webhook ingestion endpoint. Same rationale as `cron.controller.ts:255-263` (*"One tenant's broken workflow must not stop the sweep for everyone else"*). |
| `fireWebhook` `:627-647` | throw propagates to the public route | **Decide explicitly.** Recommended: let it surface as **409 Conflict** with the plain-language reason. It is loud, it creates no run, and a provider retry is harmless. (A 200-and-drop would be a silent success.) |
| `createRun` `:652-681` (MANUAL) | throw propagates to `POST /workflows/:id/run` | **409 Conflict**, matching `agent-runtime.service.ts:128` for chat and `employees.service.ts:362` for archive. `ConflictException`, not `ForbiddenException` — this is a state problem, not a permission problem. |

**Secondary, optional insertion point:** `activate()` (`workflows.service.ts:450-500`) could refuse
to turn a workflow ON while a referenced employee is inactive, alongside its existing
`validateTrigger`/EVENT-conflict checks. Worth doing — it is the moment the customer says "go live",
and the message can be actionable. It does **not** replace the `enqueueRun` check (the employee can
be paused after activation).

---

## Part 4 — How to know which employees a workflow references

`apps/api/src/modules/workflows/engine/employee-references.ts` — **verified exact signatures**:

```ts
export function nodesOf(definition: unknown): NodeLike[]                          // :63
export function employeeIdsInGraph(nodes: readonly NodeLike[]): string[]          // :95
export function actingEmployeeIdForGraph(nodes: readonly NodeLike[]): string|null // :116
```

`interface NodeLike { readonly type?: unknown; readonly config?: unknown }` at `:49-52` (not
exported). Behaviour the plan must know:

- Reads `config.employeeId` **by field, not by node type** (`employeeIdOf`, `:73-84`), so it covers
  `AI_EMPLOYEE_STEP`, `TOOL_ACTION`, `MEMORY_READ`, `MEMORY_WRITE`, `APPROVAL`, `AI_STEP` and any
  future employee-scoped node automatically (`:86-94`).
- **Deliberately skips `{{template}}` ids** (`:79-83`) — so a templated employee is *not* returned
  and *cannot* be checked at creation time. This is the single hard reason node-time enforcement is
  mandatory (§2.2).
- **Does not skip `disabled` nodes.** A creation-time check that used it verbatim would block a run
  because of an author-disabled node the engine will `SKIP` anyway
  (`run-advance.processor.ts:290-310`). Compare `skill-requirements.service.ts:157-159`, which
  *does* skip disabled nodes for exactly this reason. **The plan must decide:** either filter
  `node.disabled` at the call site, or add an options bag to `employeeIdsInGraph`. Recommended:
  filter at the call site, so `employee-references.ts`'s attribution behaviour (and its 12 unit
  tests) stays untouched.
- Callers today: exactly one — `workflows.service.ts:997`. `employeeIdsInGraph` has **no production
  caller at all** (only `employee-references.spec.ts`). Tests exist and pass; the function was built
  ahead of this fix.
- Independent server-side query for the reverse direction:
  `EmployeesService.workflowsReferencing` (`employees.service.ts:309-323`) — `private`,
  substring-matches `Workflow.definition`, filters `archivedAt: null`. Used only by
  `dependencies()`.

---

## Part 5 — Existing test coverage

### 5.1 Backend e2e (`apps/api/test/`)

| File:line | What it covers | Employee or User? |
|---|---|---|
| `employees.e2e-spec.ts:151-163` | `PATCH /employees/:id {status:'PAUSED'}` → posting a chat message returns **409** | **Employee** — the only existing test of the employee status guard, and it is chat-only |
| `employees-seats.e2e-spec.ts:90-100` | `{status:'DISABLED'}` frees a plan seat | Employee (billing, not execution) |
| `phase1-safety.e2e-spec.ts:295-427` | `GET /employees/:id/dependencies` counts (`:333-338`, asserts `inFlightRuns: 0`); archive keeps rows; hard delete; **`:411-426` a PENDING approval blocks delete → 409** | Employee (lifecycle safety) |
| `phase1-safety.e2e-spec.ts:565-587` | disabled **User** → 401 at the session kill switch | User |
| `workflow-permissions.e2e-spec.ts:177-203` | disabled **User** loses RUN on a restricted workflow | User — **closest structural template for the new test** |
| `workflow-canonical-path.e2e-spec.ts:257-274` | disabled **publisher** → `fireSchedule` creates **0** runs, refused-not-crashed | User — **the exact template for the schedule case** |
| `workflow-canonical-path.e2e-spec.ts:276+` | a PAUSED **workflow** doesn't fire even if a repeatable outlives deactivation | Workflow |
| `auth-onboarding-hardening.e2e-spec.ts:66`, `rbac-users.e2e-spec.ts:128`, `security-killswitch.e2e-spec.ts:51` | disabled **User** variants | User |

**There is no test anywhere that pauses an AI Employee and then runs a workflow.** That is the gap.

### 5.2 Unit specs that mock `aiEmployee`

`retrieve.handler.spec.ts:19-26` · `ai-employee-step.handler.spec.ts:14-33` ·
`approval-routing.spec.ts` · `credit-limits.service.spec.ts` · `skills.service.spec.ts` ·
`marketing.service.spec.ts` · `whatsapp-accounts.service.spec.ts` ·
`whatsapp-webhook.controller.spec.ts` (`:65` asserts the ACTIVE filter, `:234`, `:242`) ·
`workflow-generator.service.spec.ts` · `assist/agent/graph-references.spec.ts`.

🔴 **These will break when the guard lands.** Their mock employees have no `status`/`archivedAt`
fields, e.g. `ai-employee-step.handler.spec.ts:14-19`:

```ts
  const employee = {
    id: 'emp-1',
    name: 'Anushka',
    role: 'HR',
    companyId: 'co-1',
  };
```

and `retrieve.handler.spec.ts:19-26`:

```ts
  const employeeFindFirst = jest.fn();
  const prisma = {
    aiEmployee: { findFirst: employeeFindFirst },
    workflow: { findFirst: workflowFindFirst },
  } as unknown as PrismaService;
```

Every such fixture needs `status: 'ACTIVE', archivedAt: null` added. The plan must budget for this —
it is mechanical but it touches ~10 spec files, and a missed one looks like a real regression.

### 5.3 House style for creating an employee and setting its status

**e2e — HTTP, always through the real API** (`workflow-p2-nodes.e2e-spec.ts:51-57`):

```ts
    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'P2 Marketer', role: 'MARKETING' })
      .expect(201);
    employeeId = emp.body.id;
```

**Status change — via the API when the endpoint is the thing under test**
(`employees.e2e-spec.ts:152-157`):

```ts
    await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set(auth())
      .send({ status: 'PAUSED' })
      .expect(200);
```

**Status change — direct Prisma when it is only a precondition** (`workflow-canonical-path.e2e-spec.ts:264-267`):

```ts
    await prisma.user.update({
      where: { id: publisher.id },
      data: { status: 'DISABLED' },
    });
```

**Playwright** (`e2e/tests/06-plan-seats-journey.spec.ts:79-83`) uses the API through `request`, not
the UI, for state setup:

```ts
    await request.patch(`${API}/employees/${support.id}`, {
      headers: authHeaders(owner.accessToken),
      data: { status: 'DISABLED' },
    });
```

Playwright coverage of employee status today is **seats only** (`06-plan-seats-journey.spec.ts:79`);
`02-security-journey.spec.ts:186` and `05-failure-journeys.spec.ts:215` disable **Users**, not
employees. No browser test pauses an employee and checks a workflow.

---

## Cross-cutting: the UI copy is factually wrong

`apps/web/src/features/employees/components/EmployeeCard.tsx:93-101`:

```
title="Remove from your roster. History and connections are kept."
…
'It will stop working immediately. Its conversation history, ' +
```

For any employee referenced by an ACTIVE SCHEDULE/EVENT/WEBHOOK workflow, "It will stop working
immediately" is false today for `AI_STEP`, `TOOL_ACTION`, `MEMORY_READ/WRITE` and `RETRIEVE`. The
same card's Pause (`:52-61`) and Disable (`:62-70`) buttons make no promise at all, and should say
what pausing does once it means something. `EmployeeCard.tsx:90-110` also still fires
`del.mutate()` behind a hardcoded `window.confirm` without ever calling
`GET /employees/:id/dependencies` — the prior audit's finding #5, re-confirmed.

## Things I could NOT determine (flagged, not guessed)

1. **Whether `fireWebhook` should 409 or 200-and-drop** on an inactive employee. Both are
   defensible (provider retry storm vs. silent drop); there is no existing precedent in the
   codebase for "public webhook whose target is temporarily unusable". Needs a product call.
2. **Whether `PAUSED` and `DISABLED` should behave differently at run creation.** Business-wise
   PAUSED reads as "temporarily", DISABLED as "retired" (and `checkSeatFor`,
   `billing.plans.ts:146-168`, already treats them differently: PAUSED occupies a seat, DISABLED
   frees one). A case could be made for PAUSED runs *queueing* rather than being refused — but
   nothing in the run state machine supports "held until the employee resumes"
   (`workflow-runtime/run-state.ts:64`), so building that is a much larger change. My
   recommendation is to treat both identically (refuse), and say so explicitly in the plan.
3. **Whether the AI workflow generator's grounding query** (`workflow-generator.service.ts:79-82`)
   is deliberately unfiltered or was simply missed when G37 fixed the newer AI Assist path
   (`assist-read-tools.ts:190-199`). No comment or ledger entry explains it. Treating it as a miss.
4. **Legacy-walk failure classification.** `workflow-engine.service.ts` writes no `failureClass`
   at all. Whether the plan should add it there, or accept that `legacy_walk` reports only
   `error` text, is a scoping decision beyond this verification.

---

# What the implementation plan must do

Ordered. Each step names the exact file and the exact signature.

### Step 1 — Add the shared rule (new file, no behaviour change yet)

**New:** `apps/api/src/modules/workflows/engine/employee-lifecycle.ts`

```ts
export interface EmployeeLifecycleState {
  id: string;
  name: string;
  status: EmployeeStatus;        // from @prisma/client
  archivedAt: Date | null;
}

export type NotWorkableReason = 'PAUSED' | 'DISABLED' | 'ARCHIVED' | 'MISSING';

export class EmployeeNotWorkableError extends Error {
  constructor(
    readonly employeeId: string,
    readonly nodeId: string | null,
    readonly reason: NotWorkableReason,
    readonly employeeName: string | null,
  );
}

/** Pure. `null` in → 'MISSING'. archivedAt wins over status in the message. */
export function employeeWorkableReason(
  employee: EmployeeLifecycleState | null,
): NotWorkableReason | null;

/** Narrowing assert used by every node handler. Throws EmployeeNotWorkableError. */
export function assertEmployeeWorkable<T extends EmployeeLifecycleState>(
  employee: T | null,
  ctx: { employeeId: string; nodeId: string },
): T;
```

**New:** `apps/api/src/modules/workflows/engine/employee-lifecycle.spec.ts` — unit-test the pure
function for all five inputs (ACTIVE / PAUSED / DISABLED / ACTIVE-but-archived / null).

### Step 2 — Classify it as a non-retryable failure

`apps/api/src/modules/workflow-runtime/retry-policy.service.ts`
- Import `EmployeeNotWorkableError`.
- Add `if (error instanceof EmployeeNotWorkableError) return 'AUTHORIZATION_DENIED';` to
  `classifyError`, **among the existing `instanceof` block at `:158-162`** (before the substring
  fallback — the file's own rule at `:151-157`).
- `AUTHORIZATION_DENIED` is already non-retryable (`:133`) — verify, don't re-add.
- Extend `retry-policy.service.spec.ts` with a case asserting non-retryable.

### Step 3 — Fix the silent degrade + enforce at node execution (5 handlers + 2 gates)

For each site: add `status: true, archivedAt: true, name: true` to the existing `select` (or keep the
full-row read), then call `assertEmployeeWorkable`.

| File | Line today | Change |
|---|---|---|
| `workflows/engine/nodes/ai-step.handler.ts` | `92-119` | **Delete the `let name = 'the workflow assistant'` fallback path.** Replace `if (employee) { … }` with `assertEmployeeWorkable(employee, …)` then the existing body unconditionally. 🔴 This is the silent-success fix and must not be deferred. |
| `workflows/engine/nodes/tool-action.handler.ts` | `92-95` | **Add a lookup** (there is none today), guarded by `if (employeeId)`, placed with the other pre-flight validations at `:97-155` — i.e. **before** the `dryRun` short-circuit at `:162`, so a dry run also reports it (same rule as the `toolDef` check, comment `:97-101`). |
| `workflows/engine/nodes/memory.handlers.ts` | `54-62`, `114-122` | Replace both `if (!employee) throw` blocks. |
| `workflows/engine/nodes/retrieve.handler.ts` | `131-149` | Replace the `return { denied: true }` on missing (`:146-148`) with the assert, and assert before the `knowledgeRetrievalAllowed` check. |
| `workflows/engine/approval-gate.service.ts` | `185-190` | Assert when `employeeId` is set. |
| `workflows/engine/workflow-engine.service.ts` | `635-640` | Identical change (legacy walk's copy of the same gate — the two must not diverge, per the comments at `:642-651` / `approval-gate.service.ts:192-199`). |
| `employees/runtime/ai-employee-step.handler.ts` | `82-89` | Replace the `if (!employee) throw` with the assert. This also **replaces** the transitive `agent-runtime` 409 with a properly-classified, workflow-worded failure. |
| `skills/skills.service.ts` | `612-619` (`employeePermissionDenial`) | 🔴 `if (!employee) return null` means "allowed". Change to fail closed (return a denial reason). Second instance of the silent-degrade class. |

### Step 4 — Enforce at run creation (the primary control)

`apps/api/src/modules/workflows/workflows.service.ts`

Add a private method and call it in `enqueueRun` **between `:999` and `:1008`**:

```ts
  /**
   * Employee kill switch, the mirror of `permissions.assertCanRun`'s User kill
   * switch: a run must not be created for a graph that names an AI Employee
   * which is paused, disabled, archived or gone.
   * Templated employeeIds are invisible here (employee-references.ts:79-83) and
   * are caught at node execution instead.
   */
  private async assertGraphEmployeesWorkable(
    companyId: string,
    nodes: readonly NodeLike[],   // already computed at :997-999
  ): Promise<void>;               // throws ConflictException (409)
```

Implementation notes the plan must state:
- Filter out `node.disabled === true` before calling `employeeIdsInGraph` (see §Part 4; precedent
  `skill-requirements.service.ts:157-159`).
- One `aiEmployee.findMany({ where: { companyId, id: { in: ids } }, select: { id, name, status, archivedAt } })`.
- Reuse `employeeWorkableReason` per row; treat an id with no row as `MISSING`.
- Throw `ConflictException` (409) naming every blocker, e.g.
  `Cannot start this workflow: Emma is paused. Resume Emma, or change the step to a different AI Employee.`

Then, per caller:
- `fireSchedule` `:1139-1158` — **no change** (already logs+swallows).
- `fireEvent` `:591-613` — **wrap the `enqueueRun` call in try/catch, log, `continue`.** Required, or
  one paused employee blocks every other workflow matching the same event.
- `fireWebhook` `:644-646` — let the 409 surface (or make the product call from §"could not
  determine" #1).
- `createRun` `:674-680` — let the 409 surface.
- `activate()` `:476-478` — optional but recommended: call the same assert so "turn it on" refuses
  with an actionable message.

### Step 5 — Tell the truth in readiness (advisory only)

- `workflows/readiness/workflow-readiness.ts` — add `employees: EmployeeLifecycleState[]` to
  `ReadinessInput` (`:34-45`); emit `EMPLOYEE_NOT_ACTIVE` at **`severity: 'WARNING'`** and set the
  existing `AI_EMPLOYEE` check (`:275-279`) to `'WARN'`.
- `workflows/readiness/workflow-readiness.service.ts:51-64` — load the rows and pass them in,
  exactly as `skillRequirements` is loaded.
- 🔴 **Must stay `WARNING`.** A BLOCKER breaks the `ready === (publish would succeed)` invariant
  unless `publish` gets the same gate, which §2.2 argues against.

### Step 6 — Fix the two consistency misses found along the way

- `workflows/engine/workflow-generator.service.ts:79-82` — add `status: 'ACTIVE', archivedAt: null`,
  matching `assist-read-tools.ts:190-199` (G37) and citing it.
- `engines/whatsapp/whatsapp-webhook.controller.ts:293` — the pinned `account.employeeId` path
  bypasses the ACTIVE filter its own fallback applies at `:297-306`. Validate the pinned employee
  too, and fall back (or log loudly) when it is not workable.

### Step 7 — Correct the UI copy

- `apps/web/src/features/employees/components/EmployeeCard.tsx:93-101` — the "It will stop working
  immediately" claim becomes true only after Steps 3-4 land; land them together.
- Add short truthful copy to the Pause (`:52-61`) and Disable (`:62-70`) buttons, e.g.
  *"Workflows that use it will stop. Runs already in progress will finish."* — which is exactly the
  §2.3 semantics.
- Optional (prior audit finding #5): make the Remove button fetch
  `GET /employees/:id/dependencies` and show the real counts.

### Step 8 — Fix the mock fixtures (do this before running anything)

Add `status: 'ACTIVE', archivedAt: null` to the mock employee in:
`ai-employee-step.handler.spec.ts:14-19` · `retrieve.handler.spec.ts` (the `employeeFindFirst`
resolutions) · `skills.service.spec.ts` · `approval-routing.spec.ts` ·
`credit-limits.service.spec.ts` · `marketing.service.spec.ts` ·
`whatsapp-accounts.service.spec.ts` · `whatsapp-webhook.controller.spec.ts` ·
`workflow-generator.service.spec.ts` · `assist/agent/graph-references.spec.ts`.

### Step 9 — The exact test cases needed

**New e2e suite: `apps/api/test/employee-lifecycle-enforcement.e2e-spec.ts`**

1. 🔴 **pause → workflow blocked (the headline case).** Register a company; hire an employee; build
   a workflow with an `AI_EMPLOYEE_STEP` naming it; publish+activate. `POST /workflows/:id/run`
   succeeds (proves the setup works). `PATCH /employees/:id {status:'PAUSED'}`. `POST
   /workflows/:id/run` → **409** and the body names the employee. Modelled on
   `workflow-permissions.e2e-spec.ts:177-203`.
2. **disable → same 409.**
3. **archive → same 409** (`DELETE /employees/:id`, no in-flight runs so it succeeds).
4. **ACTIVE-but-archived → still blocked.** `DELETE /employees/:id`, then
   `PATCH {status:'ACTIVE'}` (the §1.0 split state), then run → **409**. This is the case a
   status-only check would miss.
5. **SCHEDULE trigger stops firing.** Direct `WorkflowsService.fireSchedule(id)` call, count runs
   before and after the pause: 1 then **0**, no throw. Modelled verbatim on
   `workflow-canonical-path.e2e-spec.ts:257-274` (including the `deleteMany` settling trick at
   `:255-256`).
6. **EVENT trigger: one paused employee does not stop the others.** Two ACTIVE EVENT workflows on
   different connectors, same eventType; pause the employee of one; `fireEvent` → the other still
   gets a run, `count` reflects only it.
7. **Node-time enforcement for a templated employeeId.** A graph whose `employeeId` is
   `{{trigger.employeeId}}` passes the creation check (invisible there) and the node **FAILS** with
   `failureClass: 'AUTHORIZATION_DENIED'` and a message naming the employee. Assert
   `WorkflowRun.status === 'FAILED'` and `failureClass`.
8. **No retry.** Assert exactly **one** `WorkflowStepAttempt` for the failed node (durable mode) —
   proves the classification is non-retryable, which is the §1.3 defect.
9. **In-flight run is NOT cancelled.** Start a run that pauses on an APPROVAL gate; pause the
   employee; assert the run is still `WAITING` (not `CANCELLED`) and that `DELETE /employees/:id`
   still returns **409** citing `inFlightRuns`. This pins the §2.3 decision so a later change can't
   quietly start cancelling.
10. **`AI_STEP` with an employeeId that does not exist FAILS** instead of completing as "the
    workflow assistant". The silent-success regression test.
11. **A workflow naming nobody is unaffected** (trigger → HTTP → notify runs fine with a paused
    employee elsewhere in the tenant). Back-compat.

**Unit tests:** `employee-lifecycle.spec.ts` (5 inputs) · `retry-policy.service.spec.ts`
(non-retryable) · `workflow-readiness.spec.ts` (WARNING not BLOCKER, and `ready` stays `true`).

**Playwright:** extend `e2e/tests/05-failure-journeys.spec.ts` — pause an employee via the API, click
Run in the UI, assert the error surfaces in plain language on the run page (not a raw 409 body).
Optionally assert the corrected `EmployeeCard` copy.

### Step 10 — Verification (non-negotiable per `platform/CLAUDE.md`)

- Run the full e2e suite in **both** engine modes: default (durable state machine) **and**
  `WORKFLOW_ENGINE_MODE=legacy_walk`. Step 3 touches both engines' approval gates and the durable
  engine's classifier; a single-mode run proves half the fix.
- Pin providers explicitly (`LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local
  SKILL_EXECUTOR=mock BILLING_PROVIDER=mock ENCRYPTION_KEY=<64 hex>`) or expect ~78 fake failures.
- Kill any leftover dev server first — it will consume BullMQ jobs with stale code.
- Do **not** call any retention/SLA sweep from these tests, and use a throwaway company, never the
  real tenant.
