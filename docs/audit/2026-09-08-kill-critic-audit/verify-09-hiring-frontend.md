# verify-09 — The AI Employee hiring / onboarding EXPERIENCE, as it exists today

**Read-only baseline pass, 2026-09-10.** Nothing in `apps/web`, `apps/api`, `packages/types` or `e2e`
was modified. Purpose: establish exactly what the hiring experience *is* right now, so a "guided
hiring flow" implementation builds only what is genuinely missing.

Scope read: `apps/web/src/features/{employees,onboarding,marketplace,product-context,skills,assist}`,
`apps/web/src/app/(app)/{employees,employees/[id],marketplace,onboarding,billing}`,
`apps/api/src/modules/{employees,onboarding,assist,skills,workflows,analytics,approvals}`,
`packages/types/src/index.ts`, `e2e/tests/**`, `apps/web/src/**/*.test.*`.

Grades used: **IMPLEMENTED · PARTIALLY IMPLEMENTED · BROKEN · MISSING · MOCK**.
Anything I could not settle from code is marked **⚠️ UNDETERMINED** rather than guessed.

---

## 0. One-paragraph answer

Hiring today is a **single-shot form**, three times over. There are three independent hire entry
points (`EmployeeForm`, the onboarding wizard step 2, and the marketplace template card); all three
collect **only** identity (`name`, `role`, optional `persona`/`model`) and all three land the employee
straight in `ACTIVE` with zero skills, zero connections, zero knowledge and zero workflows. There is
**no** capability step, **no** connection step, **no** workflow-assignment step and **no** review step
anywhere. Everything that would make the employee actually useful lives *after* hiring, behind six
tabs on the employee detail page, and the product never tells the user that. `SeatSummary` /
`useSeatAvailability()` are real and do grey out unavailable roles — that part is genuinely done and
should not be rebuilt. What is missing is the *sequence*, the *readiness truth*, and the
employee→workflows direction (which has no API and no UI at all).

---

## 1. Every UI surface that hires an employee

There are exactly **three** code paths that create an `AiEmployee`, plus one marketing-site CTA that
only links to `/register`.

### 1.1 `EmployeeForm.tsx` — the primary hire form — **IMPLEMENTED (single-shot)**

`d:/Vertical AI/platform/apps/web/src/features/employees/components/EmployeeForm.tsx` (147 lines).
Rendered by `apps/web/src/app/(app)/employees/page.tsx:45`, anchored `#hire-employee` (`:50`), with
the page's own "New employee" button being a same-page anchor, not a dialog:

```tsx
// app/(app)/employees/page.tsx:38-41
<a href="#hire-employee" className={buttonClasses('violet')}>
  <UserPlus className="h-4 w-4" />
  New employee
</a>
```

**Fields the user actually fills in — three, total:**

| Field | Control | Line |
|---|---|---|
| `name` | text input `#name`, placeholder `e.g. Ada` | `:74-80` |
| `role` | `<select id="role">` over all 8 `EMPLOYEE_ROLES` | `:87-100` |
| `persona` | optional `<textarea rows={2}>` | `:115-129` |

The zod contract confirms there is nothing else to fill in —
`packages/types/src/index.ts:331-345`:

```ts
export const createEmployeeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  role: z.enum([ 'SUPPORT','SALES','RECRUITER','HR','ACCOUNTANT','PROJECT_MANAGER','CUSTOM','MARKETING' ]),
  persona: z.string().max(2000).optional(),
  model: z.string().max(120).optional(),
});
```

`model` is accepted by the DTO but **has no control on the hire form** (it only appears in
`EmployeeSettings.tsx:210-217`, post-hire).

- **SKILLS during hiring:** MISSING. No skill picker on this form.
- **CONNECTIONS during hiring:** MISSING.
- **KNOWLEDGE during hiring:** MISSING.
- **WORKFLOWS during hiring:** MISSING (and see §3 — the API doesn't exist either).

**What happens immediately after submit:** `useCreateEmployee()` fires
(`features/employees/hooks.ts:76-135`) with an optimistic row hardcoded `status: 'ACTIVE'` (`:93`),
invalidates `employeeKeys.list` + `productContextKeys.all` (`:127-132`), and `onSuccess: () => reset()`
(`EmployeeForm.tsx:45`) clears the form. **There is no navigation, no "next step", no toast, no link
to the new employee.** The user is left looking at an empty form with a new card in the roster below.
The employee is `ACTIVE` and *chattable*, but cannot perform a single tool action until someone
separately installs a skill on `/skills` and assigns it on the employee's Tools tab.

### 1.2 `OnboardingWizard.tsx` step 2 — first-run hire — **PARTIALLY IMPLEMENTED**

`d:/Vertical AI/platform/apps/web/src/features/onboarding/components/OnboardingWizard.tsx` (441 lines).
4 steps: Company → **Choose AI Employee(s)** → Business goals → Departments (`:38-39` docstring).

Step 2 (`:246-298`) offers exactly **two roles**, hardcoded:

```ts
// :21-31
const ROLE_META: Record<string, { title: string; blurb: string }> = {
  HR: { title: 'HR Employee', blurb: 'Recruitment, candidate screening, interview scheduling, onboarding, reviews & offboarding.' },
  MARKETING: { title: 'Marketing Employee', blurb: 'Content, social media, campaigns, email marketing, SEO, lead gen & analytics.' },
};
const ROLES = ['HR', 'MARKETING'] as const;
```

So the wizard can hire **2 of the 8 roles**. The other six (`SUPPORT`, `SALES`, `RECRUITER`,
`ACCOUNTANT`, `PROJECT_MANAGER`, `CUSTOM`) are unreachable from onboarding — a customer who wants a
Support AI must finish onboarding first and then use `/employees`. Not necessarily wrong (only HR and
Marketing have workflow templates), but it is a hardcoded list that will drift from the catalog.

- **Fields filled in:** a multi-select of role toggles. **No name field** — the name comes from the
  server catalog: `onboarding.service.ts:390-393` `const suggested = ONBOARDING_CATALOG.find(...)?.suggestedName; const name = entry.name?.trim() || suggested || entry.role;`
- The wizard sends `employees: roles.map((role) => ({ role: role as never }))` (`:155`) — role only.
- **SKILLS / CONNECTIONS / KNOWLEDGE / WORKFLOWS during hiring:** all MISSING.

**Immediately after submit:** `finish()` (`:147-158`) saves departments, calls
`complete.mutateAsync(...)`, then `router.replace(canUseAssist ? '/assist' : '/dashboard')`. Employees
land `ACTIVE`. A STARTER company (the default) goes to `/dashboard` — so a brand-new customer's
*entire* first-run hiring experience is: pick HR and/or Marketing → land on a dashboard, with two AI
employees that have no skills, no connections and no knowledge, and nothing telling them so.

### 1.3 Marketplace `EmployeeTemplateCard` — **PARTIALLY IMPLEMENTED / has a real defect**

`d:/Vertical AI/platform/apps/web/src/features/marketplace/components/EmployeeTemplateList.tsx:12-80`.

- **Fields filled in:** one optional name override (`:55-61`). Role/persona/skills come from the
  server template.
- Shows `Suggested skills: {template.suggestedSkills.join(', ')}` (`:48-52`) — **display only, it
  installs nothing.**
- **After submit:** `useInstallEmployeeTemplate()` (`features/marketplace/hooks.ts:46-103`), then the
  card renders the one piece of post-hire guidance in the whole product:

```tsx
// EmployeeTemplateList.tsx:67-77
{created && !created.id.startsWith('temp_') && (
  <p className="mt-3 text-xs text-green-700">
    Hired {created.name}.{' '}
    <Link href={`/employees/${created.id}`} …>Open employee →</Link>
  </p>
)}
```

🔴 **DEFECT (new, not in the prior audit): the marketplace hire never renders an error.**
`EmployeeTemplateCard` reads `install.isPending` (`:63`) and `created` (`:67`) and **nothing else** —
there is no `install.isError` branch anywhere in the file. `EmployeesService.create` throws a
`ForbiddenException` with a carefully-written refusal (`employees.service.ts:111` →
`seatRefusal()` at `:577-604`), and the marketplace UI **silently swallows it**: the optimistic temp
row is rolled back (`hooks.ts:91-95`), the button un-disables, and the user sees nothing at all. The
hire form (`EmployeeForm.tsx:131-135`) *does* render `create.error?.message`. Same mutation class, two
different levels of honesty.

🔴 **Second, smaller defect:** the marketplace optimistic row hardcodes `role: 'CUSTOM'`
(`hooks.ts:64`) regardless of the template's real role, so for ~1 second an HR template shows as
"Custom" in the roster. Self-corrects on settle. Cosmetic.

Also worth naming: the marketplace card does **not** call `useSeatAvailability()` at all — so unlike
the hire form and the wizard, it offers Install on roles the plan will refuse.

### 1.4 Other "Hire AI Employee" entry points — all links, no hire

Full grep of `Hire|hire` across `apps/web/src` (excluding marketing data files) returns only:
- `app/ai-employees/page.tsx:88` and `app/ai-employees/[slug]/page.tsx:67` — public marketing CTAs
  (`Hire {employee.name}`) that link to signup. Not app surfaces.
- `features/analytics/components/KpiTable.tsx:61` — `No employees yet. Hire an AI employee to see per-employee metrics.` (prose, no link)
- `features/employees/components/EmployeeList.tsx:17` — `No employees yet. Hire one above to get started.` (prose, no link)
- `features/workflows/components/builder/TemplateInstallForm.tsx:160-163` — `No eligible AI Employees yet — hire one for this role first.` (prose, **no link**, on the screen where it matters most)
- `features/billing/components/UsageSummary.tsx:125` — `…you can't hire again until you're back…`

**Verdict:** there is no "Hire AI Employee" dialog, modal, or wizard anywhere. Every hire is a form
section on a list page, a step in first-run onboarding, or a card in the marketplace.

---

## 2. Is there a guided multi-step hiring flow?

**MISSING.** There is no `choose role → configure capabilities → configure connections → assign
workflows → review → activate` flow, and no component that resembles one.

What exists instead, in full:

| Target stage | Today |
|---|---|
| choose role | ✅ a `<select>` (hire form) or two toggles (wizard) |
| configure capabilities | ❌ post-hire only, `Tools` tab → `EmployeeSkillPicker` |
| configure connections | ❌ post-hire only, and split across `/skills` + the Tools tab (see §5) |
| assign workflows | ❌ **does not exist in either direction** (see §3) |
| review | ❌ nothing |
| activate | ❌ N/A — the employee is already `ACTIVE` at creation; there is no inactive state to activate from (see §4) |

The multi-step machinery **does** exist elsewhere and is reusable:
- `components/onboarding/OnboardingShell` + `components/onboarding/fields` (`IconField`, `ToggleCard`)
  — the wizard's step chrome, already takes a `step` number (`OnboardingWizard.tsx:164`, `:248`, `:303`, `:335`).
- `components/ui/Modal.tsx` — the shared focus-trapped dialog with 6 existing consumers
  (documented in `verify-06-frontend.md` §2.4).
- The wizard's own state shape is plain `useState` + per-step `mutateAsync` — no state machine to fight.

### 2.1 Seat gating — **IMPLEMENTED. Do not rebuild this.**

The hypothesis in the task is correct. `useSeatAvailability()` is the single source and it is shared
by the display, the hire form and the wizard.

`d:/Vertical AI/platform/apps/web/src/features/product-context/hooks.ts:133-161` (verbatim):

```ts
export function useSeatAvailability(): {
  isLoading: boolean;
  seats: EntitlementsDto['seats'] | null;
  creditsPerEmployeePerMonth: number | null;
  /** null = hireable; otherwise the plain-language reason it is not. */
  reasonBlocked: (role: EmployeeRole) => string | null;
} {
  const { data, isLoading } = useProductContext();
  const seats = data?.entitlements.seats ?? null;
  return {
    isLoading,
    seats,
    creditsPerEmployeePerMonth: data?.entitlements.creditsPerEmployeePerMonth ?? null,
    reasonBlocked: (role) => {
      if (!seats) return null;
      if (seats.max !== null && seats.used >= seats.max) {
        return `All ${seats.max} seats on your plan are taken.`;
      }
      const inRole = seats.perRole.find((r) => r.role === role);
      if (seats.maxPerRole !== null && inRole && inRole.used >= seats.maxPerRole) {
        return `Your plan includes ${seats.maxPerRole} per role and you already have ${inRole.used}.`;
      }
      if (seats.maxRoles !== null && !inRole && seats.rolesUsed >= seats.maxRoles) {
        return `Your plan includes ${seats.maxRoles} roles and you already use ${seats.rolesUsed}.`;
      }
      return null;
    },
  };
}
```

Its docstring names the invariant an implementer must preserve (`:122-132`):

> `EmployeesService.create()` is the real control and applies the identical rule, so what is greyed
> out is exactly what would be refused.

**The greying itself**, `EmployeeForm.tsx:87-111` (verbatim — this is the style to match):

```tsx
<select id="role" className="field-modern" {...register('role')}>
  {EMPLOYEE_ROLES.map((r) => {
    const inRole = seats?.perRole.find((p) => p.role === r);
    const blocked = reasonBlocked(r) !== null;
    const perRoleMax = seats?.maxPerRole ?? null;
    return (
      <option key={r} value={r} disabled={blocked}>
        {formatRole(r)}
        {inRole && perRoleMax !== null ? ` (${inRole.used} of ${perRoleMax})` : ''}
        {blocked ? ' — not on your plan' : ''}
      </option>
    );
  })}
</select>
…
{blockedReason && !allSeatsTaken && (
  <p className="mt-1 text-xs text-sl-warning">
    {blockedReason}{' '}
    <Link href="/billing#plans" className="font-semibold underline underline-offset-2">Upgrade</Link>
  </p>
)}
```

`SeatSummary.tsx:14-35` is the read-only header projection of the same hook — it renders
`2 of 4 seats · HR 2/2 · Marketing 0/2 · 2 of 2 roles` and returns `null` when `seats.max === null`
(Enterprise) at `:16`.

The wizard's equivalent is **hand-rolled arithmetic rather than the shared rule**, which is a real
(minor) divergence — `OnboardingWizard.tsx:263-270`:

```ts
const alreadyPicked = roles.includes(role);
const wouldExceed =
  !alreadyPicked &&
  seats !== null &&
  ((seats.max !== null && seats.used + roles.length >= seats.max) ||
    (seats.maxRoles !== null &&
      seats.rolesUsed + roles.length >= seats.maxRoles &&
      !seats.perRole.some((p) => p.role === role)));
```

It does not call `reasonBlocked()` (it can't — `reasonBlocked` doesn't model a multi-role *selection*),
so `checkSeatFor` has **three** consumers on the server and **two-and-a-half** on the client. Worth
naming; not worth a rewrite unless the new flow multi-selects.

---

## 3. The employee detail page — every existing tab

`d:/Vertical AI/platform/apps/web/src/app/(app)/employees/[id]/page.tsx` (286 lines). Six tabs, plain
local `useState` (`:57`), rendered as a button strip at `:161-176`, each panel a bare
`{activeTab === 'x' && …}` block.

```tsx
// :28-37
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

| Tab | Rendered | Component | Data | Grade |
|---|---|---|---|---|
| Overview | `:178-183` | `features/employees/components/EmployeeAbout.tsx` | REAL `AiEmployeeDto` only | IMPLEMENTED |
| Chat | `:185-216` | `features/employees/components/ChatPanel.tsx` | REAL (`useConversations`/`useMessages`/`useSendMessage`) | IMPLEMENTED |
| Memory | `:218` | `features/employees/components/LearningPanel.tsx` | REAL (`useEmployeeLearning`, `useEmployeeMemories`) | IMPLEMENTED |
| Tools | `:220-225` | `features/skills/components/EmployeeSkillPicker.tsx` | REAL (`useInstalledSkills`, `useEmployeeSkills`, `useCatalog`) | IMPLEMENTED |
| Knowledge | `:227-232` | **inline** `EmployeeKnowledgeTab`, same file `:260-285` | REAL (`useDocuments(role)`) | IMPLEMENTED |
| Settings | `:234-239` | `features/employees/components/EmployeeSettings.tsx` | REAL, 537 lines, `PATCH /employees/:id` | IMPLEMENTED |

### 3.1 Target tabs vs reality

| Target tab | Exists? | Evidence / where the data would come from |
|---|---|---|
| **Overview** | ✅ IMPLEMENTED | `EmployeeAbout.tsx:42-66`. 12 rows, all real DTO fields; docstring is explicit: *"built only from real `AiEmployeeDto` fields (no invented data like cost/model pricing)"* (`:13-16`). Includes real spend: `` `$${(employee.monthToDateCostUsd ?? 0).toFixed(2)} spent of $${employee.budgetLimit.toLocaleString()} this month (estimated)` `` (`:26`). **No hardcoded data found.** |
| **Workflows** | ❌ **MISSING — confirmed, and worse than "no UI": there is no API either** | Route inventory of `employees.controller.ts` (grep `@Get/@Post/@Patch/@Delete`): `POST /`, `GET /`, `GET /:id`, `PATCH /:id`, `GET /:id/dependencies`, `DELETE /:id`, `POST /:id/conversations`, `GET /:id/conversations`, … — **no `:id/workflows`**. The reverse query exists but is `private`: `employees.service.ts:300-323` `private async workflowsReferencing(companyId, employeeId): Promise<string[]>`, called from exactly one place (`dependencies()` at `:271`) and returning **ids only**. `WorkflowRun` also has no `employeeId` filter: `workflows.controller.ts:114-122` filters `status`/`workflowId`/`limit` only. Fully corroborates `verify-06-frontend.md` §3 and `00-FINAL-REPORT.md` §36 ("no employee↔workflow ownership view exists anywhere"). |
| **Skills** | ✅ IMPLEMENTED, labelled **"Tools"** | `EmployeeSkillPicker.tsx`. Assign/unassign per employee, real optimistic mutations. |
| **Connections** | 🟡 PARTIALLY IMPLEMENTED — folded into the Tools tab, OAuth-only (see §5) | `EmployeeSkillPicker.tsx:169-203` |
| **Knowledge** | ✅ IMPLEMENTED | inline component, `page.tsx:260-285`; scoped to the employee's role + Shared; the docstring at `:244-259` explains *why* there is deliberately no "Visible to" control here — read it before adding one |
| **Memory** | ✅ IMPLEMENTED | `LearningPanel`. ⚠️ Known honesty gap from `00-FINAL-REPORT.md` §15-17: the runtime recalls at most ~5 items while the panel lists every fact ever taught, with no cap and no warning. Not re-verified this pass. |
| **Approvals** | ❌ MISSING per-employee | `ApprovalRequestDto` carries `employeeId: string \| null` (`packages/types/src/index.ts:2295`), but `GET /approvals` accepts only `status` and `assignedToMe` (`approvals.controller.ts:38-43`). A per-employee view needs either a query param or client-side filtering. |
| **Usage** | 🟡 PARTIALLY — only 3 rows on Overview | `EmployeeAbout` shows `budgetLimit`, `monthToDateCostUsd`, `maxCreditsPerExecution`, `maxCreditsPerTask`. Richer per-employee numbers already exist company-wide: `GET /analytics/employees` returns `EmployeeKpiDto[]` **keyed by `employeeId`** (`types:2400-2418`: `toolActions`, `toolSuccess`, `toolErrors`, `conversations`, `assistantMessages`, `pendingApprovals`, `kpiTargets`, `attainment`). No per-id endpoint (`analytics.controller.ts:50-55` takes `range` only). |
| **Activity** | ❌ MISSING per-employee | `GET /analytics/activity` returns `ActivityFeedDto[]`, each row carrying `employeeId` (`types:2427-2432`). So an Activity tab is assemblable by filtering an existing response — no new endpoint strictly required. |
| **Settings** | ✅ IMPLEMENTED | `EmployeeSettings.tsx` (537 lines): name, department, managerName, language, **model**, workingHours start/end, timezone, knowledgeAccess, budgetLimit, maxCreditsPerExecution, maxCreditsPerTask, goals list, `kpiTargets.{tasksPerWeek,successRatePct,approvalsMax}`, 4 `permissions.*` checkboxes, 1 `approvalRules.*` checkbox. ⚠️ Per `00-FINAL-REPORT.md` §37-P1, `workingHours*`/`timezone`/`language` appear not to affect the runtime — not re-verified this pass. |

**Hardcoded/fake data on the employee page: none found.** Consistent with §23 of the final report.

**Pattern an implementer must match for a new tab** (unchanged from `verify-06` §3.2): add the id to
`TabId`, one entry to `TABS`, one `{activeTab === 'x' && …}` block, and put the panel in
`features/employees/components/<Name>Tab.tsx` — the inline `EmployeeKnowledgeTab` is the exception,
justified only because it is pure composition of another feature's parts.

---

## 4. Readiness / status display

**Grade: MISSING for readiness. IMPLEMENTED (but only 3 states) for status.**

### 4.1 The only status the UI ever shows is the raw enum

`apps/api/prisma/schema.prisma:53-57`:

```prisma
enum EmployeeStatus {
  ACTIVE
  PAUSED
  DISABLED
}
```

There is **no `PENDING_SETUP`, no `DRAFT`, no `NEEDS_ATTENTION`** — not in Prisma, not in
`packages/types`, not anywhere. **Nothing in the product can show a "PENDING_SETUP"-style state
today**, and adding one is a migration + enum change, not a UI change.

The rendering is the bare enum token, twice, with no humanisation:

```tsx
// app/(app)/employees/[id]/page.tsx:111-117
{employee && (
  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[employee.status]}`}>
    {employee.status}
  </span>
)}
```

```tsx
// features/employees/components/EmployeeCard.tsx:34-38
<span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[employee.status]}`}>
  {employee.status}
</span>
```

```ts
// features/employees/labels.ts:19-23
export const STATUS_STYLES: Record<EmployeeStatus, string> = {
  ACTIVE: 'bg-green-500/15 text-green-800',
  PAUSED: 'bg-amber-500/15 text-amber-800',
  DISABLED: 'bg-app-raised text-app-ink-2',
};
```

Note the copy is literally `ACTIVE` / `PAUSED` / `DISABLED` in caps — `formatRole()` exists in the
same file (`:11-16`) but there is no `formatStatus()`.

### 4.2 Does the UI ever say "Gmail not connected"?

**Only in one place, and only per-skill, and only for skills already assigned.**
`EmployeeSkillPicker.tsx:129-142`:

```tsx
{/* Assigning a skill nobody has connected hands the
    employee a tool that fails the moment it is used, and
    the failure surfaces mid-conversation rather than
    here. */}
{skill.connectionStatus !== 'CONNECTED' ? (
  <p className="mt-1 text-xs text-sl-warning">
    Not connected yet — actions will fail until someone
    connects it on the{' '}
    <Link href="/skills" className="underline hover:text-app-ink">Skills page</Link>.
  </p>
) : null}
```

That is the **entire** readiness surface for an AI Employee. Consequences, all confirmed by code:

- The **roster** (`EmployeeCard`) shows nothing about setup. A brand-new employee with zero skills
  and zero connections renders an identical green `ACTIVE` pill to a fully-configured one.
- The **Overview tab** shows nothing about setup. `EmployeeAbout` has no skill count, no connection
  count, no knowledge-document count, no workflow count.
- The **detail-page header** shows nothing about setup.
- An employee with **no skills assigned at all** produces no warning anywhere — the warning above
  only fires on rows the user already assigned.
- The **dashboard** has no "finish setting up X" widget (grep `Hire|hire` across `apps/web/src`
  returns no such affordance).

So the honest description of today's behaviour: **the product treats "hired" as "ready", and says so
with a green badge.** That is the single biggest experience gap in this audit.

The data needed for a real readiness computation already exists client-side and needs **no new
endpoint**: `useEmployeeSkills(employeeId)` + `useInstalledSkills()` (skills + connectionStatus),
`useDocuments(role)` (knowledge), `employee.knowledgeAccess`/`budgetLimit`/`persona` (config). The
only missing input is workflows (§3).

---

## 5. Connection setup from the employee context

**Grade: PARTIALLY IMPLEMENTED — real, but OAuth-only, and it ejects the user to another page.**

### 5.1 The flow, traced

**Component:** `features/skills/components/EmployeeSkillPicker.tsx:169-203`, the second section
("Connect a skill for this employee"). Its filter is the load-bearing line —
`EmployeeSkillPicker.tsx:73-77`:

```ts
const connectableForEmployee = (catalog ?? []).filter(
  (def) =>
    def.connection?.type === 'oauth' &&
    ownedByEmployee.get(def.key)?.connectionStatus !== 'CONNECTED',
);
```

🔴 **`def.connection?.type === 'oauth'` only.** Every `api_key` skill — including `whatsapp`
(`apps/api/src/modules/skills/catalog.ts:856`: `connection: { type: 'api_key', … }`), `slack`, and the
4 mock skills — **can never be connected per-employee.** The section simply doesn't list them. This is
not a bug per se (the picker never lies about it) but it is a hard limit on any "configure connections
during hiring" step: for api_key skills, the only path is company-wide via `/skills`.

**Endpoints:**
1. `install.mutate({ skillKey: def.key, employeeId })` (`:192`) → `useInstallSkill()`
   (`features/skills/hooks.ts:67-113`) → `POST /skills/install` (`features/skills/api.ts:28-36`),
   with `employeeId` carried into the optimistic row at `hooks.ts:85`.
2. Then `<ConnectSkillControl installed={ownRow} def={def} />` (`:188`) →
   `authorizeOAuth(installed.id)` → `GET /skills/installed/:id/oauth/authorize`
   (`features/skills/api.ts:148-157`) → full-page redirect to the provider.

### 5.2 🔴 The "connect just for me" flow cannot return to the employee page

`ConnectSkillControl.tsx:36-47` calls `authorizeOAuth(installed.id)` with **no `returnTo`**. And even
if it passed one, the server would reject it — `apps/api/src/modules/skills/oauth/oauth.service.ts:33-34`:

```ts
/** Where an in-chat/builder connect flow may return to (open-redirect guard). */
const RETURN_TO_PREFIXES = ['/assist/', '/workflows/'] as const;
```

`safeReturnPath()` (`:239-244`) returns `null` for anything not under those two prefixes, and the
callback then falls back to `/skills`: `oauth.service.ts:191`
`const returnTo = this.safeReturnPath(state.returnTo) ?? '/skills';`

**Net:** a user who clicks "Connect Gmail" on Anushka's Tools tab is redirected to Google, then dumped
on `/skills?connected=gmail` — a different page, with Anushka nowhere in sight. AI Assist got the
`returnTo` treatment (`SkillRequirementCard.tsx:193`: `authorizeOAuth(installedId, `/assist/${sessionId}`)`);
the employee context did not. **Any guided hiring flow that connects a skill must add `/employees/` to
`RETURN_TO_PREFIXES`.**

### 5.3 The state mapping shown in the employee context — 4 states, not 5+

`EmployeeSkillPicker.tsx:16-30` (verbatim — this is the mapping to match):

```tsx
const CONNECTION_LABELS: Record<SkillConnectionStatus, { text: string; className: string }> = {
  CONNECTED: { text: 'Connected', className: 'bg-green-500/15 text-green-800' },
  NOT_CONNECTED: { text: 'Not connected', className: 'bg-app-raised text-app-ink-2' },
  DEGRADED: { text: 'Degraded', className: 'bg-amber-500/15 text-amber-800' },
  DISCONNECTED: { text: 'Disconnected', className: 'bg-red-500/15 text-red-600' },
};
```

That is the complete DB enum — `packages/types/src/index.ts:853-857`:

```ts
export type SkillConnectionStatus =
  | 'NOT_CONNECTED'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'DISCONNECTED';
```

So the answer to the question as asked: **CONNECTED ✅, DISCONNECTED ✅, DEGRADED ✅ (a fifth state the
question didn't ask for), PENDING ❌, FAILED ❌, EXPIRED ❌.** There is no `PENDING`/`FAILED`/`EXPIRED`
column to render.

The 10-state projection the question is probably thinking of **does exist**, but only in the
AI-Assist / workflow-builder contract — `packages/types/src/index.ts:1092-1102` (`SkillRequirementStatus`:
`READY | NOT_CONNECTED | AUTHORIZING | CONFIGURATION_REQUIRED | VALIDATING | DEGRADED | DISCONNECTED |
EXPIRED | REVOKED | INSUFFICIENT_PERMISSION | ERROR`), with its own honest docstring at `:1079-1090`:

> Producible by today's resolver (SkillRequirementsService): READY, NOT_CONNECTED, DEGRADED,
> DISCONNECTED, ERROR. The remaining values … are part of the contract but only emitted once the
> OAuth-resume + post-connect scope/health-validation slices land … The UI must handle all of them.

And it already has a complete, reusable label map —
`features/assist/components/SkillRequirementCard.tsx:292-304`:

```tsx
const STATUS_META: Record<SkillRequirementStatus, { label: string; className: string }> = {
  READY: { label: 'Connected', className: 'text-sl-succeeded' },
  NOT_CONNECTED: { label: 'Not connected', className: 'text-app-ink-2' },
  AUTHORIZING: { label: 'Authorising…', className: 'text-violet' },
  CONFIGURATION_REQUIRED: { label: 'Needs setup', className: 'text-sl-warning' },
  VALIDATING: { label: 'Checking…', className: 'text-violet' },
  DEGRADED: { label: 'Degraded', className: 'text-sl-warning' },
  DISCONNECTED: { label: 'Reconnect needed', className: 'text-sl-failed' },
  EXPIRED: { label: 'Expired', className: 'text-sl-failed' },
  REVOKED: { label: 'Revoked', className: 'text-sl-failed' },
  INSUFFICIENT_PERMISSION: { label: 'Missing permission', className: 'text-sl-warning' },
  ERROR: { label: 'Unavailable', className: 'text-sl-failed' },
};
```

**Recommendation for the implementer:** an employee-context connection panel should consume
`GET /skills/requirements` (→ `SkillRequirementStatus`) and reuse `STATUS_META`, not the 4-state
`CONNECTION_LABELS`. `STATUS_META` is currently module-private in `SkillRequirementCard.tsx` and
would need exporting (same shape of problem `verify-06` §3.3 flagged for `WorkflowRow`'s `STATUS_META`
— note there are now **two** private `STATUS_META` constants in `apps/web`, don't confuse them).

### 5.4 Is the false "ready to use" copy reachable from the employee context? **NO.**

The sentence in question is `features/skills/components/SkillSetupWizard.tsx:206-209`:

```tsx
<p className="text-sm text-app-ink-2">
  Orlixa can&apos;t automatically verify this provider yet — your settings
  are saved and this skill is ready to use.
</p>
```

Repo-wide grep for `SkillSetupWizard` in `apps/web/src` returns exactly three hits:
`InstalledSkillList.tsx:38` (import), `InstalledSkillList.tsx:232` (the only render site), and its own
declaration at `SkillSetupWizard.tsx:44`. `InstalledSkillList` is used only on `/skills`.

**Confirmed: the "ready to use" claim is NOT reachable from the employee context today.** The employee
context uses `ConnectSkillControl` directly (`EmployeeSkillPicker.tsx:188`), which never renders that
copy. ⚠️ **But it becomes reachable the moment a guided hiring flow reuses `SkillSetupWizard`** — which
is the obvious thing to reach for, since it is the only multi-step connect UI that exists. Fix the copy
before reusing it, or the defect propagates into the new flow.

---

## 6. AI Assist ↔ hiring

### 6.1 Does AI Assist have a tool that creates or hires an employee? **NO — confirmed, by design.**

Complete tool inventory (grep `name: '<lowercase>'` across `apps/api/src/modules/assist/agent`):

| Tool | File:line | Kind |
|---|---|---|
| `list_node_types` | `assist-read-tools.ts:53` | read |
| `list_skills` | `assist-read-tools.ts:103` | read |
| `list_employees` | `assist-read-tools.ts:180` | read |
| `list_templates` | `assist-read-tools.ts:234` | read |
| `inspect_graph` | `assist-read-tools.ts:280` | read |
| `request_connection` | `assist-write-tools.ts:52` | write |
| `propose_graph` | `assist-write-tools.ts:231` | write |
| `finish` | `assist-write-tools.ts:458` | terminal |
| `patch_graph` | `assist-test-tool.ts:54` | write |
| `dry_run_test` | `assist-test-tool.ts:160` | write (sandboxed) |

**Ten tools. None creates, hires, or modifies an `AiEmployee`.** Corroborates
`00-FINAL-REPORT.md` §36 ("AI Assist → Employee: REAL (binds existing, never creates)").

`list_employees` is read-only and `ACTIVE`-filtered — `assist-read-tools.ts:191-201`:

```ts
const employees = await prisma.aiEmployee.findMany({
  // G37: ACTIVE only. A paused or disabled employee cannot run a step, so
  // offering one produces a workflow that fails the moment it fires.
  where: {
    companyId: ctx.companyId,
    status: 'ACTIVE',
    ...(args.role ? { role: args.role.toUpperCase() as never } : {}),
  },
  select: { id: true, name: true, role: true, persona: true },
  orderBy: { createdAt: 'asc' },
});
```

### 6.2 What it does when no suitable employee exists — **it tells the user, in prose only**

The behaviour is fully specified in two places.

**The tool's own `note` field** (`assist-read-tools.ts:212-217`):

```ts
note:
  employees.length === 0
    ? args.role
      ? `Nobody is hired for the ${args.role.toUpperCase()} role. Design the step anyway, leave it unassigned, and tell the user which role to hire.`
      : 'No AI Employees are hired and active. Any step that needs one will have to be flagged for the user to fill in.'
    : undefined,
```

**The prompt rules that govern it** (`assist-prompt.ts`, verbatim):

```
// :61
'- An `AI_EMPLOYEE_STEP` must name an employee id that `list_employees` returned — and it must be the employee whose ROLE actually covers the task. Match the job to the role (e.g. screening/scoring CVs and shortlisting candidates is a RECRUITER, not HR; HR is policy/onboarding/people-ops). If no hired employee has the right role for a step, do NOT assign it to the wrong role — that employee will refuse the work.'

// :66
'- **Nobody hired for the job?** Build the workflow anyway: write the step with NO `employeeId` and `propose_graph` will save it, marked as needing an AI Employee. Then say which role they need to hire. Do NOT stop and ask whether to continue — the workflow they asked for is more useful to them than a question they cannot answer in this chat.'

// :84  (## Being honest)
'If a step needs an employee nobody has hired, still design it — then say so plainly in your summary. Never quietly drop a step, and never imply the workflow is ready to run when part of it is not.'
```

So: **the model is instructed to name the role to hire, and it does so as chat prose.**

### 6.3 Is it surfaced as an actionable "Hire X" affordance? **NO — prose only.**

Grep for `hire|Hire|/employees` across `apps/web/src/features/assist/**` returns exactly one hit, and
it is inside a test fixture: `__tests__/useAssistStream.test.ts:131`
(`{ name: 'list_employees', summary: 'Read 1 employee', ok: true }`).

Component inventory of `apps/web/src/features/assist/components/`: `AssistChat.tsx`,
`AssistBusyOverlay.tsx`, `SkillRequirementCard.tsx`, `TestResultPanel.tsx`, `AssistMessage.tsx`,
`AssistStageRail.tsx`. **No hire CTA in any of them.**

This is a genuinely sharp asymmetry, and the strongest single argument for the work being planned:

| Missing thing | Server signal | UI affordance |
|---|---|---|
| A skill | `request_connection` write tool + `connection` stream event | ✅ `SkillRequirementCard` — in-chat, live-polling, OAuth round-trip, auto-resume |
| An employee | `list_employees`' `note` string | ❌ prose in the assistant's message |

The same gap repeats downstream of Assist:
- `features/workflows/deriveEmployees.ts:69-75` computes `hasUnassignedEmployeeStep()`, and
  `WorkflowRow.tsx:95` renders it as a dead-end text badge: `{needsEmployee ? 'Needs an employee' : 'Automated'}` — no link.
- `TemplateInstallForm.tsx:160-163` says `No eligible AI Employees yet — hire one for this role first.` — no link.
- The readiness contract has **no hire fix kind** — `packages/types/src/index.ts:1402-1406`:

```ts
export interface WorkflowReadinessFix {
  kind: 'CONNECT_SKILL' | 'OPEN_NODE' | 'OPEN_TRIGGER';
  /** Skill key for CONNECT_SKILL, node id for OPEN_NODE; absent for OPEN_TRIGGER. */
  target?: string;
}
```

…and `ReviewPublishDialog.tsx:338-346` only knows how to render `CONNECT_SKILL` → `<Link href="/skills">Connect it</Link>`
and `OPEN_NODE`. Adding a `HIRE_EMPLOYEE` fix kind is a small, well-precedented change.

---

## 7. Plan / upgrade messaging when a hire is refused

### 7.1 Server side — two different codes, two different bodies

**`POST /employees` → 403 `ForbiddenException`.** `employees.service.ts:105-112`:

```ts
const roster = await tx.aiEmployee.findMany({
  where: { companyId, archivedAt: null },
  select: { role: true, status: true },
});
const seat = checkSeatFor(plan, roster, dto.role);
if (seat.reason) {
  throw new ForbiddenException(seatRefusal(plan, dto.role, seat.reason, seat));
}
```

The message is deliberately written for a human — `employees.service.ts:573-604`:

```ts
/**
 * The refusal a customer reads. Says which rule, what they have, and the two
 * ways out (upgrade, or retire someone) — never just "limit reached".
 */
…
    case 'TOTAL':
      return (
        `Your plan includes ${total} AI employee${total === 1 ? '' : 's'} and all ${seat.total} seats are taken. ` +
        'Upgrade your plan, or retire an employee to hire another.'
      );
    case 'PER_ROLE':
      return (
        `Your plan includes ${perRole} ${label} employee${perRole === 1 ? '' : 's'} and you already have ${seat.inRole}. ` +
        'Upgrade for more per role, or retire one to hire another.'
      );
    case 'NEW_ROLE':
      return (
        `Your plan includes ${roles} role${roles === 1 ? '' : 's'} and you already use ${seat.rolesUsed}. ` +
        `Adding ${label} would be a new role — upgrade your plan, or retire every employee in a role you no longer need.`
      );
```

There is also a **subscription-status 403 before the seat check** (`:87-92`) — worth knowing it exists,
because a `PAST_DUE` tenant gets a *different* 403 the UI treats identically.

**`POST /onboarding/complete` → 422, ONE for the whole selection. CONFIRMED.**
`onboarding.service.ts:343-380` — the comment states the intent and the code delivers it:

```ts
// Role-based hiring (2026-09-04): check the WHOLE selection against the
// plan before hiring anyone, so a wizard that picked one role too many gets
// a single 422 naming the problem instead of two employees hired and a
// third refused half-way — a partial onboarding is worse than a refused one.
// The per-hire check inside EmployeesService.create still runs (it is the
// race-safe one); this is the friendly pre-flight in front of it.
…
const problems: string[] = [];
for (const entry of dto.employees) {
  if (alreadyHired.has(entry.role)) continue;
  const seat = checkSeatFor(plan, simulated, entry.role);
  if (seat.reason) {
    problems.push(
      seat.reason === 'NEW_ROLE'
        ? `${entry.role} would be role ${seat.rolesUsed + 1} — your plan includes ${maxRolesFor(plan)}`
        : seat.reason === 'PER_ROLE'
          ? `${entry.role}: your plan includes ${maxPerRoleFor(plan)} per role`
          : `${entry.role}: all ${maxEmployeesFor(plan)} seats would be taken`,
    );
    continue;
  }
  simulated.push({ role: entry.role, status: 'ACTIVE' });
}
if (problems.length > 0) {
  throw new UnprocessableEntityException({
    message:
      `Your ${PLAN_CATALOG[plan].name} plan cannot hire this selection: ${problems.join('; ')}. ` +
      'Remove a role, or upgrade your plan.',
    problems,
  });
}
```

Note the 422 body carries a **structured `problems: string[]`** alongside `message` — no frontend
reads it.

### 7.2 Client side — the hire form is good; the wizard and marketplace are not

**`EmployeeForm` — IMPLEMENTED, with an upgrade CTA.** Three separate affordances:

1. Pre-emptive per-role greying + reason + Upgrade link (`:104-111`, quoted in §2.1).
2. An all-seats banner with a real link (`:62-70`):

```tsx
{allSeatsTaken && (
  <p className="mb-4 rounded-xl bg-status-warning/10 px-4 py-3 text-sm text-sl-warning">
    All {seats.max} seats on your plan are taken. Retire an employee to free one, or{' '}
    <Link href="/billing#plans" className="font-semibold underline underline-offset-2">
      upgrade your plan
    </Link>
    .
  </p>
)}
```

3. The server message as a fallback (`:131-135`):

```tsx
{create.isError && (
  <p className="text-sm text-red-600">
    {create.error?.message ?? 'Could not create employee'}
  </p>
)}
```

The `/billing#plans` anchor is real (`app/(app)/billing/page.tsx:59` `<section id="plans">`), and
`PlanCatalog.tsx:51-63` states the whole rule (`N AI employees - any R roles, M each` +
`Up to X credits per employee / month`), so the upgrade path is genuinely complete.

🔴 **`OnboardingWizard` — BROKEN: the 422 is never shown to anyone.**
`OnboardingWizard.tsx:147-158`:

```ts
const finish = async () => {
  await saveDepartments.mutateAsync(departments);
  await complete.mutateAsync({
    business: { industry, size },
    departments,
    employees: roles.map((role) => ({ role: role as never })),
  });
  router.replace(canUseAssist ? '/assist' : '/dashboard');
};
```

`mutateAsync` **rejects** on a 422, inside an `async` click handler with **no try/catch**. Grep for
`isError|\.error|catch` across the whole `features/onboarding` directory: **zero matches.** There is no
error paragraph, no toast, no banner — `useCompleteOnboarding` (`hooks.ts:119-179`) only rolls back the
optimistic status. Observable behaviour: the button goes `Finishing…` → back to `Finish & …`, the page
does not navigate, and **nothing is said**. The carefully-written single 422 with its structured
`problems` array reaches the browser and is discarded, plus an unhandled promise rejection is logged
to the console. **No upgrade CTA in the wizard at all.**

Mitigating factor: `wouldExceed` (`:263-270`) usually prevents reaching this state — but only for the
two roles the wizard offers, and it is hand-rolled arithmetic rather than the shared rule, so any drift
lands the user in the silent path.

🔴 **Marketplace `EmployeeTemplateCard` — BROKEN, same class.** No `install.isError` render at all
(see §1.3). The 403 refusal is discarded. No upgrade CTA.

**Summary of §7:** one of three hire surfaces renders the server's refusal. The other two silently
swallow it.

---

## 8. Existing frontend tests for hiring

### 8.1 Vitest component/unit tests

Full inventory of `apps/web/src/**/*.test.*` (34 files). Relevant to hiring:

| File | What it proves | Hiring coverage |
|---|---|---|
| `features/product-context/__tests__/hooks.test.tsx` | 9 cases across `useHasArea` and `useEntitlements`: resolved/unresolved area, **defaults to TRUE while loading and on error**, plan reporting, locked-area + `requiresPlan`, "assumes included while loading, so a gated CTA is not briefly disabled" | ❌ **`useSeatAvailability()` has ZERO tests.** The hook the whole hire form depends on is untested. |
| `features/product-context/__tests__/invalidation.test.ts` | Source-reading drift guard: 32 named hooks across 8 files must invalidate `productContextKeys.all`. Explicitly lists `useCreateEmployee`, `useUpdateEmployee`, `useDeleteEmployee` (`:33-37`), `useInstallEmployeeTemplate` (`:38-40`), `useCompleteOnboarding` (`:53-58`) | ✅ proves cache freshness after a hire, in source, not behaviour |
| `features/onboarding/__tests__/hooks.test.tsx` | 2 cases on `useCompleteOnboarding`, incl. *"syncs the Zustand session store so the (app) layout guard stops seeing a stale onboardedAt"* (`:80`) | 🟡 proves the happy path only — **no 422 case** |
| `features/employees/employee-settings-schema.test.ts` | the post-hire settings zod schema | ❌ not hiring |
| `features/employees/components/ChatPanel.test.tsx` | chat rendering | ❌ not hiring |
| `features/workflows/__tests__/deriveEmployees.test.ts` | `deriveEmployees` + `hasUnassignedEmployeeStep` (5 cases) | 🟡 the workflow→employee direction only |
| `features/assist/__tests__/skillRequirementCard.test.tsx` | 5 cases: installed-but-not-connected copy, deep-link to the specific skill, auto-resume on connect, **does NOT resume an old card on reopen**, resumes at most once | ❌ skills, not hiring — **but it is the template to copy for a hire card** |

**No test file exists for `EmployeeForm`, `SeatSummary`, `EmployeeCard`, `EmployeeList`,
`OnboardingWizard`, or `EmployeeTemplateList`.**

### 8.2 Playwright specs (7 files in `e2e/tests/`)

| Spec | Hiring relevance |
|---|---|
| `01-auth-journey.spec.ts` | signup/login/verify — the prerequisite |
| `02-security-journey.spec.ts` | RBAC/area gating |
| `03-golden-journey.spec.ts` | **hires via the API** (`:60-65`), then asserts the roster in the browser (`:67-74`). Explicitly documents the split at `:25-34`: *"the stages the DoD names as browser proof are clicked… Graph authoring is done through the API on purpose."* So the golden journey proves the roster *renders* a hire, not that the *form* works. |
| `04-tenant-isolation-journey.spec.ts` | cross-tenant employee reads/writes (API), then `/employees` renders (`:175`) |
| `05-failure-journeys.spec.ts` | employee + skill assignment via API |
| **`06-plan-seats-journey.spec.ts`** | **the one real hiring browser test** — see below |

`06-plan-seats-journey.spec.ts` (106 lines, single test, `test.setTimeout(150_000)`) proves, in order:
1. `1 of 2 seats` renders after onboarding hires one SUPPORT (`:39`).
2. `option[value="SUPPORT"]` is **disabled** and reads `/1 of 1/`; `option[value="HR"]` is enabled (`:42-44`).
3. The Hire button is enabled for an open role (`:49`).
4. **A real hire through the real form** — fills `input#name`, clicks `Hire employee`, asserts the new name appears (`:52-54`). ← the only browser proof the hire form works.
5. `2 of 2 seats` **without a reload** (`:57`) — this is the assertion that caught the product-context cache bug.
6. The all-seats banner, the disabled button, and the `upgrade your plan` link (`:58-63`).
7. The server backstop: `POST /employees` → **403** matching `/seats are taken/i` (`:66-71`).
8. Disabling an employee frees a seat, visible after `page.reload()` (`:78-85`).
9. `/billing` states `any 2 roles, 1 each`, `500 credits per employee`, `Growth`, `$40` (`:88-94`).
10. The employee's own Settings tab shows `up to $5 on your plan` and `500 credits per employee per month` (`:100-104`).

**What no Playwright spec proves:** the onboarding wizard driven through the browser (every spec uses
the `completeOnboarding` API helper instead), the marketplace hire, the 422 selection refusal, or any
post-hire setup sequence.

### 8.3 The harness pattern an implementer must follow

**Config:** `e2e/playwright.config.ts` — `workers: 1`, `fullyParallel: false` (`:30-31`, because the
journeys share one DB), `timeout: 120_000`, `globalSetup: './global-setup.ts'`, `retries: CI ? 1 : 0`,
and a two-entry `webServer` array that starts the real API + real web with pinned providers
(`MAIL_ENABLED=false`, `LLM_PROVIDER=mock`, `SKILL_EXECUTOR=mock`, `BILLING_PROVIDER=mock`,
`EMBEDDINGS_PROVIDER=hash`, `STORAGE_PROVIDER=local`, `AUTH_THROTTLE_LIMIT=1000` — `:68-95`).

**Helpers:** `e2e/tests/support/app.ts` (189 lines) exports `unique`, `signUpThroughUi`,
`verifyEmailThroughUi`, `logInThroughUi`, `apiLogin`, `authHeaders`, `apiPost`, `apiGet`,
`completeOnboarding`.

**The rule that governs which half goes through the browser** (`support/app.ts:94-103`, verbatim — quote
this in any new spec's header):

```ts
/**
 * An API client for SETUP and ASSERTION only — never for the behaviour a test
 * is about.
 *
 * Building a department hierarchy or a second admin through the UI would make
 * every journey a 60-step click-through that fails for reasons unrelated to what
 * it is testing. The rule this file follows: the thing under test goes through
 * the browser; the scaffolding around it, and the verification of server state
 * afterwards, may use the API.
 */
```

**The opening pattern every spec uses, verbatim from `06-plan-seats-journey.spec.ts:26-39`:**

```ts
test('the hire form greys the full role, then all seats, and billing shows the rule', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const { email, password } = await signUpThroughUi(page, 'seats');
  await verifyEmailThroughUi(page);
  const owner = await apiLogin(request, email, password);
  await completeOnboarding(request, owner.accessToken); // hires 1 SUPPORT

  await page.goto('/employees');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/1 of 2 seats/).first()).toBeVisible({ timeout: 30_000 });
```

Three non-obvious conventions to copy:
- **Always `.first()` + an explicit `{ timeout: 30_000 }`** on a text assertion. The reason is
  documented at `03-golden-journey.spec.ts:68-70`: *"An auto-retrying assertion, not a one-shot
  innerText snapshot: the list is fetched client-side and `networkidle` can settle before the query
  does."*
- **Assert the server backstop too**, with the comment convention from `06:65`:
  `// The server agrees — hidden is not a control, so prove the backstop too.`
- ⚠️ Two operational traps from `platform/CLAUDE.md`: `reuseExistingServer` means a dev server you
  started yourself skips Playwright's env overrides (→ 429s on the auth limiter), and
  `e2e/test-results/` is tracked — `git checkout -- e2e/test-results/` after every run.

⚠️ **UNDETERMINED:** whether `06-plan-seats-journey.spec.ts` currently passes. `00-FINAL-REPORT.md`
§35 records 13/14 at measurement time with this spec as the one failure (the product-context cache
bug), and that bug has since been fixed but **the spec has not been re-run**. Do not treat 14/14 as
proven.

---

## REAL GAPS vs ALREADY DONE

### REAL GAPS — must be built

1. **There is no guided hiring flow, at all.** No component sequences role → capabilities →
   connections → workflows → review. All three hire paths are single-shot forms collecting
   `name`/`role`/`persona` only (§1, §2).
2. **No employee readiness concept exists anywhere.** `EmployeeStatus` is a 3-value Prisma enum
   (`schema.prisma:53-57`); nothing can express "PENDING_SETUP". The UI renders the raw token in caps.
   A zero-skill, zero-connection employee shows the same green `ACTIVE` pill as a fully-configured one
   (§4).
3. **No Workflows tab, and no API to build one on.** `workflowsReferencing` is `private`
   (`employees.service.ts:300-323`), returns ids only, and `employees.controller.ts` has no
   `:id/workflows` route. `GET /workflows/runs` has no `employeeId` filter (§3).
4. **No "Hire X" affordance anywhere in the product.** AI Assist tells the user which role to hire in
   prose only (`assist-prompt.ts:66`); `WorkflowRow.tsx:95` and `TemplateInstallForm.tsx:162` both
   dead-end; `WorkflowReadinessFix.kind` has no `HIRE_EMPLOYEE` member (`types:1402-1406`) (§6).
5. **The onboarding 422 is never rendered.** `OnboardingWizard.finish()` (`:147-158`) awaits
   `mutateAsync` with no try/catch and the feature has zero error UI (grep: 0 hits for
   `isError|.error|catch` in `features/onboarding`). The structured `problems[]` array is discarded (§7).
6. **The marketplace hire silently swallows the 403.** `EmployeeTemplateCard` renders no
   `install.isError` branch (`EmployeeTemplateList.tsx:12-80`), so a seat refusal produces no message
   and no upgrade CTA (§1.3, §7).
7. **Per-employee connection is OAuth-only.** `EmployeeSkillPicker.tsx:73-77` filters
   `def.connection?.type === 'oauth'`, so no `api_key` skill (incl. WhatsApp, Slack) can be connected
   from the employee context (§5).
8. **OAuth cannot return to the employee page.** `RETURN_TO_PREFIXES = ['/assist/', '/workflows/']`
   (`oauth.service.ts:34`) rejects `/employees/…`, and `ConnectSkillControl.tsx:40` passes no
   `returnTo` anyway — so connecting "just for me" dumps the user on `/skills` (§5.2).
9. **No per-employee Approvals / Usage / Activity view.** `GET /approvals` takes `status` +
   `assignedToMe` only; `/analytics/employees` and `/analytics/activity` are company-wide (though both
   DTOs carry `employeeId`, so client-side filtering is viable) (§3).
10. **No tests for the hiring UI.** `useSeatAvailability()`, `EmployeeForm`, `SeatSummary`,
    `OnboardingWizard` and `EmployeeTemplateList` all have zero vitest coverage; only
    `06-plan-seats-journey.spec.ts` drives the hire form in a browser, and the wizard is never driven
    through the browser by any spec (§8).
11. **The marketplace card ignores seat availability entirely** — it never calls
    `useSeatAvailability()`, so it offers Install on roles the server will refuse (§1.3).
12. **The onboarding wizard can hire only 2 of 8 roles**, from a hardcoded `ROLES` array
    (`OnboardingWizard.tsx:31`) — a fifth independent employee catalog on top of the four
    `00-FINAL-REPORT.md` §31-34 already names (§1.2).
13. **⚠️ Latent:** `SkillSetupWizard.tsx:206-209`'s *"your settings are saved and this skill is ready
    to use"* is currently unreachable from the employee context, but reusing that wizard in a hiring
    flow makes it reachable. Fix before reuse (§5.4).

### ALREADY DONE — assemble, do not rebuild

1. **Role-based seat gating, end to end.** `checkSeatFor()` (one pure rule) →
   `EmployeesService.create()` inside an advisory-locked tx → `useSeatAvailability()` →
   `EmployeeForm`'s per-`<option>` `disabled` + reason + Upgrade link. `00-FINAL-REPORT.md` §42 lists
   `checkSeatFor()` on the do-not-touch list.
2. **`SeatSummary` + the roster header.** `2 of 4 seats · HR 2/2 · Marketing 0/2 · 2 of 2 roles`,
   Enterprise-safe (`return null` when `max === null`).
3. **The upgrade CTA and its destination.** `/billing#plans` exists (`billing/page.tsx:59`), and
   `PlanCatalog.tsx:51-63` states roles × per-role × credits-per-employee.
4. **Server refusal copy.** `seatRefusal()` (`employees.service.ts:573-604`) and the onboarding 422 are
   both written for a human and name both exits (upgrade / retire). Surface them; don't reword them.
5. **Product-context cache freshness after a hire.** All 4 hire/lifecycle mutations invalidate
   `productContextKeys.all`, pinned by a 32-case source-reading drift guard
   (`product-context/__tests__/invalidation.test.ts`). Any new hire mutation must be added to both.
6. **The 6-tab employee detail page**, all six real, no hardcoded data.
7. **`EmployeeSkillPicker`** — per-employee assign/unassign + "connect just for me" + the
   "Not connected yet — actions will fail" warning + the "connecting ≠ assigning" explainer
   (`:83-92`). The only readiness copy in the product; a good seed.
8. **The 10-state connection projection + its label map.** `SkillRequirementStatus`
   (`types:1092-1102`) and `STATUS_META` (`SkillRequirementCard.tsx:292-304`) already cover
   PENDING/EXPIRED/REVOKED/etc. Export and reuse rather than inventing a fifth status vocabulary.
9. **`SkillRequirementCard` as the interaction template** — sequential rows, live 4s poll that stops
   when ready, `refetchOnWindowFocus` exception, edge-triggered auto-resume guarded three ways, and
   5 vitest cases proving it. This is exactly the shape a hiring flow's connection step needs.
10. **AI Assist's read-only, role-matched employee lookup** and its honest "tell them which role to
    hire" prompt discipline (`assist-prompt.ts:61,66,84`). The prose is already correct; only the
    affordance is missing.
11. **Onboarding step chrome** — `OnboardingShell` + `IconField`/`ToggleCard`, already
    step-numbered and resumable server-side (`PATCH /onboarding/*` per step).
12. **`Modal.tsx`** — shared focus-trapped dialog, 6 consumers, Esc + backdrop + scroll lock.
13. **The Playwright harness** — `support/app.ts` + the config's real-stack `webServer` with pinned
    providers, and `06-plan-seats-journey.spec.ts` as a working precedent for a seat/hire journey.

---

## Smallest honest path to the target flow

Ordered by "most truth per line of code". Each step names what is genuinely new vs assembled.

**Step 1 — Stop lying about readiness (smallest, highest value).** Add one pure client function,
`features/employees/readiness.ts`, computing a derived state from data the client **already has**:
`useEmployeeSkills(id)` + `useInstalledSkills()` + `useDocuments(role)` + the `AiEmployeeDto`. Render it
as a second pill beside `STATUS_STYLES[status]` on `EmployeeCard` and the detail header ("Needs setup —
no skills assigned", "Gmail not connected"). **New:** the pure function + the pill. **Assembled:** every
input, all four hooks, the existing badge markup. **No backend, no migration, no enum change.**
This alone closes gap #2's user-visible half without touching `EmployeeStatus`.

**Step 2 — Make refusals visible (3 small edits).** Add an `install.isError` paragraph to
`EmployeeTemplateCard` copying `EmployeeForm.tsx:131-135` verbatim; add a `complete.isError` paragraph +
`/billing#plans` link to `OnboardingWizard` step 4; call `useSeatAvailability()` in the marketplace card
to disable Install on blocked roles. **New:** nothing conceptual. **Assembled:** the hire form's existing
error paragraph and upgrade banner.

**Step 3 — The guided flow, as a sequence over existing panels.** A `HireEmployeeWizard` inside
`Modal.tsx`, four steps, each step being a component that already exists:
- *Role* → the `EmployeeForm` role `<select>` logic (or `ToggleCard`s) + `reasonBlocked()`. Assembled.
- *Identity* → `name` + `persona` + `model`. Assembled.
- *Capabilities* → `EmployeeSkillPicker`, called with the just-created employee id. Assembled — but
  needs the flow to create the employee **before** this step, because assign/connect both need a real
  id. That is the one real design constraint: hiring stays a single POST, and the "wizard" is a
  post-create guided setup. Say that out loud rather than pretending the POST got richer.
- *Review* → a summary built from the Step-1 readiness function. New, ~40 lines.

**Step 4 — Fix the connection step's two real blockers.** Add `'/employees/'` to
`RETURN_TO_PREFIXES` (`oauth.service.ts:34`) and pass `returnTo` from `ConnectSkillControl`
(mirroring `SkillRequirementCard.tsx:193`). Then either (a) accept OAuth-only for the guided flow and
say so, or (b) widen `connectableForEmployee` (`EmployeeSkillPicker.tsx:73-77`) to `api_key` — which
drags in the WhatsApp "connection lives elsewhere" problem (`verify-06` §4) and the
`SkillSetupWizard` "ready to use" copy. **Recommendation: (a) for the first cut**, with the api_key
case rendering a deep link `/skills?connect=<key>` exactly as `SkillRequirementCard.tsx:268-275`
already does.

**Step 5 — The Workflows tab and the Hire affordance (the only genuinely new backend work).**
`GET /employees/:id/workflows → WorkflowDto[]`, per `verify-06-frontend.md` §3.5 — reusing
`WorkflowDto`, no new DTO, and **it must run `this.authz.filter(actor, 'workflow:read', …)` the way
`WorkflowsService.list` (`workflows.service.ts:230-259`) does**, or it re-opens the WAVE-2 leak that
method's own comment describes. Then add `HIRE_EMPLOYEE` to `WorkflowReadinessFix.kind`
(`types:1403`) and one render branch in `ReviewPublishDialog.tsx:338` — which turns the dead-end
`'Needs an employee'` badge and Assist's prose into a real link.

**Explicitly NOT worth building:**
- A new `PENDING_SETUP` enum value + migration. Step 1 gets the whole user benefit with a derived
  client-side state; an enum needs a writer, a lifecycle, and a decision about whether a
  `PENDING_SETUP` employee may chat. Defer until someone asks for it.
- A second seat-gating rule, a second connection-status vocabulary, or a second employee catalog.
  All three already exist once and are correct (`checkSeatFor`, `SkillRequirementStatus`,
  `EMPLOYEE_TEMPLATES`).
- Re-scoping `WorkflowRun` by `actingEmployeeId`. It is display-only with zero queries
  (`00-FINAL-REPORT.md` §21-22); a runs-by-employee view needs an endpoint change that should be
  scoped deliberately, not smuggled into a hiring flow.

**⚠️ Undetermined / flagged for the implementer:**
- Whether `06-plan-seats-journey.spec.ts` passes today (§8.3).
- The `workflowsReferencing` vs `deriveEmployees` semantic mismatch (backend matches any occurrence of
  the id in the definition JSON; the frontend only looks at `AI_EMPLOYEE_STEP`/`AI_STEP`) — already
  flagged in `verify-06` §3.1 and still unresolved. Pick one rule.
- Whether `EmployeesModule` can reach `toWorkflowDto` + `AuthorizationService` without a cycle —
  `verify-06` §3.5 flagged this as not fully verified and I did not re-verify it either.
- Whether `workingHoursStart/End`, `timezone` and `language` affect the runtime. If they do not, a
  guided flow that *asks* for them makes an existing misleading setting more prominent.
