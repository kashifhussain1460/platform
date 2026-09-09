# Verification pass — six frontend fixes (read-only)

Source: direct code read, 2026-09-09. Read-only pass; nothing in `apps/web` or `apps/api` was
modified. Verifies the hypotheses in `06-frontend-api-connection.md`,
`11-config-driven-and-testing.md` §B.3, `12-duplicate-legacy-and-master-sweep.md` §3 and
`08-execution-identity-and-lifecycle.md` §B.2/C.1, and collects the exact facts an implementer must
match. Paths absolute where load-bearing.

House rules being matched (`d:/Vertical AI/platform/CLAUDE.md` §Conventions, lines 11-15):

> - **Singletons both sides.** … Frontend: one `apiClient`, one `queryClient`, one Zustand store.
> - **Optimistic writes.** Mutations use TanStack Query `onMutate`→`onError` rollback→`onSettled` invalidate.
> - **Minimal `useRef`** — only for focus, commented.
> - Frontend `features/*` mirror backend `modules/*` one-to-one.

---

## 1. Product-context cache invalidation — CONFIRMED BROKEN

### 1.1 The key factory (verbatim)

`d:/Vertical AI/platform/apps/web/src/features/product-context/hooks.ts:16-19`

```ts
export const productContextKeys = {
  all: ['product-context'] as const,
  dashboard: ['product-context', 'dashboard'] as const,
};
```

### 1.2 The hook config (verbatim)

`.../features/product-context/hooks.ts:21-36`

```ts
/**
 * The resolved product context for the current company AND the current user.
 *
 * Cached for a minute: it changes when someone hires an employee, installs a
 * skill, changes plan or is moved between departments — none of which happen
 * mid-click, and all of which invalidate through their own mutations.
 */
export function useProductContext() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<ProductContextDto, NormalizedApiError>({
    queryKey: productContextKeys.all,
    queryFn: getProductContext,
    enabled: Boolean(accessToken),
    staleTime: 60_000,
  });
}
```

The docstring's claim ("all of which invalidate through their own mutations") is **false** — see 1.4.

The dashboard sibling is `hooks.ts:96-104`, `queryKey: productContextKeys.dashboard`, `staleTime: 15_000`.

### 1.3 The global QueryClient

**File: `d:/Vertical AI/platform/apps/web/src/lib/queryClient.ts`** (the single instance — house rule
"one `queryClient`"), lines 1-15 in full:

```ts
import { QueryClient } from '@tanstack/react-query';

/** The single QueryClient instance shared by the whole app. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
```

`refetchOnWindowFocus: false` (line 9) — confirms there is **no focus-driven self-heal**. The hook's
own `staleTime: 60_000` overrides the 30 s default, so the stale window is 60 s, not 30 s (the prior
audit's Playwright run only waited 30 s, which is why it failed rather than eventually passing).

### 1.4 Every `invalidateQueries` call for `productContextKeys` in `apps/web/src`

Repo-wide grep for `invalidateQueries` (119 call sites). Hits on `productContextKeys`:

| File:line | Key |
|---|---|
| `features/handoffs/hooks.ts:50` | `productContextKeys.dashboard` |
| `features/marketing/hooks.ts:88` | `productContextKeys.dashboard` |
| `features/marketing/hooks.ts:122` | `productContextKeys.dashboard` |
| `features/marketing/hooks.ts:145` | `productContextKeys.dashboard` |

**`productContextKeys.all` (`['product-context']`): zero call sites. CONFIRMED.**

Note this is not partially mitigated by key-prefix matching either — TanStack Query invalidates by
prefix, so `productContextKeys.dashboard` (`['product-context','dashboard']`) does **not** match the
parent `['product-context']` query; the relationship only works the other way round.

### 1.5 What the server actually derives product-context from

`d:/Vertical AI/platform/apps/api/src/modules/product-context/product-context.service.ts:109-156` —
one `Promise.all` of six queries plus the authz actor:

| Source | Selected columns | Line |
|---|---|---|
| `Company` | `industry`, `size`, `businessGoals` | `:111-114` |
| `Subscription` | `plan` | `:115-118` |
| `Department` | `name` (ordered) | `:119-123` |
| `AiEmployee` | `id`, `role`, `status`; `where: { companyId, archivedAt: null }` | `:124-130` |
| `InstalledSkill` | `skillKey`, `connectionStatus`; `where: { companyId, enabled: true }` | `:131-137` |
| `WorkflowTemplate` | `id,key,name,category,requires` (first-party PUBLISHED + tenant) | `:138-142` |
| authz actor + department scopes | `actorById`, `resolveAuthorizedAreas`, `resolveVisibleEmployees` | `:150-156` |

That list is the definitive set of things whose mutation must invalidate `productContextKeys.all`.

### 1.6 Mutation-by-mutation: current state and the exact call to add

All frontend paths that write one of the six sources above. "Add" column = the exact line to insert
into the existing `onSettled`/`onSuccess` block.

| Hook | File:line | Invalidates today | Product-context input it changes | Add |
|---|---|---|---|---|
| `useCreateEmployee` | `features/employees/hooks.ts:75-129`; invalidate at `:125-127` | `employeeKeys.list` only | `AiEmployee` roster (roles/status) → `entitlements.seats`, `relevantEmployeeIds`, area unlocks | `void qc.invalidateQueries({ queryKey: productContextKeys.all });` in `onSettled` |
| `useUpdateEmployee` (status PAUSE/DISABLE/ACTIVE, and every settings save) | `features/employees/hooks.ts:137-164`; invalidate at `:159-162` | `employeeKeys.list`, `employeeKeys.detail(id)` | `AiEmployee.status` → `seats.used` (DISABLED frees a seat, per `billing.plans.ts` `checkSeatFor`) | same, in `onSettled` |
| `useDeleteEmployee` (archive) | `features/employees/hooks.ts:167-188`; invalidate at `:184-186` | `employeeKeys.list` only | sets `archivedAt` → row leaves the resolver's `archivedAt: null` filter | same, in `onSettled` |
| `useInstallEmployeeTemplate` (marketplace hire) | `features/marketplace/hooks.ts:45-99`; invalidate at `:95-97` | `employeeKeys.list` only | creates an `AiEmployee` — identical effect to `useCreateEmployee` | same, in `onSettled` |
| `useChangePlan` | `features/billing/hooks.ts:74-112`; invalidate at `:107-110` | `billingKeys.subscription`, `billingKeys.usage` | `Subscription.plan` → `entitlements.plan/seats/lockedAreas`, ASSIST area gating | same, in `onSettled` |
| `useCompleteOnboarding` | `features/onboarding/hooks.ts:108-164`; invalidate at `:156-162` | `onboardingKeys.status`, `tenantKeys.current`, `authKeys.me`, `employeeKeys.list`, `orgKeys.departments` — **five keys, not this one** | hires employees, stamps `onboardedAt`, creates `Department` rows | same, in `onSettled` |
| `useSaveOnboardingDepartments` | `features/onboarding/hooks.ts:70-79` | `orgKeys.departments` (+ `setQueryData` on status) | writes real `Department` rows | `void qc.invalidateQueries({ queryKey: productContextKeys.all });` in `onSuccess` |
| `useSaveOnboardingCompany` | `features/onboarding/hooks.ts:45-55` | nothing (only `setQueryData`) | `Company.industry`/`size` | same, in `onSuccess` |
| `useSaveOnboardingGoals` | `features/onboarding/hooks.ts:81-87` | nothing (only `setQueryData`) | `Company.businessGoals` → `GOAL_CAPABILITIES` branching | same, in `onSuccess` |
| `useUpdateCompany` | `features/tenant/hooks.ts:32-65`; invalidate at `:60-63` | `tenantKeys.current`, `authKeys.me` | `Company.industry`/`size`/`businessGoals` | same, in `onSettled` |
| `useInstallSkill` | `features/skills/hooks.ts:67-109`; invalidate at `:105-107` | `skillKeys.installed` only | `InstalledSkill` row appears → `relevantSkills`/`skillStatuses`/capability unlocks | same, in `onSettled` |
| `useUninstallSkill` | `features/skills/hooks.ts:148-171`; invalidate at `:167-169` | `skillKeys.installed` | row disappears | same |
| `useUpdateInstalledSkill` (enable/disable) | `features/skills/hooks.ts:117-145`; invalidate at `:141-143` | `skillKeys.installed` | `enabled` — the resolver filters `enabled: true` | same |
| `useConnectSkill` | `features/skills/hooks.ts:219-251`; invalidate at `:247-249` | `skillKeys.installed` | `connectionStatus` → `skillStatuses` (`CONNECTED` vs `NEEDS_CONFIGURATION`) | same |
| `useDisconnectSkill` | `features/skills/hooks.ts:254-286`; invalidate at `:282-284` | `skillKeys.installed` | `connectionStatus` | same |
| `useVerifyConnection` | `features/skills/hooks.ts:308-323`; invalidate at `:316-321` | `skillKeys.installed`, `['skill-requirements']` | its own comment says "a pass/fail CHANGES `connectionStatus` server-side" | same |
| `useCheckConnectorHealth` | `features/skills/hooks.ts:293-301`; invalidate at `:297-300` | `skillKeys.installed` | can transition `connectionStatus` DEGRADED↔CONNECTED | same |
| **OAuth return** (not a hook — a page effect) | `app/(app)/skills/page.tsx:35-43` (`void qc.invalidateQueries({ queryKey: skillKeys.installed })` at `:38`) | `skillKeys.installed` | the OAuth callback wrote `connectionStatus: CONNECTED` server-side | add the same `invalidateQueries` line beside `:38` |
| `useCreateDepartment` | `features/organization/hooks.ts:66-105`; invalidate at `:101-103` | `orgKeys.departments` | `Department` list → `DEPARTMENT_EMPLOYEE_ROLES` branching | same, in `onSettled` |
| `useUpdateDepartment` | `features/organization/hooks.ts:113-140`; invalidate at `:136-138` | `orgKeys.departments` | department **name AND `scopes`** — `DepartmentScopeEditor.tsx:72` writes `{ scopes: selected }` through this hook, and `scopes` drives `authorization.policy.ts` → `authorizedAreas`/`relevantEmployeeIds` | same, in `onSettled` |
| `useDeleteDepartment` | `features/organization/hooks.ts:161-179`; invalidate at `:170-175` | `orgKeys.departments`, `orgKeys.teams`, `userKeys.list` | removes a department + re-homes members | same, in `onSuccess` |
| `useCreateTeam` / `useUpdateTeam` / `useDeleteTeam` | `features/organization/hooks.ts:195-225`, `:232-254`, `:256-279` | `orgKeys.teams` | `Team.departmentId` feeds the authz actor's team scope | same — lower priority, teams affect the actor, not the six company-level inputs |
| `useUpdateUser` | `features/users/hooks.ts:93-115`; invalidate at `:111-113` | `userKeys.list` | `User.departmentId`/`teamId`/`role` → the *current user's* actor (only matters when editing yourself) | same, in `onSettled` |
| `useDeleteUser` | `features/users/hooks.ts:117-139` | `userKeys.list` | as above | same |

Not required: `POST /workflow-templates` (tenant template authoring) would change the sixth input,
but per `06-frontend-api-connection.md` §C it has **zero frontend callers** — nothing to add.

### 1.7 The existing house pattern for cross-feature invalidation

It exists, twice, and is exactly what the fix should copy: import the other feature's key factory and
invalidate it alongside your own.

`d:/Vertical AI/platform/apps/web/src/features/handoffs/hooks.ts:6` + `:45-53`:

```ts
import { productContextKeys } from '@/features/product-context/hooks';
…
/**
 * Resolve one handoff.
 *
 * NOT optimistic: … The dashboard's
 * Support widget counts pending handoffs, so it is invalidated too.
 */
export function useResolveHandoff() {
  const qc = useQueryClient();
  return useMutation<…>({
    mutationFn: resolveHandoff,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: handoffKeys.all });
      void qc.invalidateQueries({ queryKey: productContextKeys.dashboard });
    },
  });
}
```

Same shape in `features/marketing/hooks.ts:18` (import) and `:82-91`, `:117-125`, `:140-148`. Also
`features/onboarding/hooks.ts:14-17` imports four foreign key factories (`authKeys`, `employeeKeys`,
`orgKeys`, `tenantKeys`) — so importing `productContextKeys` into `features/employees/hooks.ts`,
`features/skills/hooks.ts` etc. is established practice, not a new convention.

**Cycle check (must be verified when implementing):** `features/product-context/hooks.ts` currently
imports only `@/lib/apiClient`, `@/stores/session.store` and `./api` — it does **not** import
`employees`, `skills`, `billing` or `organization`. So adding the reverse imports creates no cycle.

### 1.8 Live symptom, exactly located

`SeatSummary.tsx:15-30` and `EmployeeForm.tsx:27,53-56` both read `useSeatAvailability()` →
`useProductContext()`. The Playwright assertion that fails is
`d:/Vertical AI/platform/e2e/tests/06-plan-seats-journey.spec.ts:58`:

```ts
await expect(page.getByText(/2 of 2 seats/).first()).toBeVisible({ timeout: 30_000 });
```

It follows an in-page hire (`:53-55`) with no reload, so the 60 s `staleTime` outlives the 30 s
assertion timeout. The *later* check at `:84` passes only because it is preceded by `page.reload()`
(`:83`), which discards the whole in-memory cache.

---

## 2. Delete safety checks — wire the orphaned dependency endpoints

### 2.1 The employee endpoint — real, working, orphaned

`d:/Vertical AI/platform/apps/api/src/modules/employees/employees.controller.ts:79-90`:

```ts
  /**
   * What a delete would take with it — call this before offering `?hard=true`.
   * Any member who may read the employee may read this; it exposes counts, not
   * content.
   */
  @Get(':id/dependencies')
  dependencies(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<EmployeeDependenciesDto> {
    return this.employees.dependencies(companyId, id);
  }
```

Service: `employees.service.ts:247-298` — a `Promise.all` of 8 counts plus a conditional
`inFlightRuns` count (`:274-283`), returning all 10 fields at `:285-297`.

DTO, `d:/Vertical AI/platform/packages/types/src/index.ts:480-502` (verbatim):

```ts
/**
 * What `DELETE /employees/:id` would destroy, returned so the caller can decide
 * between archiving and erasing. Mirrors the workflow delete flow's 409 body.
 */
export interface EmployeeDependenciesDto {
  employeeId: string;
  name: string;
  /** Per-employee skill connections — deleting the employee deletes their stored credentials. */
  ownedConnections: number;
  conversations: number;
  memories: number;
  skillGrants: number;
  /** Historical tool-execution audit rows attributed to this employee. */
  skillExecutions: number;
  /** Approval requests raised by this employee (any status). */
  approvalRequests: number;
  /** Approval requests still awaiting a human decision — blocks a hard delete. */
  pendingApprovals: number;
  /** Workflows whose graph names this employee in a node config. */
  referencingWorkflows: number;
  /** Runs of those workflows still in flight — blocks any delete. */
  inFlightRuns: number;
}
```

Frontend: **zero callers.** `apps/web/src/features/employees/api.ts` (138 lines, read in full) has no
`dependencies` function; `deleteEmployee` is `api.ts:44-46`:

```ts
export async function deleteEmployee(id: string): Promise<void> {
  await apiClient.delete(`/employees/${id}`);
}
```

— **no `hard` parameter at all**, so **there is no hard-delete UI for employees anywhere.**
CONFIRMED. `useDeleteEmployee` (`hooks.ts:167-188`) types its variables as a bare `string`.

### 2.2 The current employee delete UI (verbatim, with line numbers)

`d:/Vertical AI/platform/apps/web/src/features/employees/components/EmployeeCard.tsx:82-110`:

```tsx
        {/*
          This now ARCHIVES: the employee leaves the roster, and its chat
          history, memories, skill grants, stored connections and audit rows are
          all kept. The label says so, because "Delete" that quietly keeps
          everything is as misleading as "Delete" that quietly destroys it —
          and the old behaviour really did destroy the employee's encrypted
          per-employee credentials without saying a word.
        */}
        <button
          type="button"
          aria-label="Remove employee"
          title="Remove from your roster. History and connections are kept."
          className="rounded-lg p-1.5 text-app-ink-3 transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            if (
              !window.confirm(
                `Remove ${employee.name} from your roster?\n\n` +
                  'It will stop working immediately. Its conversation history, ' +
                  'what it has learned and its connected accounts are all kept.',
              )
            ) {
              return;
            }
            del.mutate(employee.id);
          }}
          disabled={isTemp || del.isPending}
        >
          <Trash2 className="h-4 w-4" />
        </button>
```

Two problems in one handler: (a) a static `window.confirm` string that never fetches the real counts,
and (b) the copy **"It will stop working immediately"** is factually wrong per
`08-execution-identity-and-lifecycle.md` §C.2 (an archived employee's ACTIVE SCHEDULE/EVENT
workflows keep creating runs and keep executing its persona).

### 2.3 The workflow-side equivalent — the prior audit was ambiguous; resolved here

- **A workflow dependency endpoint does NOT exist.** Repo-wide `@Get(...dependencies)` in
  `apps/api/src/modules` returns exactly two routes: `employees.controller.ts:84` and
  `organization/departments.controller.ts:63`. `workflows.controller.ts` has no `dependencies` route
  (grep: 0 hits). **State this in the plan as a genuine absence, not an orphan.**
- What the workflow side *does* have is a 409 at delete time:
  `workflows.service.ts:376-396` counts `PENDING|RUNNING|WAITING` runs and throws
  `ConflictException` (`:392-396`) — `Cannot delete workflow "<name>": N run(s) still in flight.`
- **A workflow hard-delete UI DOES exist**, unlike the employee side.
  `WorkflowRow.tsx:329-337` adds a `Delete for good…` menu item gated on `isOwner`
  (`disabled: isTemp || !isOwner`, `reason: 'Only an owner can delete for good.'`), and
  `WorkflowListTable.tsx:212-228` is its handler — also a static `window.confirm`:

```tsx
  const onDelete = (id: string, hard: boolean) => {
    const name = nameOf(id);
    const ok = window.confirm(
      hard
        ? `Delete "${name}" for good? This erases it and its run history. This can't be undone.`
        : `Archive "${name}"? Its run history is kept, and you can't run it after.`,
    );
    if (!ok) return;
    del.mutate(
      { id, hard },
      {
        onSuccess: () => say(hard ? `Deleted ${name}.` : `Archived ${name}.`),
        onError: (e) => warn(errorMessage(e, 'delete')),
      },
    );
  };
```

The 409 is already translated to plain language in `WorkflowListTable.tsx:46-47`
(`if (kind === 'delete' && err.status === 409) return 'This is still running — you can archive it once the run finishes.'`).

### 2.4 The dialog primitives this codebase already has — reuse these

Two, both real:

**(a) `d:/Vertical AI/platform/apps/web/src/components/ui/Modal.tsx`** — the shared focus-trapped
overlay (doc 29 Phase 0 primitive). Props: `{ open, onClose, title, children, size?: 'md'|'lg'|'xl' }`.
Portals to `document.body`, traps Tab (`:43-60`), Esc + backdrop close, restores opener focus,
locks body scroll. Six existing consumers: `features/schedules/components/ScheduleTable.tsx`,
`features/skills/components/InstalledSkillList.tsx`,
`features/workflows/components/builder/{ReviewPublishDialog,RunControls,VersionHistoryPanel,VersionViewer}.tsx`.
Usage snippet (`InstalledSkillList.tsx:225-234`):

```tsx
        <Modal
          open={showWizard}
          onClose={() => setShowWizard(false)}
          title={`Connect ${def.name}`}
          size="lg"
        >
          <SkillSetupWizard installed={skill} def={def} onClose={() => setShowWizard(false)} />
        </Modal>
```

**(b) The exact precedent for this fix — `DeleteDepartmentDialog.tsx`.**
`d:/Vertical AI/platform/apps/web/src/features/organization/components/DeleteDepartmentDialog.tsx`
is a dependency-endpoint-backed delete confirmation, built for the same class of bug, and its own
header calls out the `window.confirm` it replaced (`:8-19`):

```tsx
/**
 * Removing a department, with the consequence stated first.
 *
 * `User.departmentId` is `onDelete: SetNull`. Deleting a department that limits
 * its members to, say, HR therefore turns every one of those people into an
 * unrestricted company-wide reader — instantly, silently, and with nothing in
 * the old one-line `window.confirm` to suggest it. Privilege escalation by
 * deletion is still privilege escalation.
 *
 * So the flow is: show who is affected → offer to move them somewhere → and
 * only then allow the widening, named for what it is.
 */
```

Its structure is the template to copy:
- `const { data: deps, isLoading } = useDepartmentDependencies(dept.id);` (`:29`)
- `isLoading ? <p>Checking what this affects…</p> : <>…counts…</>` (`:59-119`)
- error line from the mutation (`:121-125`)
- a footer whose **button label changes with the consequence** (`:141-147`)
- it does *not* use `Modal` — it hand-rolls `role="dialog" aria-modal="true"` +
  `fixed inset-0 z-50 … bg-black/50` (`:47-54`). **Flagging as undetermined:** the plan must pick one
  (reuse `Modal` for focus-trap/a11y, or match `DeleteDepartmentDialog`'s local markup for visual
  consistency). Reusing `Modal` is the better call — `DeleteDepartmentDialog` has no focus trap, no
  Esc handler and no scroll lock, so copying it propagates an a11y gap.

The paired query hook is `features/organization/hooks.ts:142-155`, with a comment that is directly
reusable reasoning:

```ts
/** Preview a department delete. Enabled only when an id is supplied. */
export function useDepartmentDependencies(id: string | null) {
  return useQuery<DepartmentDependenciesDto, NormalizedApiError>({
    queryKey: orgKeys.departmentDependencies(id ?? ''),
    queryFn: () => departmentDependencies(id as string),
    enabled: Boolean(id),
    // Always refetch: the whole point is to show the CURRENT membership at the
    // moment of the decision, not whatever it was earlier in the session.
    staleTime: 0,
  });
}
```

Key factory entry: `orgKeys.departmentDependencies: (id: string) => …` (`hooks.ts:37-38`).
API function: `features/organization/api.ts:41-48`. Dialog open/close state pattern:
`DepartmentSection.tsx:42` (`const [deleting, setDeleting] = useState(false)`), trigger at `:138`,
render at `:152-157`.

### 2.5 Backend authorization to match

`employees.controller.ts:36-37` — `@Controller('employees') @UseGuards(JwtAuthGuard, AuthorizationGuard)`.
- `GET :id/dependencies` (`:84`): **no `@RequirePermission`** — any authenticated member.
- `DELETE :id` (`:103-105`): `@RequirePermission('employee:manage')` (floor ADMIN) `@HttpCode(204)`.
- `?hard=true` is additionally **OWNER-only**, enforced in the controller body (`:112-118`) with a
  message the UI should surface verbatim rather than reword.

So a hard-delete affordance must be gated on `useSessionStore((s) => s.user?.role) === 'OWNER'` —
the same expression `WorkflowListTable.tsx:59-60` already uses (`const isOwner = role === 'OWNER'`).

---

## 3. Employee → workflows ownership view

### 3.1 The private backend query (verbatim)

`d:/Vertical AI/platform/apps/api/src/modules/employees/employees.service.ts:300-323`:

```ts
  /**
   * Ids of this tenant's workflows whose graph names this employee.
   *
   * Matched on the serialized definition rather than a join, because there is
   * no `WorkflowNode` table — `employeeId` lives inside the `definition` JSON
   * (`AI_EMPLOYEE_STEP`/`AI_STEP`/`TOOL_ACTION`/`RETRIEVE` node configs). A
   * substring match on a cuid is precise enough to be useful and is only ever
   * used to WARN or BLOCK, never to widen anything.
   */
  private async workflowsReferencing(
    companyId: string,
    employeeId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.workflow.findMany({
      where: {
        companyId,
        // Archived workflows can't run, so they can't be broken by this.
        archivedAt: null,
        definition: { string_contains: employeeId },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
```

Called from exactly one place: `dependencies()` at `:271`. Returns **ids only**, and filters
`archivedAt: null`.

**Semantic mismatch to decide (flagged):** this backend query matches *any* occurrence of the id in
the definition JSON (so `TOOL_ACTION`/`RETRIEVE` node configs count), whereas the frontend's
`deriveEmployees` only looks at `AI_EMPLOYEE_STEP`/`AI_STEP`. A "Workflows" tab built on the backend
query will therefore list workflows that `WorkflowRow`'s avatar stack renders as `Automated`. Pick
one rule and say which; do not leave the two disagreeing.

### 3.2 The employee detail page and its tabs

`d:/Vertical AI/platform/apps/web/src/app/(app)/employees/[id]/page.tsx` — 286 lines. Tab model at
`:28-37`:

```tsx
type TabId = 'overview' | 'chat' | 'memory' | 'tools' | 'knowledge' | 'settings';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'chat', label: 'Chat' },
  { id: 'memory', label: 'Memory' },
  { id: 'tools', label: 'Tools' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'settings', label: 'Settings' },
];
```

Tab state is plain local `useState` (`:57`), rendered as a button strip at `:161-176`, and each panel
is a bare `{activeTab === 'x' && …}` block. The six existing panels:

| Tab | Rendered at | Component / file |
|---|---|---|
| Overview | `:178-183` | `EmployeeAbout` — `features/employees/components/EmployeeAbout.tsx` |
| Chat | `:185-216` | `ChatPanel` — `features/employees/components/ChatPanel.tsx` (+ local "New conversation" button) |
| Memory | `:218` | `LearningPanel` — `features/employees/components/LearningPanel.tsx` |
| Tools | `:220-225` | `EmployeeSkillPicker` — `features/skills/components/EmployeeSkillPicker.tsx` |
| Knowledge | `:227-232` | `EmployeeKnowledgeTab` — a **local** function component in this same file, `:260-285` (composes `KnowledgeDropzone` + `DocumentList` from `features/knowledge`) |
| Settings | `:234-239` | `EmployeeSettings` — `features/employees/components/EmployeeSettings.tsx` |

Pattern to match for a new tab: add `'workflows'` to `TabId`, one entry to `TABS`, one
`{activeTab === 'workflows' && …}` block, and put the panel in
`features/employees/components/EmployeeWorkflowsTab.tsx` (a named feature component like the other
five) rather than inline — the inline `EmployeeKnowledgeTab` is the exception, not the rule, and it is
inline only because it is pure composition of another feature's parts.

### 3.3 Reusable workflow-list frontend

**`WorkflowRow`** — `features/workflows/components/builder/WorkflowRow.tsx`. Props (`:240-253`, verbatim):

```ts
export interface WorkflowRowProps {
  workflow: WorkflowDto;
  employees: DerivedEmployee[];
  needsEmployee: boolean;
  /** Owner-only actions (hard delete). */
  isOwner: boolean;
  isBusy: boolean;
  onOpen: (id: string) => void;
  onRun: (id: string) => void;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string, hard: boolean) => void;
}
```

Also exports `ROW_GRID` (`:25-26`) so a header can stay column-aligned. Reusable, but it demands six
action callbacks — for a read-only "which workflows does this employee run" tab that is a lot of
surface. A thinner read-only row is defensible; if so, say so explicitly and reuse `STATUS_META`'s
look (it is **not** exported — `WorkflowRow.tsx:37-58` is module-private, so a read-only row would
either duplicate the pill or need `StatusPill`/`STATUS_META` exported).

**`WorkflowListTable`** — `features/workflows/components/builder/WorkflowListTable.tsx`.
**Takes NO props** (`:54: export function WorkflowListTable() {`). It self-fetches via `useWorkflows()`
(`:62`) and `useEmployees()` (`:63`), owns 7 pieces of local state (`:69-76`), a `/`-to-focus-search
global key handler (`:96-110`) and all five mutations. It is a page-level component, not a
composable list. **Do not try to reuse it employee-scoped without adding props** — note this as a
decision point.

### 3.4 `deriveEmployees.ts` (the built reverse direction)

`d:/Vertical AI/platform/apps/web/src/features/workflows/deriveEmployees.ts`, 76 lines. Exports:
`DerivedEmployee` (`:10-18`), `deriveEmployees(definition, employeesById): DerivedEmployee[]`
(`:40-62`), `hasUnassignedEmployeeStep(definition): boolean` (`:69-75`). Module-private:
`EMPLOYEE_BINDING_NODE_TYPES = new Set(['AI_EMPLOYEE_STEP', 'AI_STEP'])` (`:21`), `isRealEmployeeId`
(`:24-26`, rejects `''` and un-substituted `{{param.*}}`), `readEmployeeId` (`:28-32`).
An id that no longer resolves returns `{ name: 'Removed employee', role: '', unresolved: true }` (`:57`).
Consumed at `WorkflowListTable.tsx:19` and used per-row at `:118-122`.

### 3.5 Recommended minimal change

**Backend — one route, on the employees controller (mirrors where the private query already lives):**

```
GET /employees/:id/workflows  →  WorkflowDto[]
```

- Controller: `apps/api/src/modules/employees/employees.controller.ts`, placed immediately after
  `dependencies()` (`:84-90`) so the two `:id/*` reads sit together.
- Guard: inherit the class-level `@UseGuards(JwtAuthGuard, AuthorizationGuard)` and add **no**
  `@RequirePermission` — matching `GET :id` (`:60-67`) and `GET :id/dependencies` (`:84-90`), both
  open to any member. Pass `@CurrentUser() user` and thread `user.userId` through, exactly as
  `list`/`get` already do (`:51-58`, `:60-67`), so the result is department-scoped.
- Response DTO: **reuse the existing `WorkflowDto`** (already exported from `@vaep/types`, already
  the return type of `GET /workflows`). No new DTO.
- Service: promote `workflowsReferencing` from `private` to a public method that selects the full row
  and maps through `toWorkflowDto`, **or** (cleaner, avoids an Employees→Workflows import) keep the
  id list and have the controller/service call the workflows side. Note the existing scoping
  precedent to copy: `WorkflowsService.list` (`workflows.service.ts:230-259`) filters
  `isAssistScratch: false` and then runs `this.authz.filter(actor, 'workflow:read', …)` with
  `scope: wf.category` and `ownerUserId: wf.ownerUserId`. A new endpoint that skips that filter
  re-opens the WAVE-2 leak its own comment (`:244-247`) describes. **This is the single most
  important thing for the implementer to get right.**
- Module wiring is the open question: `EmployeesModule` importing `WorkflowsModule` risks a cycle
  (Workflows already reaches Employees indirectly). Safer shape: keep the Prisma query in
  `EmployeesService` (it already has one) and import only the **pure** `toWorkflowDto` mapper plus
  `AuthorizationService` — the same "reuse only PURE functions" rule
  `workflow-templates` follows per CLAUDE.md. **Flagged: cycle-safety not fully verified this pass.**

**Frontend:**
- `features/employees/api.ts`: `export async function listEmployeeWorkflows(employeeId: string): Promise<WorkflowDto[]>`.
- `features/employees/hooks.ts`: add `workflows: (employeeId: string) => ['employees', employeeId, 'workflows'] as const` to
  `employeeKeys` (`:36-48`) and a `useEmployeeWorkflows(employeeId)` query mirroring
  `useEmployeeMemories` (`:301-308`).
- New `features/employees/components/EmployeeWorkflowsTab.tsx` + the tab wiring in §3.2.
- It also closes `08-execution-identity-and-lifecycle.md` finding #3 if the row links to
  `/runs?…` — but note **no `employeeId` filter exists on `GET /workflows/runs`** today
  (`workflows.controller.ts:114-122` filters `status`/`workflowId`/`limit` only), so the
  `[companyId, actingEmployeeId, createdAt]` index stays unused unless a second endpoint change is
  scoped in. Keep that out of this fix unless deliberately added.

---

## 4. WhatsApp connection truth (frontend half)

### 4.1 `ConnectSkillControl.tsx` — the complete branch table

`d:/Vertical AI/platform/apps/web/src/features/skills/components/ConnectSkillControl.tsx` (167 lines).
Inputs are read at `:49-51`:

```ts
  const type = def.connection?.type ?? 'none';
  const isConnected = installed.connectionStatus === 'CONNECTED';
  const isTemp = installed.id.startsWith('temp_');
```

Branch order is significant — the first match wins:

| # | Guard | Line | Renders |
|---|---|---|---|
| 1 | `type === 'none'` | `:53-55` | `<span className="text-xs text-app-ink-3">No connection required</span>` — **regardless of `executionSupport`** |
| 2 | `def.executionSupport === 'SIMULATED'` | `:74-80` | `<span className="text-xs text-sl-warning">Demo only — nothing to connect yet</span>` |
| 3 | `isConnected` | `:82-93` | a `Disconnect` button → `disconnect.mutate(installed.id)` |
| 4 | `type === 'oauth'` | `:95-113` | `def.connection?.label ?? 'Connect'` button → `startOAuth()` (real PKCE redirect, `:36-47`), with a `OAuth` caption or the inline error |
| 5 | `type === 'api_key'` and `!open` | `:116-127` | `def.connection?.label ?? 'Connect'` button → `setOpen(true)` |
| 6 | `type === 'api_key'` and `open` | `:132-166` | one `<input type="password">` (placeholder `'Bot token (xoxb-...)'` for slack, else `'API key'`) + a Save button calling `connect.mutate({ id, data: { credentials: isSlack ? { botToken: apiKey } : { apiKey } } })` |

**The full cross-product, resolved:**

| `connection.type` | `REAL` | `PARTIAL` | `SIMULATED` |
|---|---|---|---|
| `none` | "No connection required" (#1) | "No connection required" (#1) | "No connection required" (#1) — branch #2 is unreachable |
| `oauth` | real redirect (#4) | real redirect (#4) | "Demo only" (#2) |
| `api_key` | inline key field (#5→#6) | inline key field (#5→#6) | "Demo only" (#2) |

**`PARTIAL` is never distinguished from `REAL` in this component.** The only place `PARTIAL` is
surfaced is the catalog card, `SkillCatalog.tsx:132-150`:

```tsx
      {skill.executionSupport !== 'REAL' && (
        <p className={`… ${skill.executionSupport === 'SIMULATED' ? 'bg-status-warning/10 text-sl-warning' : 'bg-app-raised text-app-ink-3'}`}>
          {skill.executionSupport === 'SIMULATED'
            ? 'Demo only — actions are simulated and never reach ' + skill.name + '.'
            : 'Partly simulated: ' + skill.tools.filter((t) => t.simulated).map((t) => t.name).join(', ') + ' produce sample results, not real ones.'}
        </p>
      )}
```

Consumers of `ConnectSkillControl`: `SkillSetupWizard.tsx:170` (only when
`needsOAuth = def.connection?.type === 'oauth' && !installed.credentialsSet`, `:53`) and
`EmployeeSkillPicker.tsx:188`.

### 4.2 What WhatsApp actually is

`d:/Vertical AI/platform/apps/api/src/modules/skills/catalog.ts:852-861`:

```ts
    key: 'whatsapp',
    name: 'WhatsApp (Twilio)',
    description: 'Send and receive WhatsApp Business messages via Twilio for lead qualification and sales outreach.',
    category: 'communication',
    connection: { type: 'api_key', label: 'Connect WhatsApp (Twilio)' },
    configSchema: [
      { key: 'twilioAccountSid', … },
      { key: 'twilioAuthToken', … secret: true … },
      { key: 'whatsappSenderNumber', … },
    ],
```

`executionSupport` is derived, not authored (`catalog.ts:958-961` → `executionSupportFor`). All four
whatsapp tools are in `REAL_EXECUTION_TOOLS`
(`skills/executors/real-execution-support.ts:58-61`: `whatsapp.send_message`, `.send_template`,
`.get_conversation`, `.update_lead_status`), and `executionSupportFor` returns `'REAL'` when
`real === toolNames.length` (`:97-105`). So:

> **whatsapp = `connection.type: 'api_key'` + `executionSupport: 'REAL'` → branch #5/#6: the generic
> inline "API key" field.**

Which lands on the wrong storage. The real executor reads **`WhatsAppAccount`**, never
`InstalledSkill.credentials` — `real-skill-executor.ts:1471-1476` (`findWhatsAppAccount`) and
`:1517-1536` (`account.twilioAccountSid`, `this.crypto.decrypt(account.twilioAuthToken)`,
`account.whatsappSenderNumber`); `whatsappSendMessage` returns
`{ ok: false, error: 'No WhatsAppAccount configured for this company' }` at `:1518` when the row is
missing.

And nothing stops the meaningless write: `whatsapp` has **no provider adapter**
(`skills/providers/index.ts` registers only smtp, gmail, calendar, gdrive, slack), and
`SkillsService.connectSkill` (`skills.service.ts:311-372`) only runs `validateCredentials` when an
adapter exists (`:337-361`) — otherwise it falls straight through to
`connectionStatus: 'CONNECTED'` (`:369`) with whatever was typed. Its own comment says so
(`:334-336`): *"Skills WITHOUT an adapter keep the previous behaviour on purpose."*

Same for the wizard's verify step: `verifyConnection` with no adapter returns
`{ ok: false, steps: [{ status: 'SKIPPED', detail: 'Orlixa cannot verify this provider automatically yet.' }], adapterAvailable: false, connectionStatus: current }`
(`skills.service.ts:1262-1276`) — the status is left alone, and the wizard's `done` stage says
*"{def.name} is set up. Automatic verification isn't available for this provider yet."*
(`SkillSetupWizard.tsx:272-277`). So the badge in `InstalledSkillList.tsx:154-158` comes from the
earlier `connectSkill` write, not from any verification.

### 4.3 The dedicated page, and how it differs

- Route: `d:/Vertical AI/platform/apps/web/src/app/(app)/leads/whatsapp-connect/page.tsx` (the whole
  directory is just `page.tsx`). Its own header states the reason (`:10-17`):

```
 * Not part of the generic `/skills` catalog connect flow: `WhatsAppAccount` is
 * its own top-level table with no FK to `InstalledSkill`, so
 * `POST /skills/installed/:id/connect` (used by every other `api_key` skill)
 * has no path to populate it. This screen is the dedicated form that does.
```

- Feature: `apps/web/src/features/whatsapp/{api.ts, hooks.ts, schemas.ts, components/WhatsAppConnectForm.tsx}`.
- Hooks (`features/whatsapp/hooks.ts`): `whatsappAccountKeys = { account: ['whatsapp','account'] }`;
  `useWhatsAppAccount()` (`GET`), `useConnectWhatsAppAccount()` → `POST /engines/whatsapp/accounts`.
  `onSuccess` does `qc.setQueryData(whatsappAccountKeys.account, account)` — **no `invalidateQueries`
  and no optimistic `onMutate`/rollback**, so it is a minor deviation from the house pattern (worth a
  line in the plan, low priority).
- Form (`WhatsAppConnectForm.tsx`): three required fields —
  `twilioAccountSid` / `twilioAuthToken` (password) / `whatsappSenderNumber` — submitted together
  (`:29-36`), with a connected banner showing the live sender number and SID (`:43-56`) and a
  Connect/Reconnect button (`:112-121`).

### 4.4 Does the UI ever point a user at the dedicated page?

**No.** Repo-wide grep for `whatsapp-connect` in `apps/web/src` returns exactly one hit:
`app/(app)/leads/page.tsx:40` — a `Connect WhatsApp` button on the Leads page. Grep for `whatsapp`
(case-insensitive) across `apps/web/src/features/skills` and `apps/web/src/app/(app)/skills`:
**zero hits.** There is no special-casing, no banner, no "use the dedicated page for this skill"
anywhere in the skills UI.

**Net:** on `/skills`, WhatsApp offers a generic API-key box that writes to a column nothing reads,
sets a green `Connected` badge, and never mentions `/leads/whatsapp-connect`. The frontend fix must
replace branches #5/#6 for this skill with a link to the dedicated page. The cleanest data-driven
shape (not currently present anywhere) is a per-skill "connection lives elsewhere" marker on the
catalog DTO rather than a `def.key === 'whatsapp'` special-case in the component — note that
`ConnectSkillControl.tsx:132` already contains one hardcoded `def.key === 'slack'` special-case, so
either precedent is arguable. **Flagged as a design decision for the plan.**

---

## 5. Stale/dead UI — each item verified

### 5.1 `/marketplace` "Workflow Templates" — CONFIRMED EMPTY

`d:/Vertical AI/platform/apps/web/src/app/(app)/marketplace/page.tsx` is 54 lines total. Lines 41-45
verbatim:

```tsx
        <section>
          <h2 className="mb-3 text-sm font-medium text-app-ink-2">
            Workflow Templates
          </h2>
        </section>
```

A `<section>` with a heading and **no children at all**. The page imports only
`EmployeeTemplateList` (`:7`) and `SkillCatalog` (`:9`) — there is no template component imported,
so this is not a conditional-render or empty-state case.

The live surface is `d:/Vertical AI/platform/apps/web/src/app/(app)/workflows/templates/page.tsx`,
which imports `TemplateGallery` at `:8` and renders it at `:47`. CONFIRMED.

Backend note for the plan: the marketplace's own template list was deliberately retired —
`marketplace.catalog.ts:184-193` exposes only `employees()` / `getEmployee()`, no workflow accessor.
So deleting the empty section (optionally replacing it with a link to `/workflows/templates`) is
consistent with the backend, not a regression.

### 5.2 `FaceMesh.tsx` — CONFIRMED ZERO REFERENCES

`d:/Vertical AI/platform/apps/web/src/components/marketing-dark/FaceMesh.tsx`. Repo-wide grep for
`FaceMesh|face-mesh` across `apps/web` and `e2e` (`.ts`/`.tsx`/`.json`/`.md`) returns only two hits,
both **inside the file itself**:

- `:9` — `* Recipe from the vaep-face-mesh-design workflow (Approach A backbone +` (its own docstring)
- `:261` — `export function FaceMesh({ className, animate = true }: …)` (its own declaration)

No static import, no `next/dynamic`, no barrel file (there is no `components/marketing-dark/index.ts`
re-exporting it), no string-based reference, no test. **Safe to delete.** Unlike `DemoPlayer` there is
no comment anywhere explaining why it is kept.

### 5.3 `DisabledControl.tsx` — CONFIRMED ZERO CALL SITES, and there IS ad-hoc UI that should have used it

`d:/Vertical AI/platform/apps/web/src/features/workflows/components/builder/DisabledControl.tsx`
(45 lines). Grep for `DisabledControl` across `apps/web`, `e2e` and `docs`: four hits, **all inside
the file** (`:4` docstring, `:13` interface, `:22` + `:27` the function). Zero importers.

Its own docstring states the doctrine it was built for (`:3-12`):

```
/**
 * DisabledControl — wraps a control so a disabled state ALWAYS explains itself
 * (doc 29 §2 / §3.G): a disabled button is never a dead end with no reason. …
 */
```

**Ad-hoc disabled-state UI in the builder that implements the same doctrine by hand** (this is the
delete-vs-adopt evidence):

| File:line | What it does instead |
|---|---|
| `features/workflows/components/builder/BuilderLifecycleBar.tsx:150` | `title={!isActive && !canActivate ? 'Add at least one step first.' : undefined}` |
| `features/workflows/components/builder/RunControls.tsx:69` | `title={!canRun ? 'Add at least one step first.' : undefined}` |
| `features/workflows/components/builder/TemplateInstallForm.tsx:116` | `title={missingRequired.length ? 'Fill in the required fields first' : undefined}` |
| `features/workflows/components/builder/WorkflowRow.tsx:139-147` + `:211` | its own `MenuItem { disabled?, reason? }` type, rendered as `title={item.disabled ? item.reason : undefined}` + `aria-disabled` — six reasons authored at `:289,299,308,317,326,335` |
| `features/workflows/components/builder/canvas/WorkflowNodeCard.tsx:116-118` + `:177` | a parallel `MenuItem.disabledReason?: string` mechanism, `title={item.disabledReason}`; more at `:299`, `:308` |

So there are **three** independent hand-rolled implementations of the same idea (`title=` inline,
`MenuItem.reason`, `MenuItem.disabledReason`) plus the unused component. Delete-vs-adopt is a real
choice; note that `DisabledControl` wraps a *control* and none of the five above wrap one — four are
menu **items** rendered inside a `role="menu"`, where wrapping each in an extra `<span>` would break
the menu's child structure. **Recommendation: delete it, or narrow adoption to the three genuine
button cases (`BuilderLifecycleBar:150`, `RunControls:69`, `TemplateInstallForm:116`) and leave the
menu mechanisms alone.**

### 5.4 `DemoPlayer.tsx` + `scenes.tsx` — CONFIRMED intentionally kept, quote located

Grep for `DemoPlayer|from './scenes'` in `apps/web`: two hits, both internal —
`components/marketing-dark/demo/DemoPlayer.tsx:16` (`} from './scenes';`) and `:40`
(`export function DemoPlayer() {`). No external importer.

The "intentionally kept" comment is **not** in either file — it is in the page docstring at
`d:/Vertical AI/platform/apps/web/src/app/demo/page.tsx:11-15`:

```tsx
/**
 * The recorded product-explainer video (`/how-it-works.mp4`) — the final
 * output of the self-playing animation in `components/marketing-dark/demo/`
 * (kept there, unused now, in case the video is ever re-recorded).
 */
```

**Keep both files.** Suggest the plan add a one-line header comment inside `DemoPlayer.tsx` pointing
back at `app/demo/page.tsx:11-15`, so the next dead-component sweep does not have to re-derive this.

---

## 6. Marketing claim honesty (frontend content)

### 6.1 `features/marketing/ai-employees.ts` — its own rule, and the violation

`d:/Vertical AI/platform/apps/web/src/features/marketing/ai-employees.ts` (280 lines). The
file-level rule (`:1-9`, verbatim):

```ts
/**
 * Public marketing content for the AI Employee roles Orlixa actually ships.
 *
 * Source of truth: `apps/api/src/modules/marketplace/marketplace.catalog.ts`
 * (`EMPLOYEE_TEMPLATES`) — the same 10 keys, names, roles and personas. That
 * catalog lives in the API package and isn't reachable from `apps/web`'s
 * build, so this file restates it as marketing copy rather than importing it.
 * If a role is added, renamed or retired there, mirror the change here.
 */
```

And the field-level rule (`:23-24`, verbatim):

```ts
  /** Only set when a real, shipped workflow template demonstrates this role. */
  exampleWorkflow?: { name: string; steps: string[] };
```

**Full content of `AI_EMPLOYEES` (10 entries, `:28-266`):**

| # | slug | name | title | `role` | category | `exampleWorkflow` | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `recruit-ai` | RecruitAI | AI Recruiter | `RECRUITER` | Recruiting | **`'Resume → score → schedule'`** (`:45-53`) | 🔴 **VIOLATION** — maps to the retired `recruiting-resume-score-schedule` |
| 2 | `sales-ai` | SalesAI | AI Sales | `SALES` | Sales | **`'Sales outreach'`** (`:75-83`) | 🔴 **VIOLATION** — maps to the retired `sales-outreach` |
| 3 | `support-ai` | SupportAI | AI Support | `SUPPORT` | Customer Support | **`'Support triage'`** (`:105-113`) | 🔴 **VIOLATION** — maps to the retired `support-triage` |
| 4 | `hr-ai` | HRAI | AI HR | `HR` | Human Resources | none | OK (11 real HR templates exist, so this one *under*-claims) |
| 5 | `finance-ai` | FinanceAI | AI Accountant | `ACCOUNTANT` | Finance | none | OK |
| 6 | `pm-ai` | PMAI | AI Project Manager | `PROJECT_MANAGER` | Project Management | none | OK |
| 7 | `marketing-ai` | MarketingAI | AI Marketing | `MARKETING` | Marketing | none | OK (11 real Marketing templates exist — under-claims) |
| 8 | `procurement-ai` | ProcurementAI | AI Procurement | `CUSTOM` | Procurement | none | OK |
| 9 | `operations-ai` | OperationsAI | AI Operations | `CUSTOM` | Operations | none | OK |
| 10 | `legal-ai` | LegalAI | AI Legal | `CUSTOM` | Legal | none | OK |

The three `exampleWorkflow` blocks in full (these are the strings to remove or rewrite):

```ts
// :45-53  RecruitAI
    exampleWorkflow: {
      name: 'Resume → score → schedule',
      steps: [
        'A new resume comes in',
        'RecruitAI retrieves the role’s hiring criteria from your Knowledge base',
        'It scores the candidate against that criteria',
        'Qualified candidates are routed to interview scheduling; others get a decline',
      ],
    },

// :75-83  SalesAI
    exampleWorkflow: {
      name: 'Sales outreach',
      steps: [
        'A new lead comes in',
        'SalesAI gathers relevant product context from your Knowledge base',
        'It drafts a short, personalized outreach message',
        'The message is posted to your team’s Slack channel and logged',
      ],
    },

// :105-113  SupportAI
    exampleWorkflow: {
      name: 'Support triage',
      steps: [
        'A new support ticket comes in',
        'SupportAI searches your knowledge base for relevant context',
        'It drafts a grounded reply — or says the context is insufficient and suggests escalation',
        'The draft is logged for review',
      ],
    },
```

Per-role `suggestedSkillKeys` and `outcomes` (also claims, also needing a reality check):

| slug | `suggestedSkillKeys` | Executor reality (`REAL_EXECUTION_TOOLS`) |
|---|---|---|
| recruit-ai | `email, calendar, slack, scheduling` | all four have real tools |
| sales-ai | **`hubspot`**, email, slack | 🔴 `hubspot` = `SIMULATED` (no real executor) |
| support-ai | email, slack, **`jira`**, chatwoot | 🔴 `jira` = `SIMULATED` |
| hr-ai | email, calendar, gdrive | real |
| finance-ai | **`stripe`**, email, gdrive | 🔴 `stripe` = `SIMULATED` |
| pm-ai | **`jira`**, slack, calendar, plane | 🔴 `jira` = `SIMULATED` (`plane` is real) |
| marketing-ai | email, slack, gdrive, postiz | real |
| procurement-ai | email, gdrive, slack | real |
| operations-ai | slack, **`jira`**, gdrive | 🔴 `jira` = `SIMULATED` |
| legal-ai | gdrive, email | real |

`outcomes` strings worth re-reading against runtime before shipping (both are process claims, not
integration claims, but two are strong):
- FinanceAI `:158` — "Every payment action still requires a human sign-off before it executes"
  (true via the `highRisk` approval gate, **but** `stripe` has no real executor, so nothing executes
  at all — the claim is technically true and practically misleading).
- ProcurementAI `:221` — "Every purchase still routes through human approval" (same shape).
- SupportAI `:115` — "Common questions get answered around the clock" (depends on an ACTIVE
  EVENT/SCHEDULE trigger existing; no shipped SUPPORT template does this today).
- OperationsAI `:241` — "Recurring checks happen on schedule without manual reminders" — 🔴 in the
  current deployment shape **no cron runs at all** (`12-duplicate-legacy-and-master-sweep.md` §2.3:
  `apps/api/vercel.json` has no `crons` key).

### 6.2 The retirement record (backend), verbatim

`d:/Vertical AI/platform/apps/api/src/modules/marketplace/marketplace.catalog.ts:165-182`:

```ts
/**
 * Phase 4 §4 — the three workflow templates this catalog used to install.
 *
 * Kept as a NAME LIST, not as graphs, so the removal is auditable rather than
 * a silent deletion. Each used `AI_STEP` and `NOTIFY`, which doc 27 §0.4 bans
 * and the DB catalog's boot-time `validateManifest` rejects, so porting them
 * means rewriting the graphs into `AI_EMPLOYEE_STEP` + `TOOL_ACTION` — real
 * work with real approval-gate implications, deliberately not rushed into a
 * consolidation change.
 *
 * The DB catalog currently covers HR (11) and Marketing (11). These three were
 * the only SALES and SUPPORT coverage, so that gap is now open and named.
 */
export const MARKETPLACE_RETIRED_WORKFLOWS: readonly string[] = [
  'recruiting-resume-score-schedule',
  'sales-outreach',
  'support-triage',
] as const;
```

Note the doc-comment is itself now slightly stale: it says "HR (11) and Marketing (11)", but a
**Sales** catalog has since landed (2 templates) — see §6.4.

### 6.3 `EMPLOYEE_TEMPLATES` drift (a second, smaller honesty gap in the same file pair)

`ai-employees.ts` claims to mirror `EMPLOYEE_TEMPLATES` exactly ("the same 10 keys, names, roles and
personas"). Spot-checked: keys, names and roles match, **but `suggestedSkillKeys` do not mirror
`suggestedSkills`.** Examples:
- recruit-ai: catalog `['email','calendar','slack']` (`marketplace.catalog.ts:29`) vs marketing
  `['email','calendar','slack','scheduling']` (`ai-employees.ts:44`) — `scheduling` added.
- support-ai: catalog `['email','slack','jira']` (`:55`) vs marketing
  `['email','slack','jira','chatwoot']` (`:104`) — `chatwoot` added.
- pm-ai: catalog `['jira','slack','calendar']` (`:94`) vs marketing `[…,'plane']` (`:176`).
- marketing-ai: catalog `['email','slack','gdrive']` (`:118`) vs marketing `[…,'postiz']` (`:197`).

These four additions are all **real** skills, so the drift is in the honest direction — but it breaks
the stated mirror rule, so the plan should either update the API catalog or soften the docstring.
`marketing-ai`'s `role` was already migrated `CUSTOM → MARKETING` in the API catalog with a long
explanatory comment (`marketplace.catalog.ts:103-111`) and `ai-employees.ts:186` matches it.

### 6.4 The real, currently-shipped first-party workflow templates — all 24

Seeded on boot from `apps/api/src/modules/workflow-templates/workflow-templates.catalog.ts`, which
aggregates three files. **Every one requires `minPlan: 'BUSINESS'`.**

**HR — `hr-workflow-templates.catalog.ts` (11), all `category: 'HR'`, `employeeRoles: ['HR']`:**

| Key | Name | Required skills |
|---|---|---|
| `hr.recruitment-intake` | HR: recruitment intake → acknowledge applicant | gmail, gdrive |
| `hr.candidate-screening` | HR: candidate screening → recruiter approval → notify | gmail, gdrive |
| `hr.interview-scheduling` | HR: interview scheduling → book → invite | calendar, gmail |
| `hr.onboarding` | HR: onboarding checklist → approval → welcome doc + notify | gdrive, slack |
| `hr.document-verification` | HR: document verification → HR confirms → record | gdrive |
| `hr.leave-request` | HR: leave request → approval → notify | slack |
| `hr.attendance-monitor` | HR: attendance anomaly monitor | slack |
| `hr.performance-review` | HR: performance review draft → approval | gdrive, gmail |
| `hr.record-update` | HR: staff record change → approval | gdrive |
| `hr.compliance-audit` | HR: periodic compliance audit | gdrive, slack |
| `hr.offboarding` | HR: employee offboarding | slack, gdrive |

**Marketing — `marketing-workflow-templates.catalog.ts` (11), all `category: 'MARKETING'`, `employeeRoles: ['MARKETING']`:**

| Key | Name | Required skills |
|---|---|---|
| `mkt.campaign-plan` | Marketing: campaign plan → approval → save | gdrive |
| `mkt.content-generate` | Marketing: generate content drafts | gdrive |
| `mkt.content-approval` | Marketing: content draft → approval → schedule | postiz |
| `mkt.social-schedule` | Marketing: schedule an approved post | postiz |
| `mkt.social-publish` | Marketing: publish (double-post safe) | postiz |
| `mkt.email-campaign` | Marketing: email campaign → approval → send | gmail |
| `mkt.seo-content` | Marketing: SEO content draft | http, gdrive |
| `mkt.lead-capture` | Marketing: inbound lead capture | **hubspot** (SIMULATED), gmail |
| `mkt.campaign-monitor` | Marketing: campaign monitor | postiz, slack |
| `mkt.analytics-report` | Marketing: analytics report | postiz, gdrive, slack |
| `mkt.brand-audit` | Marketing: brand compliance audit | postiz, slack |

**Sales — `sales-workflow-templates.catalog.ts` (2), `category: 'SALES'`, `employeeRoles: ['SALES']`:**

| Key | Name | Required skills |
|---|---|---|
| `sales.whatsapp-lead-qualify` | Sales: WhatsApp lead qualification | whatsapp, slack |
| `realestate.whatsapp-lead-qualify` | Real Estate: WhatsApp lead qualification | whatsapp, calendar, leads, slack |

**Total = 24.** Note this contradicts CLAUDE.md's "22 first-party templates" (line 85) — the Sales
pair landed after that entry was written. Two honesty consequences for the marketing copy:

1. **RECRUITER has zero templates.** RecruitAI's `exampleWorkflow` (a recruiting graph) has no
   backing template at all; the closest real thing is the HR trio
   (`hr.recruitment-intake`/`hr.candidate-screening`/`hr.interview-scheduling`), which requires an
   **HR**-role employee, not a `RECRUITER`. Rewriting RecruitAI's example to point at those would
   still be wrong unless the copy also says "hire an HR AI Employee".
2. **SALES now has two real templates** — both WhatsApp-only. So SalesAI's `exampleWorkflow`
   ("drafts outreach → posts to Slack") could be replaced with a truthful WhatsApp lead-qualification
   example, but only if the copy also states the Twilio WhatsApp prerequisite.
3. **SUPPORT still has zero templates.** SupportAI's `exampleWorkflow` has no replacement; it must be
   removed, not rewritten.
4. Every template is `minPlan: 'BUSINESS'` — any marketing claim that a Free/Starter customer gets
   workflow automation is false.

### 6.5 Claim inventory across the other marketing surfaces

Scope swept: `app/page.tsx`, `app/layout.tsx`, `lib/jsonld.tsx`, all public routes (`about`,
`ai-employees` + `[slug]`, `automation`, `careers` + `[slug]`, `contact-sales`, `demo`,
`integrations` + `[slug]`, `pricing`, `security`, `privacy-policy`, `terms-of-service`), all 26 files
in `components/marketing-dark/**` (incl. `demo/`), and the `features/marketing/*` data files
(`integrations.ts`, `plans.ts`, `automation-categories.ts`, `careers.ts`).

`app/page.tsx` has **no copy of its own** — it composes 13 components (`:18-30`: `DarkNav`,
`DarkHero`, `MarketGapSection`, `WhatIsVaep`, `WorkflowBuilderSection`, `HowItWorks`,
`IntegrationsSection`, `AiEmployeesGrid`, `Testimonials`, `SecuritySection`, `PricingSection`,
`FinalCta`, `SiteFooter`). Every homepage claim lives in `components/marketing-dark/`.

#### 6.5.1 Numeric claims that are false against the shipped catalogs — the P0 group

| Claim | File:line | Reality |
|---|---|---|
| `['500+', 'Integrations']` | `components/marketing-dark/DarkHero.tsx:23` (stats bar, rendered `:142-148`) | **14** entries in `features/marketing/integrations.ts`; the skills catalog has ~20 keys, 4 of them `SIMULATED` |
| `kicker="Powered by 500+ integrations"` | `components/marketing-dark/IntegrationsSection.tsx:24` and `:29` | same |
| `'40+ more'` (skills chip) | `components/marketing-dark/demo/scenes.tsx:165` | same. Also baked into the shipped `/how-it-works.mp4` — a copy edit will not fix the video |
| `['12+', 'AI Employee Roles']` | `DarkHero.tsx:22` | **10** in `ai-employees.ts` and `EMPLOYEE_TEMPLATES` |
| `['98.6%', 'Task Success Rate']` | `DarkHero.tsx:24` | no such metric is computed anywhere; directly contradicted by `terms-of-service/page.tsx:133-137` ("We do not warrant that AI-generated output will be accurate, complete, or fit for a particular purpose") |
| `['300+', 'Hours Saved Per Month']` | `DarkHero.tsx:25` | not computed |
| the same four stats repeated | `DashboardMock.tsx:99-113`, `HeroDemo.tsx:141-146`, `demo/scenes.tsx:317-320` (`1,248` tasks, `98.6%`, `312`/`300+` hours, `2.4h` avg approval SLA) | four independent copies of unbacked figures |

#### 6.5.2 Named integrations that are not shipped skills

`components/marketing-dark/IntegrationsSection.tsx:13-22` renders a logo row with **no status labels
of any kind**:

```tsx
  { label: 'Slack' }, { label: 'Gmail' }, { label: 'Google Drive' }, { label: 'HubSpot' },
  { label: 'Salesforce' },   // not a shipped skill
  { label: 'Notion' },       // not a shipped skill
  { label: 'WhatsApp' },     // a skill exists, but see §4 — connection is broken on /skills
  { label: 'More', muted: true },
```

`features/marketing/integrations.ts:11-12` **already admits this in a comment**:

> `Deliberately NOT included: the homepage's IntegrationsSection logo row (Salesforce, Notion, WhatsApp) — those are not implemented skills.`

So the data file is honest and the homepage component bypasses it. Notion appears twice more as a
working capability:
- `components/marketing-dark/WorkflowDiagram.tsx:70` — `title="Log Activity" label="Notion"`, an
  **action node** in the example workflow rendered on both the homepage and `/automation`.
- `HeroDemo.tsx:49-53` and `demo/scenes.tsx:152-156` — Notion shown among connected skill logos.

#### 6.5.3 The SOC 2 self-contradiction

`components/marketing-dark/SecuritySection.tsx:4` (homepage, rendered as a check-marked list at
`:83-87`):

```ts
const GUARANTEES = ['SOC 2 Compliant', 'GDPR Ready', 'Role-based Access', 'Audit Logs', 'Data Encryption'];
```

`app/security/page.tsx` says the opposite, twice:
- `:62-63` FAQ — `'Is Orlixa SOC 2 or ISO 27001 certified?'` / `'Not yet. Formal third-party compliance certification is on our roadmap…'`
- `:141-145` status list — `'SOC 2 / ISO 27001 — certification, not yet held'`, preceded by `:132-135`
  which explicitly draws the capability-vs-certification distinction and states
  *"We don't claim a certification we don't hold."*

The `/security` FAQ is **also emitted as schema.org `FAQPage`** (`security/page.tsx:79-89`), so
Google is being told "not yet certified" while the homepage shows a check mark. This is the single
highest-risk claim on the site.

#### 6.5.4 Capability claims by file (verbatim)

**`DarkHero.tsx`** — `:19` `const LOGOS = ['Microsoft', 'Google', 'airbnb', 'HubSpot', 'stripe', 'Notion'];`
rendered `:127` under `:124` `'Trusted by forward-thinking companies'` (unverifiable social proof).
`:84-85` `'Hire AI employees that think, act and deliver results. Manage them, train them and let them handle the work — while you focus on growth.'`

**`AiEmployeesGrid.tsx:5-11`** — the strongest role copy on the site, and stronger than
`/ai-employees`' own hedged copy:
- `:5` `'AI Recruiter'` / `'Screen candidates 24/7 and shortlist the best.'` — **24/7**
- `:6` `'AI Sales'` / `'Find leads, engage and close deals on autopilot.'` — **autopilot, closes deals**
- `:7` `'AI Support'` / `'Resolve customer issues instantly and intelligently.'` — **instantly**
- `:8` `'AI Accountant'` / `'Automate bookkeeping, invoices and reports.'` — stripe has **no real executor**
- `:9` `'AI HR'`, `:10` `'AI Project Manager'`, `:11` `'AI Marketing'`
- `:20` `'Hire AI employees for '` + `'every business function'`

Same "every function" claim at `WhatIsVaep.tsx:23-24` (*"…AI employees for every function in your
business"*) and `ai-employees/page.tsx:76`.

**`Testimonials.tsx:17-38`** — three attributed testimonials at companies that do not appear anywhere
else, each with a hardcoded 5-star rating (`:57-59`):
- `'Orlixa has transformed the way we hire. Our AI Recruiter screens candidates better than our manual process.'` — James Carter, Head of Talent, TechNova
- `'We automated 80% of our support tickets. Response time dropped and customer satisfaction went up.'` — Sarah Williams, Customer Success, Cloudly — **a quantified 80% claim**
- `'Finally, a platform that brings all our tools, data and AI employees into one place. Game changer.'` — David Lee, COO, ScaleUp Inc.
- `:49` kicker `'Trusted by businesses'`, `:50` `'Loved by teams around the world'`

Memory (`marketing-video-scripts.md`) records that **no real Kashif metrics or testimonial exist**, so
these are fabricated. `FinalCta.tsx:95` — `'Join thousands of companies already automating work with AI employees.'` and
`careers/page.tsx:32-33` — `'…AI Employees, Skills and Workflows that real businesses put to work every day.'`
are the same class.

**`app/automation/page.tsx`** — the most testable claim on the site, `:117-120`:

> `'HR and Marketing Automation are live today, each with 11 ready-to-use workflow templates. Every other team is on our roadmap.'`

Both halves are **true today** (§6.4: 11 HR + 11 Marketing) — but the "every other team is on our
roadmap" half is now **stale**, because 2 SALES templates shipped. Matching statuses in
`features/marketing/automation-categories.ts` (the only place on the site with real availability
labels, rendered `Available now` at `automation/page.tsx:130` / `Coming soon` at `:147`):
- `:23-26` HR — `available: true` — `'Onboarding tasks, leave requests, performance reviews and more — 11 ready-to-use templates.'`
- `:29-32` Marketing — `available: true` — `'Campaign drafts, content calendars, social scheduling and more — 11 ready-to-use templates.'`
- `:34-41` **Recruiting / Sales / Support / Finance / Project Management / Procurement / Operations / Legal** — all `Coming soon`, each `'Workflow templates for <x> are on our roadmap.'`

🔴 **`:35` Sales is labelled `Coming soon` but 2 Sales templates are shipped and seeded.** This is the
mirror image of the `ai-employees.ts` problem: the same product fact is over-claimed in one file and
under-claimed in another.

Trigger claims at `automation/page.tsx:23-24`: `'Start a workflow manually, on a schedule, on a webhook, or when an event fires — like a new email or a form submission.'`
All four trigger types are real (`MANUAL/SCHEDULE/WEBHOOK/EVENT`) — **but per
`12-duplicate-legacy-and-master-sweep.md` §2.3 no cron runs in the current deployment shape**, so
"on a schedule" is a deployment-gap claim, not a code-gap claim. Same for `:47-49`
`'Every run is logged step by step…'` (true) and `:42-44` `'Gate any step behind a human decision — approve, reject, or modify…'` (true).

**`app/integrations/page.tsx:33-35`** — the strongest "it all works" claim, and it is the one place
the shipped list is genuinely accurate:

> `'Each integration below is a real, working Skill your AI Employees can be equipped with — not a roadmap item. Every action it takes is logged, and anything high-risk is routed to a human for approval first.'`

Cross-check against `real-execution-support.ts`: of the 14 entries in `integrations.ts`, **Stripe
(`:54-62`), GitHub (`:66-70`), HubSpot (`:82-86`) and Jira (`:90-99`) have NO real executor** — they
are the four documented `SIMULATED` skills. So "not a roadmap item" is false for 4 of 14, and the
capability bullets on their detail pages describe things that never happen:
- Stripe `:56` `'Create a shareable Stripe payment link (routed through human approval before it executes)'` — the approval gate is real; the payment link is fabricated by the mock executor
- Jira `:92-97` four bullets (create/list/get/transition)
- HubSpot `:84-85` (create contact, update deal)
- GitHub `:68` (create an issue)

`integrations.ts` has **no status field at all** — 🔴 the `SkillDefinitionDto.executionSupport` value
the in-app `/skills` page uses to print *"Demo only — actions are simulated and never reach …"*
(`SkillCatalog.tsx:140-141`) has no equivalent in the public data file. **This is the single
highest-value structural fix in §6**: add an `executionSupport`-equivalent field to
`integrations.ts` and render it, so the public page cannot contradict the in-app page.

Also note the honest half: `integrations.ts:125-133` (Interview Scheduling) and `:137-168`
(Postiz/Chatwoot/Plane) are correctly described as built-in/self-hosted, and `integrations/[slug]/page.tsx:102-105`
repeats the audit-log + approval claim, both true.

**`app/pricing/page.tsx` + `features/marketing/plans.ts`** — `plans.ts:10-13` carries its own warning
comment:

> `⚠️ This is the SALES list. The product's own PLAN_CATALOG … is a different list, and the per-month run and storage quotas below are not metered anywhere yet.`

Two live problems:
1. **Every seat and quota number disagrees with the shipped plan rules.** `plans.ts` sells
   `'Up to 2 AI Employees'` (Free, `:41`), `'Up to 10 AI Employees'` (Starter, `:60`),
   `'Up to 50 AI Employees'` (Business, `:79`), `'Unlimited AI Employees'` (Enterprise, `:99`) —
   while the founder-approved role-based plans (CLAUDE.md line 109) are **2×1 / 2×1 / 2×2 / ∞**, i.e.
   maxEmployees 2 / 2 / **4** / ∞. Business is oversold by 46 seats. Prices also differ
   (`plans.ts` `$36`/`$29`, `$124`/`$99` vs the approved `$20` / `$40`).
2. **Quotas sold but not metered** (the file admits it): `'1,000 / 10,000 / 50,000 workflow runs / month'`,
   `'Knowledge Base (5GB / 50GB / 250GB / Unlimited)'`.
3. `pricing/page.tsx:40-42` — `'All plans include the core platform, workflow automation, and access to our AI Employee marketplace.'`
   🔴 **False**: every one of the 24 templates is `minPlan: 'BUSINESS'` (§6.4), and `AREA_MIN_PLAN.ASSIST = 'BUSINESS'`.
   `plans.ts:71` also lists `'Workflow templates'` as a **Starter** feature, which the server refuses.
4. `plans.ts:104` `'SLA &amp; uptime guarantee'` and `contact-sales/page.tsx:21`
   `'A dedicated account manager and an uptime guarantee.'` — no SLA exists.
   `plans.ts:105` `'On-premise / VPC options'` / `contact-sales/page.tsx:19` `'Private or VPC deployment options'` — not shipped.
   `plans.ts:91` `'Role-based access control'` (Business-only) — RBAC is actually enforced for **all** plans.
   `plans.ts:88` `'Custom integrations (webhooks)'` and `:90` `'Advanced analytics'` — webhook triggers exist for all plans; "advanced analytics" has no plan gate.
5. **`PricingFaq.tsx` is emitted as schema.org `FAQPage`** (`pricing/page.tsx:22`), so three
   process claims are indexed:
   - `:11-12` — *"Moving up takes effect immediately and we charge the difference for the rest of the period"* 🔴 **proration is a documented TODO** (`billing/providers/stripe-billing.provider.ts:25`, per `12-…-master-sweep.md` §6)
   - `:15-16` — *"Your AI Employees stop taking new work until you pick a plan"* 🔴 no trial-end enforcement exists; downgrade is **grandfather** (CLAUDE.md line 109: "nothing is paused")
   - `:19-20` — *"Yes, within 14 days of a payment, for any reason"* — a business policy, not verifiable in code

**`app/security/page.tsx:30-56`** — six capability claims, spot-checked as **all true**: tenant
isolation, RBAC ("enforced on every request — not just hidden in the UI"), automatic high-risk
approval routing, AES-GCM encryption at rest, full audit trail, rate limiting + circuit breakers.
This page is the model the rest of the site should be rewritten toward. `:100-101` even says so:
*"Here's exactly what Orlixa does today — and what we're honest about not having yet."*

**`app/layout.tsx:40-41`** (site-wide `<meta description>`, also `lib/jsonld.tsx:22-23` as
`organizationSchema`, emitted on every page): `'Orlixa is the AI Workforce Platform — hire managed AI Employees, equip them with Skills, brief them with your Knowledge, chain them into Workflows, and gate every risky move behind human Approvals.'`
— accurate. Note `lib/jsonld.tsx:44-45`'s `softwareApplicationSchema` (with `price: '0'`, `:40-42`)
is **defined but never imported**, so it does not ship — leave it or delete it, but do not treat it
as live.

**`app/about/page.tsx`** — `:66-69`, `:77-80`, `:26-27`, `:50-53` all describe the
Employees/Skills/Knowledge/Workflows/Approvals model accurately. `:31-32` claims coverage of
*"recruiting, sales, support, HR, finance and more"* — templates exist for HR/Marketing/Sales only.

**`app/ai-employees/page.tsx`** — `:42-43` `'…Each one comes with skills, workflows and human approval built in.'`
🔴 **false for 7 of 10 roles** (only HR, MARKETING and SALES have templates). `:60-61`
`'High-risk actions … are automatically routed to the Approval Center before they execute.'` — true.
`:79-82` claims each employee has *"a memory"* — true (`EmployeeMemory`).
`ai-employees/[slug]/page.tsx:118` — `'{employee.name} typically connects to these tools once installed on your workspace.'`
inherits the `suggestedSkillKeys` problem from §6.1 (hubspot/jira/stripe).

**`app/terms-of-service/page.tsx:60-63`** — `'You control what tools an AI Employee can access and what actions require your approval before they execute.'`
True (`permissions`/`approvalRules` are enforced). `:133-137`'s no-warranty disclaimer is the direct
legal counterweight to the `98.6%` hero stat.

**`app/privacy-policy/page.tsx`** — `:99-102` names *"OpenAI or Anthropic, depending on configuration"*
(accurate), `:105-107` Stripe, `:113-118` lists Slack/Gmail/Google Calendar/Google Drive/HubSpot/Jira
as connectable — 🔴 HubSpot and Jira again. `:130-135` security claims are accurate and correctly
hedged ("No method … is 100% secure").

**`components/marketing-dark/demo/scenes.tsx`** — recorded into `/how-it-works.mp4`, so these are
**shipped in a video** and cannot be fixed by editing the file:
- `:114-116` `'Pick a role from the marketplace. Each one arrives pre-trained and ready for duty in minutes.'`
- `:162-165` `'Connect the tools your employee needs — every skill is scoped and revocable in one click.'` + chip `'40+ more'`
- `:198-201` `'Answers stay grounded in your business — always with a citation.'`
- `:240-242` `'…hand work between employees automatically — 24/7.'`
- `:271-274` `'Risky actions wait for one-tap human approval — every action logged.'` + chips `'Spend limits'`, `'Risky tools'`, `'Reviewers'`
- `:311-313` `'Watch output on the dashboard — tasks completed, hours saved, approval SLA. Clone what works.'` + chips `'KPIs'`, `'Goals'`, `'Alerts'`
- named example workflow `:234` `['New Email', 'AI screens', 'Qualified?', 'Schedule']`; approval example `:277-279` `'AI Finance · Send invoice'` / `'$12,000 → Acme Co.'`

#### 6.5.5 Named example workflows in visuals (unnamed but fully specified)

- `WorkflowDiagram.tsx:44-70` (homepage **and** `/automation`): `New Email` (Trigger) → `Extract Data`
  (AI Step) → `Approved?` → Yes: `Notify Manager` (Slack) / No: `Send Rejection` (Email) →
  `Log Activity` (**Notion**). No shipped template matches this graph, and the Notion node is not a
  shippable node type.
- `HeroDemo.tsx:105`: `const nodes = ['New Email', 'AI screens CV', 'Qualified?', 'Schedule interview'];`
  — the retired `recruiting-resume-score-schedule` graph, rendered in the hero.
- `HeroDemo.tsx:127-133`: `'Approval needed'` / `'AI Finance · Send invoice'` / `'$12,000 → Acme Co.'`
  — asserts an AI Finance role that sends invoices; `stripe` has no real executor.
- `DashboardMock.tsx:31-34` + `:90`: four employees shown `Active` with live tasks
  (`'Screening candidates'`, `'Following up with leads'`, `'Answering tickets'`,
  `'Processing invoices'`); `:12-18` asserts seven product surfaces incl. an `'Analytics'` page.
- `HeroDemo.tsx:161-166`: the six-step model (`Hire an AI Employee` → `Grant Skills` →
  `Brief with Knowledge` → `Chain into Workflows` → `Gate with Approvals` → `Measure & scale`) —
  accurate.

#### 6.5.6 Dead links presented as capabilities

Not "claims" strictly, but each implies a surface that does not exist:

| File:line | Link text | `href` |
|---|---|---|
| `WorkflowBuilderSection.tsx:17-19` | `'See workflow builder in action →'` | `#` |
| `IntegrationsSection.tsx:50-52` | `'See all integrations →'` | `#` |
| `AiEmployeesGrid.tsx:50-52` | `'View all AI employees →'` | `#` |
| `FinalCta.tsx:108` | `'Book a Demo'` | `#` |
| `SiteFooter.tsx:20-23` | `'Documentation'`, `'Blog'`, `'Help Center'`, `'API'` | all `#` |
| `SiteFooter.tsx:39-42`, `:103` | `'X'`, `'LinkedIn'`, `'GitHub'`, `'Discord'` | all `#` |
| `SiteFooter.tsx:82-83` | newsletter signup | `<form action="#">`, no backend |
| `DarkNav.tsx:20` | `'Resources'` | `null` — renders as unlinked plain text |

Contrast the honest handling in `ContactSalesForm.tsx:122-125`: *"This opens your email client with a
message addressed to sales@orlixa.io — nothing is sent automatically."* That is the pattern the
newsletter form should copy.

Files with **no** capability claims (checked, clean): `DarkSectionHeading.tsx`,
`DarkBreadcrumb.tsx`, `HeroGlow.tsx`, `FadeIn.tsx`, `TableOfContents.tsx`, `OrlixaMark.tsx`,
`brand-icons.tsx`, `MacWindowVideo.tsx`, `features/marketing/careers.ts` (`JOBS = []`, deliberate),
`careers/[slug]/page.tsx`. `FaceMesh.tsx`'s only string is the a11y label at `:292` (relevant to
§5.2: deleting it removes no claim).

#### 6.5.7 Severity ordering for the plan

1. `SecuritySection.tsx:4` `'SOC 2 Compliant'` / `'GDPR Ready'` — legal exposure, self-contradicted
   by an indexed FAQ.
2. `plans.ts` seat counts and prices vs the founder-approved role-based plans; `pricing/page.tsx:40-42`
   + `plans.ts:71` selling `BUSINESS`-gated features on Free/Starter.
3. `integrations/page.tsx:33-35` "not a roadmap item" over 4 `SIMULATED` skills + no status field in
   `integrations.ts`.
4. `500+` / `40+` / `12+` integration and role counts (four files + a shipped video).
5. `Testimonials.tsx` + `DarkHero.tsx:19,124` + `FinalCta.tsx:95` — fabricated social proof.
6. `98.6%` / `1,248` / `300+` hours / `2.4h` SLA — unbacked metrics in four files.
7. `PricingFaq.tsx:11-16` proration and trial-end claims (indexed as schema.org).
8. `ai-employees.ts`'s three retired `exampleWorkflow` blocks (§6.1) and `automation-categories.ts:35`
   labelling Sales `Coming soon` when it shipped.
9. `AiEmployeesGrid.tsx:5-7` "24/7 / autopilot / instantly / close deals".
10. Dead links (§6.5.6).

---

## What the implementation plan must do

Ordered per fix. "PW" = Playwright-testable in `e2e/tests/*`; "CT" = needs a vitest component/hook
test under `apps/web/src`.

### Test infrastructure to match

- **Playwright:** `d:/Vertical AI/platform/e2e/`. Config `playwright.config.ts` — `testDir: './tests'`,
  `globalSetup: './global-setup.ts'`, `workers: 1`, `fullyParallel: false`, `timeout: 120_000`,
  `expect.timeout: 15_000`, one `chromium` project, `webServer` starts web :3200 + api :4000 with
  `reuseExistingServer`. Existing specs (numbered journeys, one `test.describe` each):
  `01-auth-journey.spec.ts`, `02-security-journey.spec.ts`, `03-golden-journey.spec.ts`,
  `04-tenant-isolation-journey.spec.ts`, `05-failure-journeys.spec.ts`,
  `06-plan-seats-journey.spec.ts`. Shared helpers live in **`e2e/tests/support/app.ts`**
  (`apiLogin`, `apiPost`, `authHeaders`, `completeOnboarding`, `signUpThroughUi`,
  `verifyEmailThroughUi`). New specs follow the same `NN-<name>-journey.spec.ts` naming and import
  from `./support/app`. Remember CLAUDE.md's two traps: let Playwright start its own servers (or
  match its env), and `git checkout -- e2e/test-results/` afterwards.
- **Component/hook tests:** vitest, `apps/web/vitest.config.ts` — `environment: 'jsdom'`,
  `globals: true`, `include: ['src/**/*.test.{ts,tsx}']`, aliases `@`→`src` and
  `@vaep/types`→`packages/types/src/index.ts`. Run with `pnpm --filter @vaep/web test`. Two file
  placements are both in use: colocated (`components/DeleteDepartmentDialog.test.tsx`) and
  `__tests__/` (`features/product-context/__tests__/hooks.test.tsx`). The canonical pattern —
  `vi.mock('../api', …)`, a local `wrapper()` building a fresh
  `new QueryClient({ defaultOptions: { queries: { retry: false } } })` + `QueryClientProvider`, and
  `@testing-library/react` `render`/`renderHook` + `waitFor` — is set by
  `features/organization/components/DeleteDepartmentDialog.test.tsx:1-46` (the closest model for
  fix 2) and `features/product-context/__tests__/hooks.test.tsx:1-59` (the closest model for fix 1,
  including the `vi.mock('@/stores/session.store', …)` shim needed because every query is
  `enabled: Boolean(accessToken)`).

### Fix 1 — product-context invalidation

1. In `features/product-context/hooks.ts`, correct the `useProductContext` docstring (`:21-27`) —
   it currently asserts the behaviour being added, which is how the gap survived.
2. Add `import { productContextKeys } from '@/features/product-context/hooks';` to
   `features/employees/hooks.ts`, `features/skills/hooks.ts`, `features/billing/hooks.ts`,
   `features/onboarding/hooks.ts`, `features/tenant/hooks.ts`,
   `features/organization/hooks.ts`, `features/users/hooks.ts`, `features/marketplace/hooks.ts`.
3. Insert `void qc.invalidateQueries({ queryKey: productContextKeys.all });` into the existing
   `onSettled`/`onSuccess` of each of the 22 hooks in §1.6 — **never a new `onSettled`**, and never
   in `onMutate` (product context is server-derived; there is nothing to patch optimistically, so no
   `onMutate`/rollback is appropriate here and the house optimistic rule is satisfied by the existing
   local-key patch).
4. Add the same line beside `app/(app)/skills/page.tsx:38` (the OAuth-return effect).
5. Do **not** add a `productContextKeys.all` invalidation to the four existing
   `productContextKeys.dashboard` calls — dashboard counts move constantly and the parent's inputs do
   not; keep them separate (and note prefix matching does not conflate them).
6. Consider dropping `staleTime: 60_000` to the global 30 s default once invalidation is correct —
   **optional, flag as a judgement call**, since correct invalidation makes the stale window a pure
   cost/benefit question.

Tests:
- **CT** `features/employees/__tests__/product-context-invalidation.test.tsx` (new): render
  `useCreateEmployee` with a spy `QueryClient` (`vi.spyOn(qc, 'invalidateQueries')`) and assert it is
  called with `['product-context']`. One test per hook family (employees, skills, billing,
  onboarding, tenant, organization) — six assertions, not 22, is proportionate.
- **PW** extend `e2e/tests/06-plan-seats-journey.spec.ts`: the existing assertion at `:58`
  (`/2 of 2 seats/` after an in-page hire, 30 s timeout) already IS the regression test — it should
  flip from failing to passing. Add an explicit negative guard: assert `1 of 2 seats` is **gone**
  within 5 s of the hire, so a future 60 s staleTime cannot make it pass by luck.
- **PW** a new case for the reverse direction: install a skill on `/skills` and assert the sidebar or
  dashboard reflects the new area without a reload.

### Fix 2 — delete safety

1. `packages/types` — nothing to add (`EmployeeDependenciesDto` exists, `index.ts:480-502`).
2. `features/employees/api.ts` — add
   `employeeDependencies(id): Promise<EmployeeDependenciesDto>` (mirror
   `features/organization/api.ts:41-48`) and change `deleteEmployee` to
   `deleteEmployee(vars: { id: string; hard?: boolean })` building `?hard=true` exactly as
   `deleteDepartment` builds its query string (`organization/api.ts:57-67`).
3. `features/employees/hooks.ts` — add
   `dependencies: (id: string) => ['employees', id, 'dependencies'] as const` to `employeeKeys`
   (`:36-48`); add `useEmployeeDependencies(id: string | null)` copying
   `useDepartmentDependencies`'s `enabled: Boolean(id)` + `staleTime: 0` + its comment reasoning
   (`organization/hooks.ts:142-155`); widen `useDeleteEmployee`'s variables from `string` to
   `{ id: string; hard?: boolean }` and keep the optimistic `onMutate`/`onError`/`onSettled` shape.
   **Note:** for a hard delete the optimistic row removal is still correct; but the 409 paths
   (`inFlightRuns`/`pendingApprovals`, `employees.service.ts:361-372`) mean the rollback matters —
   verify the existing `onError` restores the row.
4. New `features/employees/components/DeleteEmployeeDialog.tsx` — wrap `Modal`
   (`components/ui/Modal.tsx`), structure copied from `DeleteDepartmentDialog.tsx`: loading line →
   the real counts from the endpoint → the two 409 blockers stated as blockers, not surprises →
   an OWNER-only "Delete for good" path whose label names the consequence. It must **replace** the
   false copy at `EmployeeCard.tsx:99` ("It will stop working immediately") with something true —
   per `08-execution-identity-and-lifecycle.md` §C.2 an archived employee's workflows keep running,
   and `referencingWorkflows` is exactly the number to say so with.
5. `EmployeeCard.tsx` — replace `:95-106`'s `window.confirm` + `del.mutate(employee.id)` with
   `setDeleting(true)` and render the dialog, mirroring `DepartmentSection.tsx:42,138,152-157`.
6. Workflow side: **do not build a workflow dependencies endpoint in this fix** unless explicitly
   scoped — none exists (§2.3). The cheap, honest improvement is to replace
   `WorkflowListTable.tsx:212-228`'s `window.confirm` with the same `Modal`-based dialog fed by
   `useWorkflowRuns(id)` counts the frontend already has, keeping the existing 409 message
   (`:46-47`). Flag as a separate, smaller item.

Tests:
- **CT** `features/employees/components/DeleteEmployeeDialog.test.tsx` — direct copy of
  `DeleteDepartmentDialog.test.tsx`'s shape: `vi.mock('../api', …)` returning a fixture
  `EmployeeDependenciesDto`; assert (a) the real counts are rendered, (b) `pendingApprovals > 0`
  disables the confirm and explains why, (c) `inFlightRuns > 0` likewise, (d) the hard-delete option
  is absent for a non-OWNER, (e) confirming calls `deleteEmployee` with `{ id, hard: false }` and the
  owner path with `{ id, hard: true }`.
- **PW** new `e2e/tests/07-delete-safety-journey.spec.ts`: hire an employee, start a conversation,
  open the delete dialog, assert the conversation count from the API appears in the dialog (proves the
  endpoint is really called, not a hardcoded string).

### Fix 3 — employee → workflows tab

1. Decide and record the matching rule (§3.1): backend substring match vs `deriveEmployees`'
   `AI_EMPLOYEE_STEP|AI_STEP`-only rule.
2. Backend: `GET /employees/:id/workflows → WorkflowDto[]` on
   `apps/api/src/modules/employees/employees.controller.ts` immediately after `dependencies()`
   (`:84-90`); inherit `@UseGuards(JwtAuthGuard, AuthorizationGuard)`, add **no**
   `@RequirePermission`, take `@CurrentUser() user` and thread `user.userId`. **Apply the same
   `authz.filter(actor, 'workflow:read', …)` pass `WorkflowsService.list` uses
   (`workflows.service.ts:248-257`), including `scope: wf.category` and `ownerUserId`, plus
   `isAssistScratch: false`** — otherwise the new route leaks names the workflows list deliberately
   hides. Reuse the existing `toWorkflowDto` mapper; add no new DTO.
3. Verify module wiring is cycle-safe (§3.5) before writing code.
4. Frontend: `listEmployeeWorkflows` in `features/employees/api.ts`;
   `employeeKeys.workflows(employeeId)` + `useEmployeeWorkflows` in `features/employees/hooks.ts`;
   new `features/employees/components/EmployeeWorkflowsTab.tsx`; add `'workflows'` to `TabId` and
   `TABS` in `app/(app)/employees/[id]/page.tsx:28-37` and one render block after `:225`.
5. Keep the tab read-only (name → `/workflows/:id`, status pill, trigger, last-updated). If the
   status pill is reused, `StatusPill`/`STATUS_META` must be exported from `WorkflowRow.tsx:37-71`
   (currently module-private) rather than duplicated.

Tests:
- **CT** `features/employees/components/EmployeeWorkflowsTab.test.tsx` — mocked api; assert the empty
  state ("this employee isn't used by any workflow yet") and that each row links to `/workflows/:id`.
- **PW** extend `e2e/tests/03-golden-journey.spec.ts` (it already creates a workflow with an
  employee): after publishing, open `/employees/:id`, click the Workflows tab, assert the workflow
  name is listed. Cross-tenant negative belongs in `04-tenant-isolation-journey.spec.ts`.
- **API e2e** (`apps/api/test/`, jest): a member of a different department must not see a
  category-scoped workflow through the new route — this is the authz regression that matters and it
  is not Playwright-testable cheaply.

### Fix 4 — WhatsApp connection truth

1. Decide the mechanism (§4.4): a data-driven "connection is managed elsewhere" marker on the skill
   catalog DTO (preferred — the catalog is already the single source of truth and
   `executionSupport`/`simulated` are already derived there), vs a second hardcoded `def.key ===` in
   `ConnectSkillControl.tsx` alongside the existing slack one at `:132`.
2. In `ConnectSkillControl.tsx`, add a branch **before** #5 (`:116`) that renders a link to
   `/leads/whatsapp-connect` instead of the API-key field, with copy naming why.
3. `InstalledSkillList.tsx:154-158` — the `Connected` badge must not be shown for whatsapp on the
   strength of `InstalledSkill.connectionStatus` alone. Options: read `useWhatsAppAccount()` for the
   truth, or (server-side, out of scope here) stop `connectSkill` writing CONNECTED for a skill whose
   credentials live in another table. **Flagged: the badge is a server-state display, so a purely
   frontend fix here is cosmetic — say so in the plan and pair it with the backend half.**
4. Add a link from `/skills` to `/leads/whatsapp-connect` (there is none today, §4.4).
5. Optional house-rule cleanup: `useConnectWhatsAppAccount` (`features/whatsapp/hooks.ts:22-31`) uses
   only `setQueryData` — add `onSettled` invalidation of `whatsappAccountKeys.account` and (per fix 1)
   `productContextKeys.all`.

Tests:
- **CT** `features/skills/components/ConnectSkillControl.test.tsx` (new — none exists): a table-driven
  test over the full `connection.type × executionSupport` cross-product in §4.1, pinning all six
  branches, plus the new whatsapp branch. This is the highest-value new component test in the whole
  plan; the matrix is currently unpinned.
- **PW** `/skills`: assert WhatsApp shows a link to the dedicated page and **no** password input.

### Fix 5 — dead UI

1. Delete `apps/web/src/components/marketing-dark/FaceMesh.tsx` (zero references, §5.2).
2. Delete the empty `<section>` at `app/(app)/marketplace/page.tsx:41-45`, or replace it with a
   `<Link href="/workflows/templates">`. Prefer the link — the heading exists because customers look
   for templates there.
3. `DisabledControl.tsx`: delete, or adopt at the three genuine button sites
   (`BuilderLifecycleBar.tsx:150`, `RunControls.tsx:69`, `TemplateInstallForm.tsx:116`). Do **not**
   adopt inside the two menu mechanisms (§5.3).
4. Keep `DemoPlayer.tsx` + `scenes.tsx`; add a header comment in `DemoPlayer.tsx` citing
   `app/demo/page.tsx:11-15` so the next sweep does not re-litigate it.

Tests: **CT** if `DisabledControl` is adopted, one test per adoption site asserting the reason reaches
`aria-label`. Otherwise typecheck + `pnpm --filter @vaep/web lint` is sufficient — deletions of
zero-reference files need no new test, but `pnpm --filter @vaep/web build` must be run (a
`next/dynamic` or string reference the grep missed would only surface there).

### Fix 6 — marketing claim honesty

Work in the severity order set out in §6.5.7. The scope is much wider than the one file the prior
audit named — `ai-employees.ts` is item 8 of 10.

**Step A — the legal item, first and alone.** Delete `'SOC 2 Compliant'` and `'GDPR Ready'` from
`components/marketing-dark/SecuritySection.tsx:4`, and replace them with the capability-only list
`/security` already publishes (`app/security/page.tsx:141-145`). Keep `'Role-based Access'`,
`'Audit Logs'`, `'Data Encryption'` — all three are verified true (§6.5.4). If a compliance line is
wanted, use `/security`'s own wording ("certification, not yet held").

**Step B — pricing.** `features/marketing/plans.ts` is a second, divergent plan catalog whose own
header comment (`:10-13`) admits it. Either (i) reconcile it with `apps/api/.../billing.plans.ts`'s
`PLAN_CATALOG` — seats 2/2/4/∞, prices $0/$20/$40/custom — or (ii) mark it a marketing-only
positioning list and remove every number the product does not enforce. Independently:
- Delete or gate `plans.ts:71` `'Workflow templates'` from Starter (every template is
  `minPlan: 'BUSINESS'`).
- Rewrite `app/pricing/page.tsx:40-42` — "All plans include … workflow automation, and access to our
  AI Employee marketplace" is false for Free/Starter.
- Remove `plans.ts:104` `'SLA & uptime guarantee'`, `:105` `'On-premise / VPC options'` and
  `app/contact-sales/page.tsx:19,21` unless they are contractual commitments someone will honour.
- Move `plans.ts:91` `'Role-based access control'` out of the Business-only list (RBAC is universal).
- Rewrite `PricingFaq.tsx:11-12` (proration is a TODO) and `:15-16` (no trial-end enforcement;
  downgrade grandfathers). **These two are indexed as schema.org `FAQPage` via
  `app/pricing/page.tsx:22`, so they are public commitments, not just page copy.**

**Step C — integrations, the structural fix.** Add an availability field to
`features/marketing/integrations.ts` mirroring `SkillDefinitionDto.executionSupport`
(`REAL`/`PARTIAL`/`SIMULATED`) and render it on `/integrations` and `/integrations/[slug]` with the
same wording the in-app catalog already uses (`SkillCatalog.tsx:132-150`). Then:
- Soften `app/integrations/page.tsx:33-35` ("not a roadmap item") — it is false for stripe, github,
  hubspot, jira.
- Fix the four `SIMULATED` entries' capability bullets (`integrations.ts:54-62`, `:66-70`, `:82-86`,
  `:90-99`).
- Delete `Salesforce` and `Notion` from `IntegrationsSection.tsx:18-19`, and the Notion action node
  from `WorkflowDiagram.tsx:70` — `integrations.ts:11-12` already documents that they are not skills.
- Remove HubSpot and Jira from `app/privacy-policy/page.tsx:113-118`'s connectable list.

**Step D — counts and metrics.** Replace `DarkHero.tsx:22-25`'s four stats with either real figures or
qualitative copy: `12+` roles → 10, `500+` integrations → the real count (also
`IntegrationsSection.tsx:24,29` and `demo/scenes.tsx:165`'s `'40+ more'`), and delete `98.6%` /
`300+ hours` outright (nothing computes them, and `terms-of-service/page.tsx:133-137` disclaims
exactly that kind of accuracy claim). Same four figures also live in `DashboardMock.tsx:99-113`,
`HeroDemo.tsx:141-146` and `demo/scenes.tsx:317-320` — fix all four or the contradiction just moves.
**Caveat: `demo/scenes.tsx` is the source of the shipped `/how-it-works.mp4`, so editing the file does
not fix the video.** Either re-record or add a dated disclaimer beside the player at
`app/demo/page.tsx:42`. Flag this as a decision, not a code task.

**Step E — social proof.** Delete `Testimonials.tsx:17-38` (three fabricated testimonials incl. a
quantified "automated 80% of our support tickets"), `DarkHero.tsx:19` + `:124` (the six-logo
"Trusted by forward-thinking companies" row), `FinalCta.tsx:95` ("thousands of companies") and soften
`careers/page.tsx:32-33`. Memory (`marketing-video-scripts.md`) already records that no real customer
metrics or testimonial exist. Replace with the honest alternative the site already uses elsewhere —
capability statements rather than borrowed credibility.

**Step F — `ai-employees.ts` itself.**
1. Remove all three `exampleWorkflow` blocks (`:45-53`, `:75-83`, `:105-113`). SUPPORT and RECRUITER
   have **no** shipped replacement (§6.4) — removal, not rewrite. SALES could be rewritten to
   `sales.whatsapp-lead-qualify`, but only with the Twilio WhatsApp prerequisite stated.
2. Add `exampleWorkflow` to `hr-ai` and `marketing-ai`, which currently **under**-claim despite 11
   real templates each — the one place the file can gain a truthful claim.
3. Fix or label the `suggestedSkillKeys` naming `SIMULATED` skills (`hubspot`, `jira`, `stripe` —
   §6.1). The in-app `/skills` page already prints "Demo only"; this file contradicts it.
4. Reconcile the stated mirror rule with the four `suggestedSkillKeys` drifts (§6.3) — update
   `marketplace.catalog.ts`'s `suggestedSkills` or soften the docstring at `:1-9`.
5. Also fix `app/ai-employees/page.tsx:42-43` ("Each one comes with skills, workflows and human
   approval built in" — false for 7 of 10 roles) and the "every business function" claim at
   `WhatIsVaep.tsx:23-24`, `AiEmployeesGrid.tsx:20`, `ai-employees/page.tsx:76`.
6. Soften `AiEmployeesGrid.tsx:5-7` — "24/7", "on autopilot", "close deals", "instantly".

**Step G — the two stale-in-the-honest-direction items.** `automation-categories.ts:35` labels Sales
`Coming soon` although 2 Sales templates shipped, and `app/automation/page.tsx:117-120` says "every
other team is on our roadmap". Update both. Also correct
`marketplace.catalog.ts:175-176`'s doc-comment ("The DB catalog currently covers HR (11) and
Marketing (11)") and **CLAUDE.md line 85's "22 first-party templates"** — the real count is 24.

**Step H — dead links (§6.5.6).** Either point them somewhere real or remove them.
`ContactSalesForm.tsx:122-125` is the in-repo precedent for the honest treatment of a
no-backend form; the newsletter form at `SiteFooter.tsx:82-83` should copy it or go.

**Step I — the drift guard, so this cannot recur.** Existing precedents:
`workflow-templates.catalog.spec.ts` (runs the boot-seed validator over all 24 templates as a fast
unit test) and `real-execution-support.spec.ts` (asserts the registry and the executor agree by
**reading the source file**). Add `apps/web/src/features/marketing/__tests__/claims.test.ts`
asserting:
- every `exampleWorkflow.name` in `ai-employees.ts` corresponds to a shipped template key;
- no `suggestedSkillKeys` entry is a known-`SIMULATED` skill;
- every `integrations.ts` entry's availability field matches the skills catalog;
- `automation-categories.ts`'s `available` flag matches whether templates exist for that category;
- `plans.ts` seat counts match `PLAN_CATALOG`;
- the string `SOC 2` appears nowhere outside `app/security/page.tsx`.

**This is the item most likely to prevent a repeat.** Obstacle the file's own docstring names
(`ai-employees.ts:5-7`): the API catalogs "isn't reachable from `apps/web`'s build", so the guard
needs either a small shared constant in `packages/types` (the clean answer — it is already the shared
DTO package both sides build against) or a test-only relative import. **Flagged as undetermined.**

Tests: **CT** the drift guard above (pure, no DOM). **PW** low value for copy, with one exception —
a Playwright assertion that the string `SOC 2 Compliant` does not appear on `/` is worth having,
because that is the claim with legal consequences and a grep guard can be bypassed by rewording.

---

## Undetermined / flagged

1. **Fix 2 dialog primitive.** `DeleteDepartmentDialog` hand-rolls its overlay and does not use
   `Modal`; the codebase has both patterns. Recommendation is `Modal` (it has the focus trap), but
   this is a call the plan must make explicitly.
2. **Fix 3 module cycle.** Whether `EmployeesModule` can reach the workflows authz filter without an
   import cycle was not fully traced this pass.
3. **Fix 3 matching semantics.** Backend `string_contains` vs frontend `deriveEmployees` disagree on
   which node types bind an employee. Not resolvable without a product decision.
4. **Fix 4 badge.** The `Connected` badge is server state; a frontend-only change cannot make it
   truthful. Needs the backend half (`connectSkill` refusing, or the catalog declaring, that
   whatsapp's credentials live in `WhatsAppAccount`).
5. **Fix 6 drift guard reachability.** `apps/web` cannot import `apps/api`'s catalogs; the shared
   location for a template-key list is undecided. `packages/types` is the obvious host but nothing
   product-facing lives there today.
6. **CLAUDE.md line 85 says "22 first-party templates"; the real count is 24** (11 HR + 11 Marketing
   + 2 Sales). `marketplace.catalog.ts:175-176`'s doc-comment says the same wrong thing. Worth
   correcting alongside fix 6.
7. **`/how-it-works.mp4` is already recorded** from `components/marketing-dark/demo/scenes.tsx`, so
   the `'40+ more'` integrations chip (`:165`) and the four unbacked metrics (`:317-320`) are shipped
   in a video that a code change cannot fix. Re-record vs disclaim is a product decision.
8. **`features/marketing/plans.ts` is a second plan catalog** that diverges from the server's
   `PLAN_CATALOG` on seats *and* prices, and its own header comment admits the quotas are unmetered.
   Whether to reconcile it or explicitly demote it to positioning-only copy is a founder decision,
   not an implementation one — it changes what the product is being sold as.
9. **The `/skills` "Connected" badge for WhatsApp** (§4.3, fix 4 step 3) cannot be made truthful from
   the frontend alone. Scope the backend half or the fix is cosmetic.
