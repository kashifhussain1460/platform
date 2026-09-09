# Cluster 8 — Employee → Workflow Execution Identity & Employee Lifecycle

Source: direct code/schema read, 2026-09-09 (this pass). Every claim traced to a specific
file/line. Paths relative to `d:/Vertical AI/platform`. CLAUDE.md's claim that
`WorkflowRun.actingEmployeeId` "was a dead column until 2026-09-03" and is now real is treated as
a hypothesis and verified below — **confirmed true for the narrow claim it makes** (written + FK +
indexed + shown in UI), but the surrounding narrative overstates how far that wiring reaches.

---

## Part A — `WorkflowRun.actingEmployeeId`: what it actually does

### A.1 Written at run creation — CONFIRMED

`workflows.service.ts:993-999` derives it from the **pinned graph** (the version that will actually
execute) via `actingEmployeeIdForGraph(nodesOf(pinned?.activeVersion?.definition ?? pinned?.definition))`
(`engine/employee-references.ts:116-118`) and writes it at `workflows.service.ts:1026` inside the
`workflowRun.create()` call. Schema: `apps/api/prisma/schema.prisma:1034-1035`, real FK
(`onDelete: SetNull`), `@@index([companyId, actingEmployeeId, createdAt])` at `:1079`.

**The attribution rule** (`employee-references.ts:21-45`): the employee named by the **first
employee-bearing node in definition order** (not topological order — deliberate, see file-header
comment). A graph naming several employees is attributed to whichever acts first; the full set is
available via `employeeIdsInGraph` but is **not surfaced anywhere** (grep confirms zero other call
sites — `employee-references.ts` is called from exactly one place: `workflows.service.ts:997`).

### A.2 Read back — DISPLAY ONLY

Exactly one other reference in the whole backend: `workflows.mapper.ts:123-124` copies
`r.actingEmployeeId`/`r.actingEmployee?.name` into `WorkflowRunDto`. A full-repo grep for
`actingEmployeeId` (`apps/api/src`) returns **only 8 lines across 4 files**: the derivation module,
its spec, the one write site, and the one DTO-mapper read site. Frontend consumes it in exactly the
way cluster 6 already found: `/runs` (`RunsTable.tsx:112-117`) and `/runs/[runId]`
(`page.tsx:75-80`) show the name. **No filter, no query, no gate anywhere reads it.**

### A.3 Validated — NO

Nothing checks that `actingEmployeeId` (if non-null) still resolves to a live/ACTIVE employee before
or after a run executes. The FK is `SetNull` specifically so a hard-deleted employee doesn't break
history — but there is no re-validation step; it is write-once, forever.

### A.4 Enforced/gated anywhere — NO. Verified against every candidate:

| Candidate gate | What it actually keys on | Evidence |
|---|---|---|
| **Skill executor connection resolution** ("whose connection to use") | `cfg.employeeId` read **per-node** from the node's own JSON config, resolved independently at execution time — never `run.actingEmployeeId` | `engine/nodes/tool-action.handler.ts:92-95,134-145` ("own connector" resolution keys on the node's local `employeeId`, comment at :86-91 explicitly says "same convention as AI_STEP's cfg.employeeId") |
| **Workflow-permissions RUN gating** (`workflow:run` at enqueue) | `subjectUserId` — the clicking **User** (MANUAL) or the pinned version's `publishedById` (SCHEDULE/EVENT/WEBHOOK) — a human/publisher identity, never an AI Employee | `workflows.service.ts:1001-1008` (`assertCanRun(companyId, workflowId, subjectUserId)`) |
| **Approval routing** (`EMPLOYEE_MANAGER` rule) | `ctx.employeeId` passed in by the caller **per approval gate**, sourced from the specific node's own `cfg.employeeId` (`approval-gate.service.ts:179-189`, `workflow-engine.service.ts:629-639`) — same per-node convention, not the run-level column | `approval-routing.service.ts:91,114-116` |
| **Usage/credit attribution** (`UsageEvent`, `CreditLedger`, `CreditReservation`) | `employeeId` param supplied by the **caller of each individual LLM/tool call** — in the AI_STEP handler this is the node's own `cfg.employeeId`, written to the reservation (`ai-step.handler.ts:184-193`) and the final usage record (`:254-258`) | `usage.service.ts:85`, `credit-ledger.service.ts:230`, schema `CreditLedger.employeeId`/`CreditReservation.employeeId` (`schema.prisma:1250,1383`) are plain nullable columns with **no relation to `WorkflowRun.actingEmployeeId`** |
| **Audit log** (`AuditLog.employeeId`) | Caller-supplied `params.employeeId ?? ctx?.employeeId` (`audit-log.service.ts:124`) — but every `workflow.*` audit call in `workflows.service.ts` (create/update/archive/hard_delete/run.cancel, lines 219,346,410,434,874) passes **no `employeeId` at all**. The workflow engine itself (`workflow-engine.service.ts`) never calls `auditLog.record` — zero matches. | grep confirms `AuditLog.employeeId` is populated by some other flow entirely (e.g. direct employee actions), never by a workflow run |

**Verdict: SCHEMA-ONLY / DISPLAY-ONLY, not functionally enforced.** `actingEmployeeId` is a clean,
correctly-derived, correctly-indexed column that answers exactly one question — "whose name shows on
the runs table" — and nothing else. Every place that actually *needs* to know "which employee" for a
real decision (connector choice, approval routing, budget/credit debit, permission gate) already had
its own, independent, per-node `cfg.employeeId` mechanism **before** this column was wired, and
continues to use it. The 2026-09-03 fix closed "the column is dead," not "employee identity doesn't
reach execution" — that second, more important thing was already true via the per-node convention.

### A.5 A concrete symptom of the display-only status: the index has no query using it

`schema.prisma:1075-1079` comments the `[companyId, actingEmployeeId, createdAt]` index as being for
*"Show me everything this AI Employee did" — the employee detail page, the per-employee KPI table,
and any future per-employee audit view.* Checked `GET /workflows/runs` (`workflows.controller.ts:114-122`):
filters are `status`, `workflowId`, `limit` only — **no `employeeId` query param exists**, and no other
endpoint filters `WorkflowRun` by `actingEmployeeId`. The index was built ahead of a feature that does
not exist yet.

---

## Part B — Multiple workflows per AI Employee

### B.1 No persistent ownership FK — CONFIRMED (derived-only)

Read the full `Workflow` model (`schema.prisma:905-981`): fields are `companyId`, `ownerUserId`
(the **creating User**, P3-06), `sourceTemplateId`, `assistSessionId` — **there is no `employeeId`
column and no relation to `AiEmployee` at all.** "Which employee(s) this workflow involves" is 100%
derived from `definition`/`WorkflowVersion.definition` JSON at read time (`deriveEmployees.ts:40-62`,
frontend; `employees.service.ts:309-323`, backend). One AiEmployee **can** appear in many workflows'
graphs simultaneously — nothing prevents it, and nothing tracks it as a formal relationship.

### B.2 "All workflows for employee X" — NO API, NO UI

- **Backend:** `employees.service.ts:309-323` (`workflowsReferencing`) is the only server-side query
  that finds workflows naming an employee, and it is **private** — called only from `dependencies()`
  (`:271`) for the delete/archive safety check. It is not exposed via any controller route.
  It also matches only `Workflow.definition` (the legacy JSON column), not `WorkflowVersion.definition`
  directly — safe in practice because `workflow-version.service.ts:67` confirms `Workflow.definition`
  is still written on every publish, but an **unpublished draft edit that adds/removes an employee
  reference is caught too**, since the canvas autosaves straight to that same column (per CLAUDE.md's
  documented readiness-invariant behavior) — so this is more current than it first looks, not a gap.
- **Frontend:** grepped `apps/web/src/features/employees` for `workflow` (case-insensitive) — the only
  two hits are unrelated prose strings in `EmployeeSettings.tsx:306,480` about budget limits blocking
  "workflow AI steps." **Zero components** render a workflow list on an employee page. The reverse
  direction (workflow → its employees) is fully built (`deriveEmployees.ts`, used by `WorkflowRow.tsx`)
  but nothing analogous exists employee → its workflows.
- **Classification: UNREACHABLE (backend capability exists internally, never exposed) / genuinely
  MISSING (frontend).**

### B.3 EVENT single-active-trigger conflict — correctly employee-agnostic, not employee-scoped

`assertNoConflictingEventTrigger` (`workflows.service.ts:522-556`) scopes the conflict check purely on
`companyId` + `triggerType:'EVENT'` + `triggerConfig.eventType` + `triggerConfig.connectorId` overlap.
It has **no concept of "employee" at all** — it will correctly block two workflows on the same
connector+eventType regardless of which employee(s) each graph names, and will correctly allow two
workflows on *different* connectors even if they name the *same* employee. This is the right behavior
for what the constraint is actually protecting (double-firing on one connector's event stream, doc
§5.2), not a gap — but it does mean "per-employee" isn't a scoping axis this system has any notion of;
there is no scenario today where two different employees' workflows are prevented from running
concurrently by employee identity, nor should there be, per the current design.

---

## Part C — Employee lifecycle

### C.1 States and transitions

`EmployeeStatus` (`schema.prisma:53-57`): `ACTIVE | PAUSED | DISABLED` (a status enum), plus
`archivedAt: DateTime?` (soft-delete, orthogonal to status). **There is no separate "Configure" or
"Activate" step distinct from creation** — an employee is created directly `ACTIVE`
(schema default) and is immediately usable; "Activate" as a lifecycle stage exists for `Workflow`
(DRAFT→PUBLISH→activate) but has no analogue for `AiEmployee`.

| Transition | Endpoint | Effect |
|---|---|---|
| Create | `POST /employees` (`employees.controller.ts:41-48`) | Seat-checked inside an advisory-locked tx (`employees.service.ts:95-132`); starts `ACTIVE`. |
| Update / Pause / Disable / Re-enable | `PATCH /employees/:id` (`:69-77`), UI: `EmployeeCard.tsx:62-80` (`setStatus('DISABLED'|'ACTIVE')`) | Plain column write, `employees.service.ts:189-238`. **No status-transition validation** (any status → any status is accepted). |
| Archive (soft delete) | `DELETE /employees/:id` (no `?hard=true`) | `status:'DISABLED', archivedAt: now()` (`employees.service.ts:402-405`); blocked (409) if `inFlightRuns>0` or `pendingApprovals>0` (`:361-372`). |
| Hard delete | `DELETE /employees/:id?hard=true`, OWNER-only (`employees.controller.ts:112-118`) | Real `prisma.aiEmployee.delete()` (`:375`) — cascades per schema `onDelete: Cascade`: `Conversation`→`Message`, `EmployeeMemory`, `EmployeeFeedback`, `EmployeeSkill`, `InstalledSkill` (destroys encrypted per-employee credentials). |
| `GET /employees/:id/dependencies` | `employees.controller.ts:84-90` | **Real, working endpoint** — counts connections/conversations/memories/skillGrants/skillExecutions/approvalRequests/pendingApprovals/referencingWorkflows/inFlightRuns (`employees.service.ts:247-298`). **Confirmed orphaned on the frontend**: grepped `apps/web/src/features/employees` for `dependencies` — 0 matches. `EmployeeCard.tsx:90-110`'s "Remove" button calls `del.mutate()` directly with a static confirm-dialog string, never fetching this endpoint first — matching cluster 6's finding exactly, now confirmed from the caller side too. |

### C.2 What pause/disable/archive actually do to each dependent system — the core finding

Grepped every workflow-engine node handler (`ai-step.handler.ts`, `tool-action.handler.ts`,
`memory.handlers.ts`, `retrieve.handler.ts`, `approval-gate.service.ts`, `workflow-engine.service.ts`)
for `status`/`archivedAt` filters on their `aiEmployee.findFirst({ where: { id, companyId } })` calls —
**zero matches across all six files.** Only one place in the entire codebase checks
`employee.status !== 'ACTIVE'`: `agent-runtime.service.ts:126-131`, which gates **chat only**
(`EmployeesService.sendMessage` → `AgentRuntimeService.run`).

| Dependent system | On PAUSE | On DISABLE | On ARCHIVE (soft) | On HARD DELETE |
|---|---|---|---|---|
| Chat (`/employees/:id` conversation) | 409 (`agent-runtime.service.ts:127-130`) | 409 (same check) | 409 (same — employee is also set DISABLED) | Employee gone; conversations cascade-deleted too |
| **Scheduled/EVENT workflow triggers** | **Keep firing** — nothing in `activate`/`fireEvent`/the schedule sweep checks the employee status of any node the triggered workflow's graph references | **Keep firing** — same | **Keep firing** — archiving only blocks *if a run is in flight right now*; it does nothing to the workflow's own trigger, which remains `ACTIVE` and will create brand-new runs later | Runs still get created; `ai-step.handler`/etc. do `findFirst` by id, get nothing back, and **silently degrade** to a generic "the workflow assistant" persona (`ai-step.handler.ts:92-93,101-119` — `if (employee)` else-branch keeps `name='the workflow assistant'`, empty persona) rather than failing the step |
| **In-flight runs at the moment of the transition** | Unaffected — no check exists | Unaffected — no check exists | **Blocks the archive itself** (409, `employees.service.ts:361-366`) rather than cancelling/orphaning them — archive simply cannot proceed until they finish naturally | Same block applies (`remove()` runs the same `dependencies()` check for both paths) |
| Pending approvals | Unaffected | Unaffected | **Blocks the archive** (409, `:367-372`) | Same block |
| Skill connections (`InstalledSkill`) | Left fully `CONNECTED`, usable | Left fully `CONNECTED`, usable — `tool-action.handler.ts` resolves it with no employee-status check | Left fully `CONNECTED`, usable (only the employee row itself is marked disabled+archived; the credential row is untouched) | Cascade-deleted (`onDelete: Cascade`) — credentials destroyed, by design (`employees.service.ts:330-343` doc-comment) |
| Audit trail | N/A | N/A | Preserved — `AuditLog` has no FK to `AiEmployee` (`schema.prisma:355-401`); explicit `employee.archive` entry written with `retained:{...deps}` metadata (`employees.service.ts:410-417`) | Preserved — explicit `employee.hard_delete` entry with `destroyed:{...deps}` (`:382-389`); loose `SkillExecution.employeeId`/`ApprovalRequest.employeeId` strings go dangling (no FK, by design — audit rows aren't supposed to disappear) |
| Credit/budget records (`EmployeeCreditPeriodCounter`, `budgetLimit` enforcement) | Still enforced — `ai-step.handler.ts:106-117` re-checks `employee.budgetLimit` on every AI_STEP regardless of status | Still enforced (same) | **Still enforced** even after archival, because the budget check runs off the same status/archivedAt-blind `findFirst` | `EmployeeCreditPeriodCounter` has no relation/FK (`schema.prisma:1582-1601`) — survives untouched, now permanently orphaned from a name |
| Other entities referencing it (Workflow graphs) | No FK exists to enforce anything — see B.1 | Same | Same | Same — a hard-deleted employee's id keeps appearing as a plain string inside `Workflow.definition`/`WorkflowVersion.definition` JSON forever; nothing cleans it up, nothing warns about it after the fact (the warning only fires once, at delete time, via `dependencies()`) |

**Net reading:** the lifecycle model is real and reasonably careful in exactly the two places it was
built for — the plan-seat count (`checkSeatFor`, `billing.plans.ts:148,165`: PAUSED occupies a seat,
DISABLED frees one) and the delete/archive safety check (`dependencies()` blocking on live
dependencies). Everywhere else — and specifically everywhere a **workflow run** touches the employee
— pause/disable/archive is **decorative**. The `EmployeeCard.tsx:93` UI copy ("Remove from your
roster... **It will stop working immediately**") is not accurate for any workflow that references this
employee and still has an `ACTIVE` SCHEDULE/EVENT trigger: that workflow keeps creating runs, and
those runs keep executing the archived employee's persona/model/budget/skill-connections exactly as
before, for as long as the workflow itself stays active.

---

## Top 5 most severe findings

1. **Employee pause/disable/archive does not stop workflow execution.** Every workflow-engine node
   handler that resolves an employee (`ai-step.handler.ts`, `tool-action.handler.ts`,
   `memory.handlers.ts`, `retrieve.handler.ts`, `approval-gate.service.ts`) does a bare
   `findFirst({ id, companyId })` with no `status`/`archivedAt` filter — the ONLY status check in the
   whole codebase (`agent-runtime.service.ts:127`) gates chat, not workflows. The `EmployeeCard.tsx`
   "Remove" button's own copy ("It will stop working immediately") is factually wrong for any employee
   still referenced by an ACTIVE scheduled/event workflow.

2. **`WorkflowRun.actingEmployeeId` is genuinely display-only**, despite being framed by CLAUDE.md as
   the platform's headline identity fix. A full-repo grep shows exactly 4 files reference it: the
   derivation module, its spec, one write site, one DTO-mapper read site. Every real decision that
   needs an employee identity (connector choice, approval routing, credit/usage attribution) already
   uses an independent, per-node `cfg.employeeId` that predates and bypasses this column entirely.

3. **The `[companyId, actingEmployeeId, createdAt]` index has zero queries using it.** Its own schema
   comment names the intended feature ("the employee detail page, the per-employee KPI table... any
   future per-employee audit view") but `GET /workflows/runs` only filters by `status`/`workflowId`,
   and no other endpoint filters by `actingEmployeeId` — the index was shipped ahead of the feature.

4. **There is no persistent Workflow↔AiEmployee ownership relationship, and no way — API or UI — to
   list "all workflows for employee X."** The backend actually has this query
   (`employees.service.ts:309-323`, `workflowsReferencing`) but it's private, used only to gate
   delete/archive; it was never exposed as a route. The frontend has zero components for it in either
   direction from the employee side (the reverse, workflow→employees, is fully built).

5. **`GET /employees/:id/dependencies` is a second orphaned safety-check endpoint of the same shape
   cluster 6 already found for workflows.** Fully implemented, richly informative (9 counts), never
   called by the frontend — `EmployeeCard.tsx`'s delete button fires the mutation directly behind a
   generic hardcoded confirm string instead of showing the real numbers this endpoint computes.
