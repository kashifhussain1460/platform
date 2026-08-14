# Workflow UX Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the workflow experience from a 10-screen engineering ceremony into `Describe → Review → Publish → Runs`, without weakening any backend safety guarantee.

**Architecture:** The backend keeps every lifecycle state it has today (DRAFT/VALIDATING/PUBLISHED/ACTIVE/PAUSED/ARCHIVED, immutable versions, durable runtime, approvals, idempotency). Three small read/orchestration endpoints are added so the frontend can *present* one step where the platform performs many: a non-mutating **readiness preflight**, a **publish-and-activate** flag, and a **global runs list**. Everything else is frontend: a build-method chooser, autosave status, one Review & Publish surface, schedule config inside the trigger, and first-class Runs / Schedules operational views.

**Tech Stack:** NestJS + Prisma (apps/api) · Next.js App Router + TanStack Query + Zustand + rhf/zod (apps/web) · `@vaep/types` shared DTOs (built CommonJS — rebuild after adding types).

**Spec:** `platform/docs/implementation/workflow-system/orlixa-workflow-ux-simplification-cto-plan.md`

## Global Constraints

- **UX simplicity must not reduce backend safety** (spec §2, §44, §61). No frontend path may skip authorization, approval, validation, versioning, idempotency or audit. Every new "one-click" action is a *sequence of the existing guarded calls*, never a new unguarded path.
- **Same canonical model for both creation methods** (spec §33). AI Assist and the manual builder must produce the same `WorkflowDefinition`, go through the same `PUT /draft` → `POST /publish` pipeline, and land in the same editor.
- **Versioning stays** (spec §16). Runs stay pinned to `workflowVersionId`. Users never type or pick a version id.
- **Do not hide execution states** (spec §46). All 8 run statuses stay visible; only *workflow* lifecycle states are simplified to Draft/Active/Paused/Archived (spec §15, §45).
- **Reuse real backend contracts** (spec §55). No invented endpoints where one exists.
- **Feature flag:** `simplifiedWorkflowUX` (spec §63) gates the new creation/publish surfaces; the legacy controls stay reachable until the flag is removed.
- **Node vocabulary:** default palette = Trigger, AI Employee, Action, Condition, Approval, Wait, Notify, End; everything else behind "Advanced" (spec §32).
- Run e2e in **both** engine modes (`pnpm test` and `WORKFLOW_ENGINE_MODE=legacy_walk pnpm test`) — repo standing rule.
- Frontend `features/*` mirror backend `modules/*`; one `apiClient`, one `queryClient`; mutations use optimistic `onMutate`→rollback→`onSettled`.

---

## File Structure

### Backend — `apps/api/src/modules/workflows/`
| File | Responsibility |
|---|---|
| `readiness/workflow-readiness.ts` (create) | **Pure** function: definition + trigger + skill requirements + approval config → `WorkflowReadinessDto`. No I/O, unit-testable. |
| `readiness/workflow-readiness.service.ts` (create) | Loads the inspection definition + skill requirements, calls the pure evaluator. |
| `workflows.controller.ts` (modify) | `GET :id/readiness`, `GET runs` (global), `activate` flag on `POST :id/publish`. |
| `workflows.service.ts` (modify) | `listAllRuns(companyId, filters)`. |
| `dto/publish-workflow.dto.ts` (modify, inside `workflow-version.dto.ts`) | `activate?: boolean`. |

### Shared types — `packages/types/src/index.ts`
`WorkflowReadinessCheckDto`, `WorkflowReadinessIssueDto`, `WorkflowReadinessDto`, `PublishWorkflowResultDto.activated/workflow`, `WorkflowRunDto.workflowName`.

### Frontend — `apps/web/src/`
| File | Responsibility |
|---|---|
| `features/workflows/lifecycle.ts` (create) | Pure status → user-facing label/tone mapping (spec §15/§45/§46/§47). |
| `features/workflows/schedule.ts` (create) | Pure friendly-schedule ⇄ `TriggerConfig` codec + `nextRunAt` + human summary. |
| `features/workflows/api.ts` / `hooks.ts` (modify) | `getWorkflowReadiness`, `publishWorkflow({activate})`, `listAllRuns`. |
| `features/workflows/components/builder/ReviewPublishDialog.tsx` (create) | The single Review & Publish surface (spec §13/§14/§57). |
| `features/workflows/components/builder/AutosaveStatus.tsx` (create) | Saving… / Saved just now / Save failed — Retry (spec §11). |
| `features/workflows/components/builder/ScheduleFields.tsx` (create) | Frequency/Day/Time/Timezone/Next run (spec §18). |
| `features/workflows/components/CreateWorkflowChooser.tsx` (create) | AI vs Manual entry cards (spec §5). |
| `features/runs/{api,hooks,labels}.ts` + `components/*` (create) | Global runs list, execution timeline, failure recovery (spec §25/§26/§28). |
| `features/schedules/{hooks}.ts` + `components/ScheduleTable.tsx` (create) | Operational schedule view derived from workflows (spec §22). |
| `app/(app)/workflows/new/page.tsx`, `app/(app)/runs/page.tsx`, `app/(app)/runs/[runId]/page.tsx`, `app/(app)/schedules/page.tsx`, `app/(app)/workflows/[id]/runs/page.tsx`, `app/(app)/workflows/[id]/versions/page.tsx` (create) | Routes from spec §53. |
| `components/app-shell/Sidebar.tsx` (modify) | Automation group: Workflows / Runs / Schedules. |
| `lib/featureFlags.ts` (create) | `simplifiedWorkflowUX`. |

---

## Wave A — Backend contract

### Task A1: Workflow readiness preflight

**Files:**
- Create: `apps/api/src/modules/workflows/readiness/workflow-readiness.ts`
- Create: `apps/api/src/modules/workflows/readiness/workflow-readiness.service.ts`
- Create: `apps/api/src/modules/workflows/readiness/workflow-readiness.spec.ts`
- Modify: `apps/api/src/modules/workflows/workflows.controller.ts`, `workflows.module.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces produced:**
```ts
export type WorkflowReadinessSeverity = 'BLOCKER' | 'WARNING';
export interface WorkflowReadinessIssueDto {
  code: string;            // 'TRIGGER_INCOMPLETE' | 'SKILL_NOT_CONNECTED' | ...
  severity: WorkflowReadinessSeverity;
  message: string;         // plain-language, actionable
  nodeId?: string;
  fix?: { kind: 'CONNECT_SKILL' | 'OPEN_NODE' | 'OPEN_TRIGGER'; target?: string };
}
export interface WorkflowReadinessCheckDto {
  key: 'STRUCTURE' | 'TRIGGER' | 'NODE_CONFIG' | 'AI_EMPLOYEE' | 'SKILLS' | 'CONNECTIONS' | 'APPROVAL' | 'SCHEDULE';
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN';
}
export interface WorkflowReadinessDto {
  workflowId: string;
  ready: boolean;                       // no BLOCKER issues
  checks: WorkflowReadinessCheckDto[];
  issues: WorkflowReadinessIssueDto[];
  summary: {                            // for the review card (spec §13)
    name: string; triggerSummary: string; employeeNames: string[];
    skillKeys: string[]; approverSummary: string | null; stepCount: number;
  };
}
```

- [ ] **Step 1: Write the failing unit test** — `workflow-readiness.spec.ts`:
```ts
import { evaluateReadiness } from './workflow-readiness';

const trigger = { id: 't', type: 'TRIGGER', name: 'Start' } as never;

it('blocks when a TOOL_ACTION skill has no connection', () => {
  const result = evaluateReadiness({
    workflowId: 'w1', name: 'Weekly leads',
    definition: { nodes: [trigger, { id: 'a', type: 'TOOL_ACTION', name: 'Send email', config: { skillKey: 'gmail', tool: 'send_email' } }], edges: [{ from: 't', to: 'a' }] } as never,
    triggerType: 'MANUAL', triggerConfig: null,
    skillRequirements: [{ skillKey: 'gmail', skillName: 'Gmail', status: 'NOT_INSTALLED', canManageConnection: true }] as never,
    warnings: [],
  });
  expect(result.ready).toBe(false);
  expect(result.issues.map((i) => i.code)).toContain('SKILL_NOT_CONNECTED');
  expect(result.checks.find((c) => c.key === 'CONNECTIONS')!.status).toBe('FAIL');
});

it('is ready for a complete manual workflow', () => {
  const result = evaluateReadiness({
    workflowId: 'w1', name: 'Ping',
    definition: { nodes: [trigger, { id: 'n', type: 'AI_EMPLOYEE_STEP', name: 'Draft', config: { employeeId: 'e1', prompt: 'hi' } }], edges: [{ from: 't', to: 'n' }] } as never,
    triggerType: 'MANUAL', triggerConfig: null, skillRequirements: [], warnings: [],
  });
  expect(result.ready).toBe(true);
  expect(result.issues).toHaveLength(0);
});

it('blocks a SCHEDULE trigger with no cron or interval', () => {
  const result = evaluateReadiness({
    workflowId: 'w1', name: 'S',
    definition: { nodes: [trigger, { id: 'n', type: 'NOTIFY', name: 'Tell', config: { message: 'x' } }], edges: [{ from: 't', to: 'n' }] } as never,
    triggerType: 'SCHEDULE', triggerConfig: {}, skillRequirements: [], warnings: [],
  });
  expect(result.issues.map((i) => i.code)).toContain('TRIGGER_INCOMPLETE');
});

it('blocks an APPROVAL node with no approver rule', () => {
  const result = evaluateReadiness({
    workflowId: 'w1', name: 'A',
    definition: { nodes: [trigger, { id: 'ap', type: 'APPROVAL', name: 'Manager sign-off', config: {} }], edges: [{ from: 't', to: 'ap' }] } as never,
    triggerType: 'MANUAL', triggerConfig: null, skillRequirements: [], warnings: [],
  });
  expect(result.issues.map((i) => i.code)).toContain('APPROVAL_NO_APPROVER');
});
```
- [ ] **Step 2: Run it, confirm it fails** — `cd apps/api && pnpm run test:unit -- workflow-readiness`. Expected: "Cannot find module './workflow-readiness'".
- [ ] **Step 3: Implement `evaluateReadiness`.** Reuse the existing validators rather than re-deriving rules: import `validateDefinitionStructure` from `engine/definition-validator`, and map its thrown/returned messages to `STRUCTURE` issues. Add trigger checks (SCHEDULE needs `cron` or `everyMs ≥ 15000`; EVENT needs `eventType`), node-config checks (every non-TRIGGER node's required config keys present per `NODE_CATALOG`), `AI_EMPLOYEE_STEP.config.employeeId` present, `SKILLS`/`CONNECTIONS` from `skillRequirements` (`status !== 'CONNECTED'` → BLOCKER `SKILL_NOT_CONNECTED` with `fix.kind='CONNECT_SKILL'`), `APPROVAL` nodes need an approver rule, and the DTO's `warnings[]` become WARNING issues (`UNREACHABLE_STEP`). `ready = issues.every(i => i.severity !== 'BLOCKER')`.
- [ ] **Step 4: Add the service** — `WorkflowReadinessService.forWorkflow(companyId, id)` loads the workflow (`WorkflowsService.findOne`), `WorkflowVersionService.resolveDefinitionForInspection`, and `SkillRequirementsService.forDefinition`, then calls the pure evaluator.
- [ ] **Step 5: Add the route** — `@Get(':id/readiness')` (any member, read-only; mirrors `skill-requirements`). Register the service in `workflows.module.ts`. Place it **above** `@Get(':id')` ordering is irrelevant in Nest (distinct paths) but keep it next to `skill-requirements` for readability.
- [ ] **Step 6: e2e** — `apps/api/test/e2e/workflow-readiness.e2e-spec.ts`: (a) a workflow with an unconnected gmail TOOL_ACTION → `ready:false` + `SKILL_NOT_CONNECTED`; (b) after installing+connecting the skill → `ready:true`; (c) another tenant gets 404.
- [ ] **Step 7: Run** `pnpm test -- workflow-readiness` → PASS. Rebuild types: `pnpm --filter @vaep/types build`.
- [ ] **Step 8: Commit** — `feat(workflows): add non-mutating readiness preflight`.

### Task A2: Publish & Activate in one call

**Files:** Modify `apps/api/src/modules/workflows/dto/workflow-version.dto.ts`, `workflows.controller.ts`, `packages/types/src/index.ts`; Test `apps/api/test/e2e/workflow-publish-activate.e2e-spec.ts`.

**Interfaces produced:** `PublishWorkflowDto { changeNote?: string; activate?: boolean }`; `PublishWorkflowResultDto` gains `activated: boolean` and `workflow: WorkflowDto | null`.

- [ ] **Step 1: Failing e2e** — publish with `{ activate: true }` → 200, `result.activated === true`, `result.workflow.status === 'ACTIVE'`; a second identical call → `unchanged: true` and still ACTIVE (idempotent, spec §14). A publish that fails validation must **not** activate.
- [ ] **Step 2: Run it, confirm failure.**
- [ ] **Step 3: Implement in the controller** (not the version service — activation lives on `WorkflowsService`, and the controller already injects both, so this avoids a module cycle):
```ts
const result = await this.versions.publish(companyId, id, user.userId, dto.changeNote);
if (!dto.activate) return { ...result, activated: false, workflow: null };
const workflow = await this.workflows.activate(companyId, id);
return { ...result, activated: true, workflow };
```
Keep `@Roles('OWNER','ADMIN')` — activation has the same guard, so no privilege is gained.
- [ ] **Step 4: Run e2e → PASS.**
- [ ] **Step 5: Commit** — `feat(workflows): publish can activate in the same request`.

### Task A3: Global runs list

**Files:** Modify `workflows.service.ts`, `workflows.controller.ts`, `workflows.mapper.ts`, `packages/types/src/index.ts`; Test `apps/api/test/e2e/workflow-runs-global.e2e-spec.ts`.

**Interfaces produced:** `GET /workflows/runs?status=&workflowId=&limit=` → `WorkflowRunDto[]` with a new optional `workflowName?: string`.

- [ ] **Step 1: Failing e2e** — two workflows each with a run; `GET /workflows/runs` returns both newest-first with `workflowName` populated; `?status=COMPLETED` filters; another tenant sees none.
- [ ] **Step 2: Run it, confirm failure** (route currently 404s — note `@Get('runs/:runId')` exists but not `@Get('runs')`).
- [ ] **Step 3: Implement `listAllRuns(companyId, { status, workflowId, limit })`** — `prisma.workflowRun.findMany({ where: { companyId, ...(status && { status }), ...(workflowId && { workflowId }) }, orderBy: { createdAt: 'desc' }, take: clampLimit(limit), include: { workflow: { select: { name: true } } } })`, mapped with `workflowName`. Add `@Get('runs')` **above** `@Get('runs/:runId')`.
- [ ] **Step 4: Run e2e → PASS. Rebuild types.**
- [ ] **Step 5: Commit** — `feat(workflows): global cross-workflow runs list`.

---

## Wave B — Shared frontend primitives

### Task B1: Lifecycle labels + schedule codec (pure, tested)

**Files:** Create `apps/web/src/features/workflows/lifecycle.ts`, `schedule.ts`, `__tests__/lifecycle.test.ts`, `__tests__/schedule.test.ts`.

**Interfaces produced:**
```ts
// lifecycle.ts
export function workflowStateLabel(w: Pick<WorkflowDto,'status'|'activeVersionId'>): { label: 'Draft'|'Active'|'Paused'|'Archived'; tone: 'neutral'|'good'|'warn'|'muted' };
export function runStateLabel(s: WorkflowRunStatus): { label: string; tone: 'neutral'|'good'|'bad'|'warn'|'muted' };
// 'WAITING' → 'Waiting for approval'; 'TIMED_OUT' → 'Timed out'; 'CANCELLED' → 'Cancelled'.

// schedule.ts
export type FriendlySchedule =
  | { frequency: 'HOURLY'; minute: number }
  | { frequency: 'DAILY'; hour: number; minute: number }
  | { frequency: 'WEEKDAYS'; hour: number; minute: number }
  | { frequency: 'WEEKLY'; weekday: number; hour: number; minute: number }
  | { frequency: 'MONTHLY'; day: number; hour: number; minute: number }
  | { frequency: 'INTERVAL'; everyMs: number }
  | { frequency: 'CUSTOM'; cron: string };
export function toTriggerConfig(s: FriendlySchedule): TriggerConfig;
export function fromTriggerConfig(c: TriggerConfig | null): FriendlySchedule | null;
export function describeSchedule(c: TriggerConfig | null, timezone: string): string; // "Every Monday · 09:00 · Asia/Kolkata"
export function nextRunAt(c: TriggerConfig | null, from: Date, timezone: string): Date | null; // null for CUSTOM cron we can't parse
```

- [ ] **Step 1: Failing tests.**
```ts
it('round-trips a weekly schedule', () => {
  const cfg = toTriggerConfig({ frequency: 'WEEKLY', weekday: 1, hour: 9, minute: 0 });
  expect(cfg.cron).toBe('0 9 * * 1');
  expect(fromTriggerConfig(cfg)).toEqual({ frequency: 'WEEKLY', weekday: 1, hour: 9, minute: 0 });
});
it('falls back to CUSTOM for an unrecognised cron', () => {
  expect(fromTriggerConfig({ cron: '*/7 3 2 4 5' })).toEqual({ frequency: 'CUSTOM', cron: '*/7 3 2 4 5' });
});
it('computes the next daily run after the time has passed today', () => {
  const next = nextRunAt({ cron: '0 9 * * *' }, new Date('2026-08-14T10:00:00Z'), 'UTC');
  expect(next!.toISOString()).toBe('2026-08-15T09:00:00.000Z');
});
it('returns null for a cron it cannot parse', () => {
  expect(nextRunAt({ cron: '*/7 3 2 4 5' }, new Date(), 'UTC')).toBeNull();
});
it('maps WAITING to a plain-language run label', () => {
  expect(runStateLabel('WAITING').label).toBe('Waiting for approval');
});
```
- [ ] **Step 2: Run** `cd apps/web && pnpm test -- schedule` → FAIL.
- [ ] **Step 3: Implement.** No new dependency: `nextRunAt` handles exactly the cron shapes `toTriggerConfig` emits (`m h * * *`, `m h * * 1-5`, `m h * * D`, `m h D * *`, `m * * * *`) plus `everyMs`; anything else returns `null` and the UI shows the raw expression. Timezone handling via `Intl.DateTimeFormat(tz)` offset arithmetic — no dependency.
- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit** — `feat(web): workflow lifecycle labels + schedule codec`.

### Task B2: API + hooks for the new contracts

**Files:** Modify `apps/web/src/features/workflows/api.ts`, `hooks.ts`; Create `apps/web/src/lib/featureFlags.ts`.

**Interfaces produced:**
```ts
export function useWorkflowReadiness(id: string, enabled: boolean); // GET :id/readiness, staleTime 0
export function usePublishAndActivate(id: string); // saveDraft → publish({activate:true}); returns PublishWorkflowResultDto
export function useAllRuns(filters: { status?: WorkflowRunStatus; workflowId?: string; limit?: number });
export const simplifiedWorkflowUX: boolean; // NEXT_PUBLIC_SIMPLIFIED_WORKFLOW_UX !== 'false' (default ON)
```
- [ ] **Step 1:** Add `getWorkflowReadiness`, `listAllRuns` to `api.ts`; extend `publishWorkflow` with `activate?: boolean`.
- [ ] **Step 2:** Add the hooks to `hooks.ts`. `usePublishAndActivate` mirrors `usePublishWorkflow`'s fresh-read → `saveWorkflowDraft` → publish sequence, then on success patches `workflowKeys.detail(id)` with the returned `workflow` (status ACTIVE) and invalidates versions + list. Add `workflowKeys.readiness(id)` and `workflowKeys.allRuns(filters)`.
- [ ] **Step 3:** `lib/featureFlags.ts` reading `process.env.NEXT_PUBLIC_SIMPLIFIED_WORKFLOW_UX`.
- [ ] **Step 4:** `pnpm --filter @vaep/web run typecheck` → clean.
- [ ] **Step 5: Commit** — `feat(web): readiness + publish-and-activate + global runs hooks`.

---

## Wave C — Creation flow (spec §5, §6, §7)

### Task C1: `/workflows/new` build-method chooser

**Files:** Create `apps/web/src/app/(app)/workflows/new/page.tsx`, `apps/web/src/features/workflows/components/CreateWorkflowChooser.tsx`; Modify `app/(app)/workflows/page.tsx`.

- [ ] **Step 1:** `CreateWorkflowChooser` renders two cards (spec §5): **Build with AI** — a textarea + "Generate workflow" that calls `useCreateAssistSession({ prompt })` and routes to `/assist/<id>?start=1`; **Start from scratch** — a name field + "Open builder" that calls `useCreateWorkflow` with an empty TRIGGER-only definition and routes to `/workflows/<id>`. A third quiet link: "Start from a template" → `/workflows/templates`.
- [ ] **Step 2:** Gate the AI card on `subscription.plan === 'BUSINESS' | 'ENTERPRISE'` (the existing `/workflows/generate` PlanGuard); when locked show "Available on Business and Enterprise" instead of hiding it.
- [ ] **Step 3:** On `/workflows`, when `simplifiedWorkflowUX` is on, replace the three inline toggles (`GenerateWorkflowChat`, `WorkflowForm`, template link) with a single `+ Create workflow` link to `/workflows/new`. Keep the legacy branch behind the flag being off.
- [ ] **Step 4:** Typecheck + click through in the browser: `/workflows` → `+ Create workflow` → both paths land in an editor.
- [ ] **Step 5: Commit** — `feat(web): single create-workflow entry with AI and manual paths`.

### Task C2: AI Assist opens the editor without an Accept ceremony

**Files:** Modify `apps/web/src/app/(app)/assist/[sessionId]/page.tsx`.

- [ ] **Step 1:** When the stream finishes (`stream.status` leaves `'streaming'`), the graph has ≥1 non-TRIGGER node, `session.createdWorkflowId` is null, and `canAccept` — auto-invoke `accept.mutate({ name: session.title })` **once** (guard with a `useRef`), then `router.push('/workflows/' + w.id)`. This is spec §7: the generated draft is already editable; the Workflow row is an implementation detail, not a user step.
- [ ] **Step 2:** Keep `AcceptBar` as the fallback for the cases auto-accept deliberately skips: user lacks permission, the auto-create errored, or unresolved nodes exist (then show "Orlixa couldn't fill in N steps — open the builder to finish"). Never silently swallow the error.
- [ ] **Step 3:** Verify the guard cannot double-create: `startedRef`-style ref plus the `session.createdWorkflowId` check; React's dev double-effect must not produce two workflows.
- [ ] **Step 4:** Browser check — describe a workflow, watch it land in `/workflows/<id>` with the graph intact.
- [ ] **Step 5: Commit** — `feat(web): AI Assist hands the draft straight to the editor`.

---

## Wave D — Editor (spec §10–§14, §18)

### Task D1: Autosave status (spec §11)

**Files:** Create `apps/web/src/features/workflows/components/builder/AutosaveStatus.tsx`; Modify `canvas/WorkflowCanvas.tsx`, `builder/BuilderLifecycleBar.tsx`.

- [ ] **Step 1:** `AutosaveStatus({ state, savedAt, onRetry })` where `state: 'idle'|'saving'|'saved'|'error'` renders `Saving…` / `Saved just now` (relative after 60s) / `Save failed — Retry`.
- [ ] **Step 2:** `WorkflowCanvas` already owns the debounced autosave mutation; surface its `isPending`/`isError`/`data.updatedAt` through the existing `onSaved` callback by widening it to `onSaveState?: (s: AutosaveState) => void`.
- [ ] **Step 3:** Render it in `BuilderLifecycleBar` in place of the current `saved <relative time>` chip. The manual **Save** affordance stays available (spec §11) but is not on the primary path.
- [ ] **Step 4:** Browser: edit a node, watch Saving… → Saved just now; kill the API, edit again, see Save failed — Retry, and Retry actually re-saves.
- [ ] **Step 5: Commit** — `feat(web): explicit autosave status in the builder`.

### Task D2: Review & Publish (spec §12, §13, §14, §57) — **the centrepiece**

**Files:** Create `apps/web/src/features/workflows/components/builder/ReviewPublishDialog.tsx`; Modify `BuilderLifecycleBar.tsx`.

- [ ] **Step 1:** Replace the `Publish` button + `Active` toggle (when the flag is on) with one primary **Review & Publish** button. Clicking opens `ReviewPublishDialog`, which immediately fetches `useWorkflowReadiness(id, open)`.
- [ ] **Step 2: Not-ready state** — heading "Cannot publish", the issue count, then each BLOCKER/WARNING with its plain-language message and, where `issue.fix` exists, an action: `CONNECT_SKILL` → link to `/skills`, `OPEN_NODE` → close the dialog and select that node on the canvas, `OPEN_TRIGGER` → open the trigger inspector. No separate `[Validate]` button anywhere (spec §12).
- [ ] **Step 3: Ready state** — the review card from spec §13: name, trigger summary (`describeSchedule`), AI employees, skills, approver, step count, the green check list from `readiness.checks`, and "A new version will be published". Primary action **Publish & Activate** → `usePublishAndActivate`; secondary "Publish without activating" for advanced users (spec §14) → `usePublishWorkflow`.
- [ ] **Step 4: Confirmation copy** (spec §57) — when the graph contains a node with `hasSideEffects`, the dialog states "This workflow can perform external actions" above the primary button.
- [ ] **Step 5: Result** — on success show `Published v13 · Active`, close, and leave the canvas untouched (never refetch the detail mid-edit — existing gotcha). On failure show the server message verbatim plus the parsed issue list (`splitPublishIssues`).
- [ ] **Step 6:** Keep `Pause`/`Resume` as an explicit control on the workflow overview (Task E3), not as the publish path.
- [ ] **Step 7:** Browser: publish a workflow with a missing Gmail connection → blocked with a working Connect link; connect it; publish → v1 Active in one click.
- [ ] **Step 8: Commit** — `feat(web): one Review & Publish surface replaces validate/publish/activate`.

### Task D3: Schedule inside the trigger (spec §18, §19)

**Files:** Create `apps/web/src/features/workflows/components/builder/ScheduleFields.tsx`; Modify `canvas/TriggerInspector.tsx`, `components/TriggerPanel.tsx`.

- [ ] **Step 1:** `ScheduleFields({ value, timezone, onChange })` — Frequency select (Hourly/Daily/Weekdays/Weekly/Monthly/Custom interval/Custom cron), conditional Day + Time inputs, a Timezone select defaulting to the company timezone, and a live **Next run** line from `nextRunAt`. Advanced cron stays reachable but is not the default.
- [ ] **Step 2:** Wire it into `TriggerInspector` for `triggerType === 'SCHEDULE'`, replacing the raw cron/everyMs inputs; encode via `toTriggerConfig`. Timezone is stored on the company (`Company.timezone`) and shown explicitly — the backend cron runs in server time, so **state that plainly** in helper text rather than implying per-workflow tz support that does not exist. If the company timezone differs from the server's, show the resolved absolute next-run time.
- [ ] **Step 3:** Mirror in the Steps-view `TriggerPanel` so both views agree.
- [ ] **Step 4:** Browser: set "Every Monday 09:00", confirm the stored `triggerConfig.cron === '0 9 * * 1'` and Next run reads the coming Monday.
- [ ] **Step 5: Commit** — `feat(web): friendly schedule configuration inside the trigger`.

---

## Wave E — Operations surfaces (spec §22, §25, §26, §28, §36, §53)

### Task E1: Runs surfaces

**Files:** Create `apps/web/src/features/runs/{api.ts,hooks.ts,labels.ts}`, `features/runs/components/{RunsTable.tsx,RunTimeline.tsx,RunFailureCard.tsx}`, `app/(app)/runs/page.tsx`, `app/(app)/runs/[runId]/page.tsx`, `app/(app)/workflows/[id]/runs/page.tsx`.

- [ ] **Step 1: `RunsTable`** — columns per spec §25: Workflow, Version, Trigger, Status (`runStateLabel`), Started, Duration, Approval. URL-driven filters (`?status=&workflow=`), 1s polling only while a listed run is non-terminal.
- [ ] **Step 2: `/runs`** — global operations view using `useAllRuns`.
- [ ] **Step 3: `/runs/[runId]`** — `RunTimeline`: each step in order with its state icon, node name, duration, and for APPROVAL steps "Waiting for <approver>" linking to `/approvals`. Reuse `useWorkflowRun` (already polls). Show `dryRun` prominently when set.
- [ ] **Step 4: `RunFailureCard`** (spec §28) — for FAILED/TIMED_OUT runs: failing step, reason (`run.error`), **Impact** ("the action did not complete"), recommended action derived from `failureClass` (e.g. `AUTHORIZATION_DENIED` → "Reconnect the skill" with a link), then `[Retry]` `[View workflow]`. The retry button explains what retry does — `POST /workflows/runs/:id/retry` starts a **fresh run of the same workflow**, so say exactly that ("Starts a new run from the beginning") rather than implying step-level resume, which the backend does not do.
- [ ] **Step 5: `/workflows/[id]/runs`** — the same table pre-filtered.
- [ ] **Step 6:** Browser: run a workflow, watch `/runs` update and the timeline fill in; force a failure and confirm the card is truthful.
- [ ] **Step 7: Commit** — `feat(web): first-class runs list, timeline and failure recovery`.

### Task E2: Schedules operations view (spec §22, §47)

**Files:** Create `apps/web/src/features/schedules/hooks.ts`, `features/schedules/components/ScheduleTable.tsx`, `app/(app)/schedules/page.tsx`.

- [ ] **Step 1:** `useSchedules()` derives from `useWorkflows()` filtered to `triggerType === 'SCHEDULE'`; joins the latest run per workflow from `useAllRuns({ limit: 200 })` for **Last run**; computes **Next run** with `nextRunAt`.
- [ ] **Step 2:** Columns: Workflow, Schedule (`describeSchedule`), Timezone, Next run, Last run, Status (`● Active / Ⅱ Paused`). Actions: Pause/Resume (`useDeactivateWorkflow`/`useActivateWorkflow`), Edit → `/workflows/:id`, View runs → `/workflows/:id/runs`.
- [ ] **Step 3:** Make the Pause-vs-Cancel distinction explicit in the UI (spec §23): Pause's confirmation says "In-flight runs keep going. To stop a run that is executing now, cancel it from Runs."
- [ ] **Step 4:** The route name `/schedules` collides conceptually with the existing interview `/scheduling` page — keep both, and label the nav items "Schedules" (automation) vs "Interview scheduling".
- [ ] **Step 5: Commit** — `feat(web): operational schedules view`.

### Task E3: Workflow overview + version history route (spec §16, §17, §36, §53)

**Files:** Modify `app/(app)/workflows/[id]/page.tsx`; Create `app/(app)/workflows/[id]/versions/page.tsx`.

- [ ] **Step 1:** When a workflow is ACTIVE and the user has not clicked Edit, show the **overview** (spec §36): status, trigger summary, AI employee, step count, last run, next run, success rate (from the runs list), then `[Run Now] [Pause] [Edit] [View Runs]`. `Edit` reveals the canvas (`?edit=1`), which is exactly the "system creates draft changes" step of spec §16 — no manual version creation.
- [ ] **Step 2:** DRAFT workflows open straight into the canvas (no overview gate).
- [ ] **Step 3:** `/workflows/[id]/versions` renders the existing `VersionHistoryPanel` full-page with View / Compare-by-eye / Restore as draft, and shows which version each run was pinned to.
- [ ] **Step 4:** Advanced/debug details (spec §37) — a collapsed "Technical details" block on the run detail showing `runId`, `correlationId`, `workflowVersionId`, `failureClass`, visible to OWNER/ADMIN only.
- [ ] **Step 5: Commit** — `feat(web): workflow overview, edit-on-demand, version history route`.

### Task E4: Navigation + flag

**Files:** Modify `components/app-shell/Sidebar.tsx`.

- [ ] **Step 1:** Group the automation routes under an "Automation" heading: Workflows, Runs, Schedules (spec §22). AI Assist stays directly above.
- [ ] **Step 2:** Add a Runs badge showing currently-running count (reuse `useAllRuns({ status: 'RUNNING' })`, 10s poll) — mirrors the approvals badge.
- [ ] **Step 3: Commit** — `feat(web): automation nav group`.

---

## Wave F — Verification (spec §58, §59)

### Task F1: Full verification pass

- [ ] **Step 1:** `cd platform && pnpm --filter @vaep/types build && pnpm -w run lint`
- [ ] **Step 2:** `pnpm --filter @vaep/web run typecheck && pnpm --filter @vaep/web test`
- [ ] **Step 3:** `cd apps/api && pnpm run test:unit`
- [ ] **Step 4:** `pnpm test` (durable engine) — must stay 100% green.
- [ ] **Step 5:** `WORKFLOW_ENGINE_MODE=legacy_walk pnpm test` — must stay 100% green.
- [ ] **Step 6: Browser golden path** (spec §58 P0): create with AI → editor → Review & Publish → Active → Run Now → run detail shows real step states → approval appears in `/approvals` → approve → run completes.
- [ ] **Step 7: Browser manual path**: `/workflows/new` → Start from scratch → add trigger/AI employee/action → Review & Publish → Run Now → run detail.
- [ ] **Step 8:** Kill any dev server started for verification (ports 3200/4000).
- [ ] **Step 9: Commit** — `chore: verify workflow UX simplification end to end`.

---

## Deliberately out of scope (state this to the user)

- **Realtime WebSocket/SSE run updates (spec §27).** The seq-outbox exists but the WS gateway is deferred work (doc 29 P5-01). This plan keeps the existing 1s polling and does not claim realtime.
- **Per-workflow timezone storage (spec §18).** The scheduler runs server-side cron; the UI shows the company timezone explicitly and computes the absolute next run rather than pretending each workflow carries its own tz.
- **Step-level retry (spec §28 "Retry Step").** The backend's retry starts a fresh run; the UI says so instead of offering a control that does not exist.
- **Product analytics events (spec §62).** No analytics pipeline exists in this codebase; adding one is a separate module.
