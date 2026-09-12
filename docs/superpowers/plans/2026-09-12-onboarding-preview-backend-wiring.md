# Onboarding-Preview Backend Wiring & State Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local mock `useReducer` state in `features/onboarding-flow/` (all 12 screens, currently in-memory only) with real backend calls and a small, honest state architecture — server truth in TanStack Query, wizard navigation in a persisted Zustand store, in-flight form input in RHF+Zod — so completing the wizard actually hires AI Employees, assigns real skills, connects real tools, uploads real knowledge, and installs real workflows.

**Architecture:** Three separate state mechanisms, each owning exactly one concern, matching this repo's established convention (`CLAUDE.md`: "Singletons both sides... one apiClient, one queryClient, one Zustand store"):
1. **TanStack Query** — everything that is server truth (company profile, plan/subscription, employee roster, skills catalog + installed skills, knowledge documents, workflow templates, readiness). Every hook this plan needs **already exists** in `features/{employees,skills,knowledge,workflows,billing,tenant,onboarding,product-context}/hooks.ts` — this plan wires screens to them, it does not invent new ones.
2. **A new persisted Zustand store** (`useOnboardingWizardStore`) — purely navigation/bookkeeping state that has no server home: which step you're on, which real employee id is "active" in the Configure Hub loop, the ordered list of employee ids the hub has created so far, and a local "has the wizard visited this employee" flag (distinct from server *readiness* — a fresh employee can be wizard-visited and still not be fully ready). Persisted to `sessionStorage` so a page refresh mid-wizard resumes instead of losing your place or re-hiring duplicates.
3. **React Hook Form + Zod** — in-flight text/select input before it's submitted (company form, the per-employee name/persona/language mini-form), matching the stack `CLAUDE.md` already declares (`rhf+zod`) and the pattern the *old* wired `/onboarding` wizard uses.

The 12-screen UI, its routing, and its visual design (built in earlier sessions) do not change. This plan only replaces what happens *inside* each screen's event handlers and *where* each screen reads its data from.

**Tech Stack:** Next.js App Router, TanStack Query v5, Zustand (persisted), React Hook Form + Zod, the shared `apiClient` (axios, `@/lib/apiClient`), NestJS + Prisma backend (unchanged — no backend code needs to be written; every endpoint this plan needs already exists, confirmed by direct inspection, one gap flagged in Task 14).

**Spec:** This document — no separate spec exists; the "Global Constraints" and per-task "Why" notes below serve as the spec, derived from direct inspection of `apps/api/src/modules/{onboarding,tenant,billing,employees,skills,knowledge,workflow-templates}` and `apps/web/src/features/{employees,skills,knowledge,workflows,billing,tenant,onboarding,product-context}`.

## Global Constraints

- **Reuse, never duplicate backend capability.** Every mutation in this plan calls an *existing* controller route via an *existing* frontend hook. If a task seems to need a new backend endpoint, stop and flag it rather than inventing a parallel path — `CLAUDE.md` is explicit that duplicate models/services are a real risk here (`AiEmployee` stays the one product abstraction).
- **Real `EmployeeRole` values only:** `'SUPPORT' | 'SALES' | 'RECRUITER' | 'HR' | 'ACCOUNTANT' | 'PROJECT_MANAGER' | 'CUSTOM' | 'MARKETING'` (`packages/types/src/index.ts:263-272`). The frontend mock currently has `OPERATIONS` instead of `RECRUITER` — this is a real mismatch, fixed in Task 2, not a naming preference.
- **Real skill catalog only:** `slack, email, stripe, github, http, gmail, hubspot, jira, calendar, gdrive, scheduling, postiz, marketing, chatwoot, plane, whatsapp, leads` (`apps/api/src/modules/skills/catalog.ts`). The frontend mock's `salesforce, pipedrive, linkedin, notion, clickup, canva, asana, zoom` do not exist server-side and must not be offered as real options once wired (Task 2, Task 10).
- **Knowledge scoping is per-`EmployeeRole`, not per-employee-id.** A document with `category = 'SALES'` is visible to *every* Sales AI employee in the company, not one specific hire. The current mock scopes by `employee.id`. This is a real product behavior, not just a technical detail — the UI copy must say so (Task 2, Task 12).
- **Every mutation hook already handles optimistic update + rollback + cache invalidation.** Task-level code should call `mutate()`/`mutateAsync()` and read `isPending`/`isError` — it must not re-implement optimistic logic already present in the hook.
- **`onMutate`/`onError`/`onSettled` TanStack Query pattern** is the house style (`CLAUDE.md`) — already present in every hook this plan touches; no new pattern is introduced.
- **Verification is integration-level, not unit-level, for this plan.** These are wizard screens wired to a real NestJS+Postgres backend; there is no existing component-test harness for them and adding one is out of scope for a wiring plan. Each task's verification step is `tsc --noEmit` (type safety) plus a concrete Playwright browser check against the real local stack (`docker compose up -d`, `pnpm dev`) — the same standard `CLAUDE.md` sets for this whole codebase ("Verify. Unit + API/E2E + browser Playwright... happy paths and failure/security paths both").

---

## File Structure

**New files:**
- `apps/web/src/features/onboarding-flow/wizardStore.ts` — the new Zustand nav store (replaces the nav-related slice of `state.tsx`).
- `apps/web/src/features/onboarding-flow/companySchema.ts` — Zod schema + RHF resolver for the Company step form.
- `apps/web/src/features/onboarding-flow/employeeConfigSchema.ts` — Zod schema for the Configure Hub's name/persona/language mini-form.
- `apps/web/src/features/onboarding-flow/skillIcons.ts` — `Record<string, IconComponent>` keyed by the *real* 17 skill keys (reusing icons already built in `brand-icons.tsx`; generic fallback for keys with no bespoke icon).

**Modified files (one per task, listed there):**
- `features/onboarding-flow/types.ts`, `mockData.ts` — data-model corrections (Task 2).
- `features/onboarding-flow/state.tsx` — **deleted** at the end (Task 15); superseded by `wizardStore.ts` + direct hook calls in each step.
- `features/onboarding-flow/components/FlowShell.tsx`, `BrandPanel.tsx`, `StepFooter.tsx`, `EmployeeTabs.tsx`, `EmployeeContextHeader.tsx` — read from the new store instead of `useOnboardingFlow()` (Task 3/4).
- `features/onboarding-flow/components/steps/*.tsx` (all 12) — wired one by one (Tasks 5–14).
- `features/onboarding-flow/OnboardingFlow.tsx` — drop `OnboardingFlowProvider` wrapper (Task 3).

**Untouched (reused as-is):** every file under `features/{employees,skills,knowledge,workflows,billing,tenant,onboarding,product-context}/` — this plan is a *consumer* of those, never a modifier.

---

### Task 1: Auth-gate the `/onboarding-preview` route

**Why:** Every hook this plan wires in gates on `Boolean(accessToken)` and every endpoint sits behind `JwtAuthGuard`. Today the route's own top comment says it "needs no session at all — every screen runs on local mock state." That stops being true the moment Task 5 lands, so the guard has to exist *before* any screen is wired, or every hook silently no-ops (`enabled: false`) and nothing appears to work, with no error to explain why.

Do **not** move this route under `(app)/` or reuse `(app)/layout.tsx`'s guard — that layout hard-redirects anyone whose `company.onboardedAt` is falsy to the literal path `/onboarding` (`app/(app)/layout.tsx:38`), which would immediately bounce this route away from itself. It also has no exemption for `/onboarding-preview` in its `onOnboarding` check. Give this route its own small guard instead.

A deliberate product decision embedded here: this guard does **not** redirect an already-onboarded company away from `/onboarding-preview` (unlike `(app)/onboarding`'s "onboarded + on /onboarding → /dashboard" rule). An onboarded company revisiting this page is hiring *more* employees later, which the Configure Hub already supports (it drives off however many roles are selected, not "first-time onboarding" specifically). Flag this decision to the user when reporting the task done — it's a real product call, not an implementation detail.

**Files:**
- Create: `apps/web/src/app/onboarding-preview/OnboardingPreviewAuthGate.tsx`
- Modify: `apps/web/src/app/onboarding-preview/page.tsx`

**Interfaces:**
- Consumes: `useSessionStore` (`@/stores/session.store`) — same store `(app)/layout.tsx` reads (`status`, `user`).
- Produces: `<OnboardingPreviewAuthGate>` wrapping `<OnboardingFlow />`, used by `page.tsx`.

- [ ] **Step 1: Write the guard component**

```tsx
// apps/web/src/app/onboarding-preview/OnboardingPreviewAuthGate.tsx
'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSessionStore } from '@/stores/session.store';

/**
 * Auth guard scoped to THIS route only — do not reuse (app)/layout.tsx's
 * guard here, it hard-redirects any non-onboarded session to the literal
 * path '/onboarding' with no exemption for this one. Guests go to /login;
 * everyone else (onboarded or not) sees the wizard, since re-visiting here
 * to hire more employees later is a supported use, not just first-run setup.
 */
export function OnboardingPreviewAuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const status = useSessionStore((s) => s.status);

  useEffect(() => {
    if (status === 'guest') {
      router.replace('/login?returnTo=/onboarding-preview');
    }
  }, [status, router]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#02030a] text-sm text-fg-muted">
        Loading your workspace…
      </div>
    );
  }
  if (status === 'guest') return null;
  return <>{children}</>;
}
```

- [ ] **Step 2: Wire it into the page**

```tsx
// apps/web/src/app/onboarding-preview/page.tsx
'use client';

import { OnboardingFlow } from '@/features/onboarding-flow/OnboardingFlow';
import { OnboardingPreviewAuthGate } from './OnboardingPreviewAuthGate';

export default function OnboardingPreviewPage() {
  return (
    <OnboardingPreviewAuthGate>
      <OnboardingFlow />
    </OnboardingPreviewAuthGate>
  );
}
```

Also update the file's doc-comment (currently says "needs no session at all") to state the new requirement plainly, so the next reader doesn't trust the stale claim.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 4: Browser verification**

With the dev stack up (`docker compose -f infra/docker-compose.yml up -d`, `pnpm dev` from `apps/api` and `apps/web`), open `/onboarding-preview` in a private/incognito window (no session) — expect a redirect to `/login?returnTo=/onboarding-preview`. Log in, navigate to `/onboarding-preview` again — expect the Welcome screen to render normally.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/onboarding-preview
git commit -m "feat(onboarding-preview): auth-gate the route ahead of backend wiring"
```

---

### Task 2: Fix frontend data-model mismatches against the real backend

**Why:** Three concrete mismatches exist between the mock catalog and the real backend, found by direct inspection. Wiring the UI to real hooks *before* fixing these would let a user pick a role that can't be created (`OPERATIONS`), a skill that can't be installed (`salesforce`, `pipedrive`, etc.), or believe knowledge is private to one hire when it's actually shared company-wide by role. Fix the data first so every later task wires against something real.

**Files:**
- Modify: `features/onboarding-flow/types.ts:61-69` (`EmployeeTemplateKey`), `:111-118` (`KnowledgeDoc`)
- Modify: `features/onboarding-flow/mockData.ts` (the `OPERATIONS` entry in `EMPLOYEE_TEMPLATES`; delete the static `SKILLS` array and `SKILL_CATEGORIES` — Task 10 sources these live)
- Create: `features/onboarding-flow/skillIcons.ts`

**Interfaces:**
- Produces: `EmployeeTemplateKey` now includes `'RECRUITER'` instead of `'OPERATIONS'`; `KnowledgeDoc.scope` is now typed `EmployeeRole` (imported from `@vaep/types`), not `string`; `SKILL_ICONS: Record<string, ElementType<{className?:string}>>` exported from the new `skillIcons.ts` for Task 10 to consume.

- [ ] **Step 1: Swap the `OPERATIONS` role for `RECRUITER`**

In `types.ts:61-69`:
```ts
export type EmployeeTemplateKey =
  | 'SALES'
  | 'SUPPORT'
  | 'MARKETING'
  | 'HR'
  | 'ACCOUNTANT'
  | 'RECRUITER'
  | 'PROJECT_MANAGER'
  | 'CUSTOM';
```

In `mockData.ts`, replace the `OPERATIONS` entry in `EMPLOYEE_TEMPLATES` (currently `key: 'OPERATIONS', name: 'Operations AI', ...`) with:
```ts
{
  key: 'RECRUITER',
  name: 'Recruiter AI',
  department: 'Recruiting',
  description: 'Source & screen candidates',
  icon: UserSearch, // from lucide-react — add to the import list
  colorClass: 'bg-cyan-500/15 text-cyan-400',
  avatarFrom: '#22D3EE',
  avatarTo: '#0891B2',
  defaultPersona: 'Organised, efficient, detail-oriented',
  suggestedSkillKeys: ['gmail', 'calendar', 'scheduling'],
  suggestedWorkflowKeys: ['candidate-screening', 'interview-scheduling'],
},
```
(Keeps the same cyan color/avatar slot the old `OPERATIONS` entry used — no visual churn, just a role/copy swap. `'scheduling'` is a real catalog key per `CATALOG_KEYS` above.)

- [ ] **Step 2: Retype `KnowledgeDoc.scope` to the real `EmployeeRole`**

In `types.ts:111-118`:
```ts
import type { EmployeeRole } from '@vaep/types';

export interface KnowledgeDoc {
  id: string;
  name: string;
  sizeLabel: string;
  /** `null` = shared company-wide; otherwise every employee of this ROLE
   * sees it (not one specific hire) — matches the real backend's
   * `KnowledgeDocument.category` semantics exactly. */
  scope: EmployeeRole | null;
  source: 'upload' | 'suggested' | 'text';
}
```
This is a breaking change to every current caller of `ADD_KNOWLEDGE_DOC`/`scope: 'shared'` — don't fix those callers here, Task 12 rewrites `KnowledgeStep.tsx` entirely and Task 15 deletes `state.tsx`. Leaving this type change to produce compile errors in between tasks is fine *within this plan's execution* (each task is reviewed before the next starts) but flag it if executing tasks out of order.

- [ ] **Step 3: Delete the static skill catalog, add the real-catalog icon map**

Delete `SKILLS` and `SKILL_CATEGORIES` from `mockData.ts` entirely (Task 10 replaces every reader with `useCatalog()`).

```ts
// features/onboarding-flow/skillIcons.ts
import { Mail, Globe, Megaphone, Calendar as CalendarLucide, Puzzle } from 'lucide-react';
import {
  GmailIcon, SlackIcon, HubSpotIcon, CalendarIcon, GoogleDriveIcon,
  StripeIcon, GitHubIcon, WhatsAppIcon,
} from '@/components/marketing-dark/brand-icons';
import type { ElementType } from 'react';

/** Real catalog keys only — see apps/api/src/modules/skills/catalog.ts.
 * Falls back to a generic icon for keys with no bespoke brand mark yet
 * (chatwoot, plane, marketing, scheduling, leads, http, email, jira). */
export const SKILL_ICONS: Record<string, ElementType<{ className?: string }>> = {
  gmail: GmailIcon,
  slack: SlackIcon,
  hubspot: HubSpotIcon,
  calendar: CalendarIcon,
  gdrive: GoogleDriveIcon,
  stripe: StripeIcon,
  github: GitHubIcon,
  whatsapp: WhatsAppIcon,
  postiz: Megaphone,
  marketing: Megaphone,
  scheduling: CalendarLucide,
  email: Mail,
  http: Globe,
  jira: Puzzle,
  chatwoot: Puzzle,
  plane: Puzzle,
  leads: Puzzle,
};

export function iconForSkill(key: string): ElementType<{ className?: string }> {
  return SKILL_ICONS[key] ?? Puzzle;
}
```

- [ ] **Step 4: Typecheck (expect errors — that's the point)**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: errors in `SkillsStep.tsx`, `ConnectionsStep.tsx`, `KnowledgeStep.tsx`, `state.tsx`, `mockData.ts` (anywhere still importing `SKILLS`/`SKILL_CATEGORIES` or using the old `scope: 'shared'`/`OPERATIONS`). This is expected — those callers are fixed in Tasks 6–15. Confirm the errors are *only* in those known files, not somewhere unrelated (which would mean a mismatch you didn't intend).

- [ ] **Step 5: Commit**

```bash
git add features/onboarding-flow/types.ts features/onboarding-flow/mockData.ts features/onboarding-flow/skillIcons.ts
git commit -m "fix(onboarding-flow): correct role/skill/knowledge-scope mismatches against real backend"
```

---

### Task 3: The wizard navigation store (Zustand, persisted)

**Why:** Once Company/Goals/Plan/Employee data lives in TanStack Query (server truth), the only thing left needing client state is "where am I in the wizard" — which step, which employee is active, which employees have been visited. This is real UI state with no server home, so it belongs in a Zustand store, not React Context+useReducer (Context re-renders every consumer on every change; Zustand subscribes per-selector, matching the `CLAUDE.md` "one Zustand store" convention already used elsewhere, e.g. `useSessionStore`). Persisting to `sessionStorage` means a refresh mid-wizard resumes at the same step/employee instead of losing your place — important once employees are being created for real as you go (Task 9), so a refresh must not re-create a duplicate.

**Files:**
- Create: `features/onboarding-flow/wizardStore.ts`
- Modify: `features/onboarding-flow/OnboardingFlow.tsx` — drop the `OnboardingFlowProvider` wrapper.

**Interfaces:**
- Produces:
  ```ts
  interface OnboardingWizardState {
    step: FlowStep;
    selectedTemplateKeys: EmployeeTemplateKey[];
    employeeOrder: string[];        // REAL AiEmployee ids, in hire order
    activeEmployeeId: string | null;
    visitedEmployeeIds: string[];   // wizard-local "has the hub moved past this one" — NOT server readiness
    errors: FieldErrors;
    goToStep: (step: FlowStep) => void;
    nextStep: () => void;
    prevStep: () => void;
    setActiveEmployee: (id: string) => void;
    toggleTemplateKey: (key: EmployeeTemplateKey) => void;
    pushEmployeeId: (id: string) => void;
    markVisited: (id: string) => void;
    setErrors: (errors: FieldErrors) => void;
    clearError: (field: string) => void;
    reset: () => void;
  }
  ```
- Consumes: `FLOW_STEPS` from `./types`.

- [ ] **Step 1: Write the store**

```ts
// features/onboarding-flow/wizardStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FLOW_STEPS, type EmployeeTemplateKey, type FieldErrors, type FlowStep } from './types';

interface OnboardingWizardState {
  step: FlowStep;
  selectedTemplateKeys: EmployeeTemplateKey[];
  employeeOrder: string[];
  activeEmployeeId: string | null;
  visitedEmployeeIds: string[];
  errors: FieldErrors;
  goToStep: (step: FlowStep) => void;
  nextStep: () => void;
  prevStep: () => void;
  setActiveEmployee: (id: string) => void;
  toggleTemplateKey: (key: EmployeeTemplateKey) => void;
  pushEmployeeId: (id: string) => void;
  markVisited: (id: string) => void;
  setErrors: (errors: FieldErrors) => void;
  clearError: (field: string) => void;
  reset: () => void;
}

const initial = {
  step: 'welcome' as FlowStep,
  selectedTemplateKeys: [] as EmployeeTemplateKey[],
  employeeOrder: [] as string[],
  activeEmployeeId: null as string | null,
  visitedEmployeeIds: [] as string[],
  errors: {} as FieldErrors,
};

export const useOnboardingWizardStore = create<OnboardingWizardState>()(
  persist(
    (set, get) => ({
      ...initial,
      goToStep: (step) => set({ step, errors: {} }),
      nextStep: () => {
        const idx = FLOW_STEPS.indexOf(get().step);
        set({ step: FLOW_STEPS[Math.min(idx + 1, FLOW_STEPS.length - 1)], errors: {} });
      },
      prevStep: () => {
        const idx = FLOW_STEPS.indexOf(get().step);
        set({ step: FLOW_STEPS[Math.max(idx - 1, 0)], errors: {} });
      },
      setActiveEmployee: (id) => set({ activeEmployeeId: id }),
      toggleTemplateKey: (key) =>
        set((s) => ({
          selectedTemplateKeys: s.selectedTemplateKeys.includes(key)
            ? s.selectedTemplateKeys.filter((k) => k !== key)
            : [...s.selectedTemplateKeys, key],
        })),
      pushEmployeeId: (id) =>
        set((s) => (s.employeeOrder.includes(id) ? s : { employeeOrder: [...s.employeeOrder, id] })),
      markVisited: (id) =>
        set((s) => (s.visitedEmployeeIds.includes(id) ? s : { visitedEmployeeIds: [...s.visitedEmployeeIds, id] })),
      setErrors: (errors) => set({ errors }),
      clearError: (field) =>
        set((s) => {
          if (!(field in s.errors)) return s;
          const errors = { ...s.errors };
          delete errors[field];
          return { errors };
        }),
      reset: () => set(initial),
    }),
    { name: 'onboarding-wizard', storage: undefined /* defaults to sessionStorage-safe localStorage; override below */ },
  ),
);
```

Note on storage: Zustand's `persist` defaults to `localStorage`. For a wizard that should not silently resume days later on a shared machine, override with `sessionStorage`:
```ts
import { createJSONStorage } from 'zustand/middleware';
// inside persist(...) options:
{ name: 'onboarding-wizard', storage: createJSONStorage(() => sessionStorage) }
```
Use this version, not the `storage: undefined` placeholder above.

- [ ] **Step 2: Drop the old provider from the flow root**

`OnboardingFlow.tsx` currently wraps `<OnboardingFlowSwitch />` in `<OnboardingFlowProvider>`. Remove that wrapper — the switch now reads `step` directly from the new store:

```tsx
function OnboardingFlowSwitch() {
  const step = useOnboardingWizardStore((s) => s.step);
  switch (step) { /* unchanged cases */ }
}

export function OnboardingFlow() {
  return <OnboardingFlowSwitch />;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: new errors in every file still calling `useOnboardingFlow()` — tracked and closed by Tasks 4–15, not fixed here.

- [ ] **Step 4: Commit**

```bash
git add features/onboarding-flow/wizardStore.ts features/onboarding-flow/OnboardingFlow.tsx
git commit -m "feat(onboarding-flow): add persisted Zustand wizard-nav store"
```

---

### Task 4: Repoint shared chrome (`FlowShell`, `BrandPanel`, `StepFooter`, `EmployeeTabs`, `EmployeeContextHeader`) at the new store

**Why:** These five files are the only ones that read *navigation* state (`step`, `FLOW_STEPS` position) without needing any server data — they can be fixed before any individual step screen, unblocking every later task's typecheck.

**Files:**
- Modify: `features/onboarding-flow/components/FlowShell.tsx` (uses `useOnboardingFlow()` for `state.step`, `state.company.name` — the company name now comes from `useCurrentCompany()`, wired properly in Task 5; for now, fall back to a static label here and let Task 5 replace it)
- Modify: `features/onboarding-flow/components/BrandPanel.tsx` (`step` prop already passed in — only its internal `FLOW_STEPS.indexOf` stays as-is, no `useOnboardingFlow()` call here to begin with per current code — confirm during execution and skip if so)
- Modify: `features/onboarding-flow/components/StepFooter.tsx` (purely presentational, takes callbacks as props — confirm it has no `useOnboardingFlow()` call; skip if so)
- Modify: `features/onboarding-flow/components/EmployeeTabs.tsx` — now reads the roster from `useEmployees()` (Task 9 dependency) instead of `state.employees`
- Modify: `features/onboarding-flow/components/EmployeeContextHeader.tsx` — takes `employee: AiEmployeeDto` prop instead of the mock `DraftEmployee`, and its "Edit Employee" button calls `useOnboardingWizardStore.getState().goToStep('configureEmployees')`

**Interfaces:**
- Consumes: `useOnboardingWizardStore` (Task 3), `useEmployees()` / `AiEmployeeDto` (`@/features/employees/hooks`, `@vaep/types`).
- Produces: no change to any prop signature these components expose to their parents *except* `EmployeeContextHeader`'s `employee` prop type (now `AiEmployeeDto`), which Tasks 10–13 must pass correctly.

- [ ] **Step 1: `FlowShell.tsx`** — replace `const { state } = useOnboardingFlow();` and its `state.step` usage with `const step = useOnboardingWizardStore((s) => s.step);`. Temporarily hardcode the company-name badge to `'Your company'` — Task 5 wires the real value.

- [ ] **Step 2: `EmployeeTabs.tsx`** — replace the `state.employees` map with:
```tsx
import { useEmployees } from '@/features/employees/hooks';
import { useOnboardingWizardStore } from '../wizardStore';

export function EmployeeTabs() {
  const { data: employees = [] } = useEmployees();
  const wizardOrder = useOnboardingWizardStore((s) => s.employeeOrder);
  const activeId = useOnboardingWizardStore((s) => s.activeEmployeeId);
  const setActive = useOnboardingWizardStore((s) => s.setActiveEmployee);
  const ordered = wizardOrder
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));
  // ...render `ordered` instead of state.employees; onClick calls setActive(e.id)
}
```

- [ ] **Step 3: `EmployeeContextHeader.tsx`** — change the prop type to `{ employee: AiEmployeeDto }` (from `@vaep/types`), and the "Edit Employee" button:
```tsx
import { useOnboardingWizardStore } from '../wizardStore';
// ...
const goToStep = useOnboardingWizardStore((s) => s.goToStep);
// onClick={() => goToStep('configureEmployees')}
```
Its avatar lookup (`templateFor(employee.templateKey)`) changes to resolve template by matching `employee.role` against `EMPLOYEE_TEMPLATES` (add a `templateForRole(role: EmployeeRole)` helper in `mockData.ts` next to the existing `templateFor`).

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: errors now isolated to the 12 step files under `components/steps/` — every shared-chrome file compiles clean.

- [ ] **Step 5: Commit**

```bash
git add features/onboarding-flow/components/FlowShell.tsx features/onboarding-flow/components/EmployeeTabs.tsx features/onboarding-flow/components/EmployeeContextHeader.tsx features/onboarding-flow/mockData.ts
git commit -m "refactor(onboarding-flow): repoint shared chrome at wizard store + real employee roster"
```

---

### Task 5: Wire the Company step

**Files:**
- Modify: `features/onboarding-flow/components/steps/CompanyDetailsStep.tsx`
- Create: `features/onboarding-flow/companySchema.ts`
- Modify: `features/onboarding-flow/components/FlowShell.tsx` (replace the Task-4 placeholder company-name label with the real value)

**Interfaces:**
- Consumes: `useCurrentCompany()`, `useUpdateCompany()` (`@/features/tenant/hooks`), `UpdateCompanyDto` (`@vaep/types`).
- Produces: nothing new for other tasks — this is a leaf step.

- [ ] **Step 1: Zod schema**

```ts
// features/onboarding-flow/companySchema.ts
import { z } from 'zod';

export const companySchema = z.object({
  name: z.string().min(2, 'Company name is required.').max(120),
  industry: z.string().min(1, 'Choose an industry.').max(120),
  size: z.string().min(1, 'Choose a company size.').max(40),
  website: z
    .string()
    .max(200)
    .refine((v) => v === '' || /^https?:\/\/.+\..+/.test(v), 'Enter a full URL, e.g. https://acme.com')
    .optional(),
});
export type CompanyFormValues = z.infer<typeof companySchema>;
```

- [ ] **Step 2: Rewrite the step component**

```tsx
'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Building2, Globe, LayoutGrid, Users } from 'lucide-react';
import { IconField } from '@/components/onboarding/fields';
import { useCurrentCompany, useUpdateCompany } from '@/features/tenant/hooks';
import { COMPANY_SIZES, INDUSTRIES } from '../../mockData';
import { useOnboardingWizardStore } from '../../wizardStore';
import { companySchema, type CompanyFormValues } from '../../companySchema';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function CompanyDetailsStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const { data: company, isLoading } = useCurrentCompany();
  const updateCompany = useUpdateCompany();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CompanyFormValues>({
    resolver: zodResolver(companySchema),
    values: company
      ? { name: company.name, industry: company.industry ?? '', size: company.size ?? '', website: company.website ?? '' }
      : undefined,
  });

  const onSubmit = handleSubmit((values) => {
    updateCompany.mutate(values, { onSuccess: () => nextStep() });
  });

  if (isLoading) {
    return (
      <FlowShell heading="Tell us about your company">
        <p className="text-sm text-fg-muted">Loading…</p>
      </FlowShell>
    );
  }

  return (
    <FlowShell heading="Tell us about your company" subtitle="This helps us personalise your AI Employees.">
      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <IconField id="co-name" label="Company name" icon={<Building2 className="h-[18px] w-[18px]" />}>
            <input id="co-name" className="field-modern field-with-icon" autoFocus {...register('name')} placeholder="Acme Private Limited" aria-invalid={Boolean(errors.name)} />
          </IconField>
          {errors.name && <p className="mt-1.5 text-[13px] text-red-400">{errors.name.message}</p>}
        </div>

        <div>
          <IconField id="co-industry" label="Industry" icon={<LayoutGrid className="h-[18px] w-[18px]" />}>
            <select id="co-industry" className="field-modern field-with-icon" {...register('industry')} aria-invalid={Boolean(errors.industry)}>
              <option value="" disabled>Select an industry</option>
              {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </IconField>
          {errors.industry && <p className="mt-1.5 text-[13px] text-red-400">{errors.industry.message}</p>}
        </div>

        <div>
          <IconField id="co-size" label="Company size" icon={<Users className="h-[18px] w-[18px]" />}>
            <select id="co-size" className="field-modern field-with-icon" {...register('size')} aria-invalid={Boolean(errors.size)}>
              <option value="" disabled>Select a size</option>
              {COMPANY_SIZES.map((s) => <option key={s} value={s}>{s} employees</option>)}
            </select>
          </IconField>
          {errors.size && <p className="mt-1.5 text-[13px] text-red-400">{errors.size.message}</p>}
        </div>

        <div>
          <IconField id="co-website" label="Website" optional icon={<Globe className="h-[18px] w-[18px]" />}>
            <input id="co-website" className="field-modern field-with-icon" {...register('website')} placeholder="https://acme.com" aria-invalid={Boolean(errors.website)} />
          </IconField>
          {errors.website && <p className="mt-1.5 text-[13px] text-red-400">{errors.website.message}</p>}
        </div>

        <StepFooter onBack={prevStep} onContinue={onSubmit} continueDisabled={updateCompany.isPending} />
      </form>
    </FlowShell>
  );
}
```
Note `values:` (not `defaultValues:`) on `useForm` — RHF resets the form whenever `values` changes identity, which correctly repopulates once `useCurrentCompany()` resolves after a loading flash.

- [ ] **Step 3: Wire `FlowShell`'s company-name badge to the real value**

```tsx
// FlowShell.tsx
import { useCurrentCompany } from '@/features/tenant/hooks';
// ...
const { data: company } = useCurrentCompany();
const companyName = company?.name || 'Your company';
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 5: Browser verification**

Log in with a fresh test company, go to `/onboarding-preview`, click through to the Company step, submit a name/industry/size — confirm `PATCH /companies/current` fires in the Network tab (200), the wizard advances to Goals, and reloading the page later still shows the saved values (proves it round-trips through the real backend, not local state).

- [ ] **Step 6: Commit**

```bash
git add features/onboarding-flow/companySchema.ts features/onboarding-flow/components/steps/CompanyDetailsStep.tsx features/onboarding-flow/components/FlowShell.tsx
git commit -m "feat(onboarding-flow): wire Company step to PATCH /companies/current"
```

---

### Task 6: Wire the Goals step

**Why:** `useSaveOnboardingGoals()` already exists in the *old* wired wizard's hooks (`features/onboarding/hooks.ts:88`) and hits the real `PATCH /onboarding/goals`. Reuse it verbatim — do not write a second goals-saving hook.

**Files:**
- Modify: `features/onboarding-flow/components/steps/GoalsStep.tsx`

**Interfaces:**
- Consumes: `useSaveOnboardingGoals()` (`@/features/onboarding/hooks`), `useOnboardingStatus()` (same file) to read back any goals already saved (so the step is pre-checked on revisit, matching Company's `values:` pattern in Task 5).

- [ ] **Step 1: Rewrite**

```tsx
'use client';

import { useState, useEffect } from 'react';
import { useOnboardingStatus, useSaveOnboardingGoals } from '@/features/onboarding/hooks';
import { GOALS } from '../../mockData';
import { useOnboardingWizardStore } from '../../wizardStore';
import { CardCheckbox } from '../CardCheckbox';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function GoalsStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const setErrors = useOnboardingWizardStore((s) => s.setErrors);
  const errors = useOnboardingWizardStore((s) => s.errors);
  const clearError = useOnboardingWizardStore((s) => s.clearError);

  const { data: status } = useOnboardingStatus();
  const saveGoals = useSaveOnboardingGoals();
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (status?.goals) setSelected(status.goals);
  }, [status?.goals]);

  const toggle = (key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((g) => g !== key) : [...prev, key]));
    clearError('goals');
  };

  const onContinue = () => {
    if (selected.length === 0) {
      setErrors({ goals: 'Choose at least one goal so we can tailor your setup.' });
      return;
    }
    saveGoals.mutate({ goals: selected }, { onSuccess: () => nextStep() });
  };

  return (
    <FlowShell heading="What are your main goals?" subtitle="Select all that apply.">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {GOALS.map((goal) => {
          const isSelected = selected.includes(goal.key);
          return (
            <button
              key={goal.key}
              type="button"
              onClick={() => toggle(goal.key)}
              aria-pressed={isSelected}
              className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-4 text-left text-sm font-medium transition-colors ${
                isSelected ? 'border-violet-secondary/60 bg-violet/[0.1] text-white' : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16]'
              }`}
            >
              {goal.label}
              <CardCheckbox checked={isSelected} className="mt-0.5" />
            </button>
          );
        })}
      </div>
      {errors.goals && <p className="mt-3 text-[13px] text-red-400">{errors.goals}</p>}
      <StepFooter onBack={prevStep} onContinue={onContinue} continueDisabled={saveGoals.isPending} />
    </FlowShell>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 3: Browser verification**

Select two goals, continue, go Back, confirm the same two goals are still checked (proves the round-trip through `GET /onboarding/status` → local `selected` state works, not just the write).

- [ ] **Step 4: Commit**

```bash
git add features/onboarding-flow/components/steps/GoalsStep.tsx
git commit -m "feat(onboarding-flow): wire Goals step to PATCH /onboarding/goals"
```

---

### Task 7: Wire the Plan step

**Files:**
- Modify: `features/onboarding-flow/components/steps/PlanStep.tsx`

**Interfaces:**
- Consumes: `usePlans()`, `useSubscription()`, `useChangePlan()` (`@/features/billing/hooks`), `PlanDto`, `SubscriptionDto` (`@vaep/types`).

- [ ] **Step 1: Rewrite the plan-card grid to read from `usePlans()`**

Replace the import of the mock `PLANS`/`PLAN_PRICING_NOTE` with:
```tsx
import { usePlans, useSubscription, useChangePlan } from '@/features/billing/hooks';
// ...
const { data: plans = [] } = usePlans();
const { data: subscription } = useSubscription();
const changePlan = useChangePlan();
const currentPlan = subscription?.plan;
```
Map `plans` (`PlanDto[]`: `{plan, name, priceMonthlyUsd, maxRoles, maxPerRole, maxEmployees, features}`) onto the existing 4-card layout — field names differ slightly from the mock (`priceMonthlyUsd` not `priceMonthly`, `name` not `displayName`) but the JSX structure is unchanged, only the data source and field names change.

- [ ] **Step 2: Wire "Select" to the real mutation**

```tsx
const onSelectPlan = (plan: PlanDto['plan']) => {
  changePlan.mutate({ plan }, {
    onSuccess: (data) => {
      // useChangePlan already redirects the browser for Stripe checkout
      // (data.checkoutUrl) internally — see billing/hooks.ts. Nothing extra
      // to do here for that path.
      if (!data.checkoutUrl) nextStep();
    },
  });
};
```
`nextStep` comes from `useOnboardingWizardStore((s) => s.nextStep)`.

Remove the local `billingCycle` monthly/yearly toggle's write-through entirely — there is no server concept of billing cycle in `ChangePlanDto`; keep it as pure local `useState` for price-display only (it was already local-only in the mock, this doesn't change).

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 4: Browser verification**

Select "Growth" — confirm `POST /billing/subscription` fires (200), `GET /billing/subscription` on next load reflects `BUSINESS`, wizard advances.

- [ ] **Step 5: Commit**

```bash
git add features/onboarding-flow/components/steps/PlanStep.tsx
git commit -m "feat(onboarding-flow): wire Plan step to real billing subscription"
```

---

### Task 8: Wire the Select Employees step (live seat limits)

**Why:** The mock's `atRoleLimit` only compares `selectedTemplateKeys.length` against `plan.maxRoles`, ignoring `maxPerRole` and the roster the company *already* has from a previous visit to this wizard. `useSeatAvailability().reasonBlocked(role)` (`features/product-context/hooks.ts:133`) already implements the exact real rule `EmployeesService.create()` enforces server-side — its own doc-comment says it exists precisely so "the hire form and the onboarding wizard grey a role from this." Use it instead of re-deriving the arithmetic.

**Files:**
- Modify: `features/onboarding-flow/components/steps/SelectEmployeesStep.tsx`

**Interfaces:**
- Consumes: `useSeatAvailability()` (`@/features/product-context/hooks`), `useOnboardingWizardStore` (`selectedTemplateKeys`, `toggleTemplateKey`).

- [ ] **Step 1: Rewrite**

```tsx
'use client';

import { EMPLOYEE_TEMPLATES } from '../../mockData';
import { useSeatAvailability } from '@/features/product-context/hooks';
import { useOnboardingWizardStore } from '../../wizardStore';
import { CardCheckbox } from '../CardCheckbox';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function SelectEmployeesStep() {
  const selectedTemplateKeys = useOnboardingWizardStore((s) => s.selectedTemplateKeys);
  const toggleTemplateKey = useOnboardingWizardStore((s) => s.toggleTemplateKey);
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const setErrors = useOnboardingWizardStore((s) => s.setErrors);
  const errors = useOnboardingWizardStore((s) => s.errors);
  const clearError = useOnboardingWizardStore((s) => s.clearError);
  const { reasonBlocked } = useSeatAvailability();

  const onContinue = () => {
    if (selectedTemplateKeys.length === 0) {
      setErrors({ employees: 'Select at least one AI Employee to continue.' });
      return;
    }
    nextStep();
  };

  return (
    <FlowShell heading="Which AI Employees do you want to hire?" subtitle="You can select multiple. Configure them next." wide>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {EMPLOYEE_TEMPLATES.map((template) => {
          const selected = selectedTemplateKeys.includes(template.key);
          const blockedReason = selected ? null : reasonBlocked(template.key);
          const disabled = Boolean(blockedReason);
          return (
            <button
              key={template.key}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => { toggleTemplateKey(template.key); clearError('employees'); }}
              className={`relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${disabled ? 'cursor-not-allowed opacity-40' : ''} ${selected ? 'border-violet-secondary/60 bg-violet/[0.1]' : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]'}`}
              title={blockedReason ?? undefined}
            >
              <CardCheckbox checked={selected} className="absolute right-3 top-3" />
              <EmployeeAvatar template={template} />
              <p className="text-sm font-semibold text-white">{template.name}</p>
              <p className="text-xs text-fg-muted">{template.description}</p>
              {blockedReason && <p className="text-[11px] text-amber-400">{blockedReason}</p>}
            </button>
          );
        })}
      </div>
      {errors.employees && <p className="mt-3 text-[13px] text-red-400">{errors.employees}</p>}
      <p className="mt-4 text-sm text-fg-muted">{selectedTemplateKeys.length} selected</p>
      <StepFooter onBack={prevStep} onContinue={onContinue} />
    </FlowShell>
  );
}
```
Note: `EMPLOYEE_TEMPLATES` no longer includes `OPERATIONS` (Task 2 swapped it for `RECRUITER`) — the `key` values now map 1:1 onto real `EmployeeRole`.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 3: Browser verification**

On a `STARTER` (Free) test company (`maxRoles: 2, maxPerRole: 1`), select two roles — confirm every other card greys out with the plan's real reason text, not a generic message. Change plan to `BUSINESS` in a separate tab, come back, confirm more roles unlock without a page reload (proves `product-context` cache invalidation from `useChangePlan`'s `onSettled` reaches this screen).

- [ ] **Step 4: Commit**

```bash
git add features/onboarding-flow/components/steps/SelectEmployeesStep.tsx
git commit -m "feat(onboarding-flow): wire Select Employees to live server seat availability"
```

---

### Task 9: Wire the Configure Hub (real employee creation — the load-bearing task)

**Why:** Every later step (Skills, Connections, Knowledge, Workflows, Review) needs a *real* `employeeId`. This task is where an employee first comes into existence server-side, and where the Hub's "Next Employee" loop switches from iterating local drafts to iterating `wizardStore.employeeOrder` (real ids). Get the create-on-demand + resume-on-reload logic right here; every later task assumes it already works.

**Files:**
- Modify: `features/onboarding-flow/components/steps/ConfigureEmployeesStep.tsx`
- Modify: `features/onboarding-flow/employeeConfigSchema.ts` (create)

**Interfaces:**
- Consumes: `useCreateEmployee()`, `useUpdateEmployee()`, `useEmployees()` (`@/features/employees/hooks`), `CreateEmployeeDto`, `UpdateEmployeeDto`, `AiEmployeeDto` (`@vaep/types`).
- Produces: for Tasks 10–13, the pattern "resolve the active real employee from `wizardStore.activeEmployeeId` + `useEmployees()`" that every subsequent step reuses verbatim.

- [ ] **Step 1: Zod schema for the mini-form**

```ts
// features/onboarding-flow/employeeConfigSchema.ts
import { z } from 'zod';

export const employeeConfigSchema = z.object({
  name: z.string().min(1, 'Give this employee a name.').max(120),
  persona: z.string().max(2000).optional(),
  language: z.string().min(1),
});
export type EmployeeConfigFormValues = z.infer<typeof employeeConfigSchema>;
```

- [ ] **Step 2: Resolve (or create) the employee whose turn it is**

```tsx
'use client';

import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Globe, Link2, User, Workflow, BookOpen, Zap, ChevronRight } from 'lucide-react';
import type { AiEmployeeDto } from '@vaep/types';
import { IconField } from '@/components/onboarding/fields';
import { useCreateEmployee, useEmployees, useUpdateEmployee } from '@/features/employees/hooks';
import { templateForRole, EMPLOYEE_TEMPLATES } from '../../mockData';
import { useOnboardingWizardStore } from '../../wizardStore';
import { employeeConfigSchema, type EmployeeConfigFormValues } from '../../employeeConfigSchema';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Hindi', 'Portuguese'];

export function ConfigureEmployeesStep() {
  const selectedTemplateKeys = useOnboardingWizardStore((s) => s.selectedTemplateKeys);
  const employeeOrder = useOnboardingWizardStore((s) => s.employeeOrder);
  const activeEmployeeId = useOnboardingWizardStore((s) => s.activeEmployeeId);
  const setActiveEmployee = useOnboardingWizardStore((s) => s.setActiveEmployee);
  const pushEmployeeId = useOnboardingWizardStore((s) => s.pushEmployeeId);
  const markVisited = useOnboardingWizardStore((s) => s.markVisited);
  const visitedEmployeeIds = useOnboardingWizardStore((s) => s.visitedEmployeeIds);
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const setErrors = useOnboardingWizardStore((s) => s.setErrors);
  const errors = useOnboardingWizardStore((s) => s.errors);

  const { data: employees = [] } = useEmployees();
  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();

  const roster = employeeOrder.map((id) => employees.find((e) => e.id === id)).filter((e): e is AiEmployeeDto => Boolean(e));
  const activeEmployee = roster.find((e) => e.id === activeEmployeeId) ?? null;

  // Materialize the next selected-but-not-yet-created role as a real employee.
  useEffect(() => {
    if (activeEmployee || createEmployee.isPending) return;
    const nextKey = selectedTemplateKeys.find(
      (key) => !roster.some((e) => e.role === key),
    );
    if (!nextKey) return;
    const template = EMPLOYEE_TEMPLATES.find((t) => t.key === nextKey)!;
    createEmployee.mutate(
      { name: template.name, role: nextKey as AiEmployeeDto['role'], persona: template.defaultPersona },
      {
        onSuccess: (created) => {
          pushEmployeeId(created.id);
          setActiveEmployee(created.id);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-runs only when these change
  }, [activeEmployee, selectedTemplateKeys, roster, createEmployee.isPending]);

  const template = activeEmployee ? templateForRole(activeEmployee.role) : null;

  const {
    register,
    handleSubmit,
    formState: { errors: formErrors },
  } = useForm<EmployeeConfigFormValues>({
    resolver: zodResolver(employeeConfigSchema),
    values: activeEmployee
      ? { name: activeEmployee.name, persona: activeEmployee.persona ?? '', language: activeEmployee.language ?? 'English' }
      : undefined,
  });

  if (!activeEmployee || !template) {
    return (
      <FlowShell heading="Configure Your AI Employees">
        <p className="text-sm text-fg-muted">Setting up your first employee…</p>
      </FlowShell>
    );
  }

  const saveBasics = handleSubmit((values) => {
    updateEmployee.mutate({ id: activeEmployee.id, data: values });
  });

  const nextIncomplete = roster.find((e) => !visitedEmployeeIds.includes(e.id) && e.id !== activeEmployee.id);

  const onNextEmployee = handleSubmit((values) => {
    updateEmployee.mutate(
      { id: activeEmployee.id, data: values },
      {
        onSuccess: () => {
          markVisited(activeEmployee.id);
          if (nextIncomplete) {
            setActiveEmployee(nextIncomplete.id);
          } else if (selectedTemplateKeys.some((key) => !roster.some((e) => e.role === key))) {
            // more roles still need creating — effect above will materialize the next one
            setActiveEmployee(null as unknown as string); // triggers the create-effect by clearing active — see note below
          } else {
            goToStep('review');
          }
        },
      },
    );
  }, () => setErrors({ configure: 'Fix the highlighted field before continuing.' }));

  // ... render: sidebar (roster.map), the RHF-bound name/persona/language
  // fields (register('name') etc, formErrors.name?.message under each),
  // and the four sub-step rows (Skills/Connections/Knowledge/Workflows)
  // calling goToStep(...) — same JSX structure as the current mock version,
  // just swap `activeEmployee.name` -> RHF-bound field values and the
  // `template.icon`/`colorClass` chip for `EmployeeAvatar template={template}`.
}
```

**A genuine rough edge to flag, not paper over:** `setActiveEmployee(null as unknown as string)` in the "more roles still need creating" branch is a deliberate but ugly signal to re-trigger the creation effect — `activeEmployeeId` typed `string | null` should really just accept `null` directly. Fix the store's `setActiveEmployee` signature to `(id: string | null) => void` (Task 3, revisit) rather than casting here. Call this out explicitly when executing this task — don't ship the cast.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 4: Browser verification**

Select 2 roles in Task 8's screen, continue — confirm `POST /employees` fires once (not twice) for the first role, the Hub shows it as "In Progress," edit the name/persona, click "Next Employee" — confirm `PATCH /employees/:id` fires with the edited values, then a second `POST /employees` fires for the second role. **Refresh the browser mid-way** (after the first employee exists, before the second is created) — confirm the Hub resumes on the same first employee via `employeeOrder`/`activeEmployeeId` from `sessionStorage`, and does **not** create a duplicate employee for the first role.

- [ ] **Step 5: Commit**

```bash
git add features/onboarding-flow/components/steps/ConfigureEmployeesStep.tsx features/onboarding-flow/employeeConfigSchema.ts features/onboarding-flow/wizardStore.ts
git commit -m "feat(onboarding-flow): wire Configure Hub to real employee create/update, resume-safe"
```

---

### Task 10: Wire the Skills step

**Files:**
- Modify: `features/onboarding-flow/components/steps/SkillsStep.tsx`

**Interfaces:**
- Consumes: `useCatalog()`, `useEmployeeSkills(employeeId)`, `useInstallSkill()`, `useAssignSkill(employeeId)` (`@/features/skills/hooks`), `SkillDefinitionDto`, `InstallSkillDto` (`@vaep/types`), `iconForSkill` (Task 2).
- Consumes from Task 9's pattern: resolve `activeEmployee` the same way (`employeeOrder` + `useEmployees()` + `activeEmployeeId`) — extract this into a tiny shared hook to avoid repeating it in Tasks 10–13.

- [ ] **Step 1: Extract the shared "active employee" resolver**

```ts
// features/onboarding-flow/useActiveEmployee.ts
import { useEmployees } from '@/features/employees/hooks';
import { useOnboardingWizardStore } from './wizardStore';

export function useActiveEmployee() {
  const { data: employees = [], isLoading } = useEmployees();
  const activeEmployeeId = useOnboardingWizardStore((s) => s.activeEmployeeId);
  const employee = employees.find((e) => e.id === activeEmployeeId) ?? null;
  return { employee, isLoading };
}
```
Also refactor Task 9's `ConfigureEmployeesStep.tsx` to use this (small follow-up edit to that file, noted here so it isn't forgotten — do it as part of this task's diff, not a separate task).

- [ ] **Step 2: Rewrite `SkillsStep.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useCatalog, useEmployeeSkills, useInstallSkill, useAssignSkill, useUnassignSkill } from '@/features/skills/hooks';
import type { SkillDefinitionDto } from '@vaep/types';
import { iconForSkill } from '../../skillIcons';
import { templateForRole } from '../../mockData';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { CardCheckbox } from '../CardCheckbox';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function SkillsStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const [category, setCategory] = useState<string>('All');

  const { data: catalog = [] } = useCatalog();
  const { data: employeeSkills = [] } = useEmployeeSkills(employee?.id ?? '');
  const installSkill = useInstallSkill();
  const assignSkill = useAssignSkill(employee?.id ?? '');
  const unassignSkill = useUnassignSkill(employee?.id ?? '');

  if (!employee) {
    return (
      <FlowShell heading="Skills & Capabilities">
        <p className="text-sm text-fg-muted">No AI Employee selected yet.</p>
        <StepFooter onBack={() => goToStep('configureEmployees')} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  const template = templateForRole(employee.role);
  const assignedSkillKeys = new Set(
    employeeSkills.map((es) => catalog.find((c) => c.id === es.installedSkillId /* see note below */)?.key).filter(Boolean),
  );
  // NOTE: EmployeeSkillDto links to an InstalledSkill by installedSkillId, not
  // skillKey directly — cross-reference via useInstalledSkills() (company-wide
  // installs), not the catalog, to know which skillKey each assignment is.
  // Replace the line above with a lookup against useInstalledSkills() data.

  const categories = Array.from(new Set(catalog.map((s) => s.category)));
  const recommended = catalog.filter((s) => template.suggestedSkillKeys.includes(s.key));
  const visible = category === 'All' ? catalog : catalog.filter((s) => s.category === category);

  const toggle = (skill: SkillDefinitionDto) => {
    // If this company has never installed this skillKey at all, install it
    // (company-level resource) THEN assign it to this employee. If it's
    // already installed (by this or another employee), just assign/unassign.
    // Exact "already installed?" check needs useInstalledSkills() cross-
    // referenced by skillKey — implement inline here using that hook's data,
    // matching the pattern demonstrated in employee-skills.controller.ts's
    // two-step install-then-assign flow (see Task research, item 5).
  };

  const backToHub = () => goToStep('configureEmployees');

  return (
    <FlowShell heading={`Select Skills for ${employee.name}`} subtitle="Choose the tools and capabilities this employee can use." wide>
      <EmployeeContextHeader employee={employee} />
      {/* ... same two-column layout as before: recommended row + category
          tabs + checkbox list on the left, "Selected Skills" sidebar on the
          right — swap `skill.icon` (removed from the mock SkillDef) for
          `iconForSkill(skill.key)`, and swap `activeEmployee.skillKeys` reads
          for `assignedSkillKeys` computed above. */}
      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
```

**Flag explicitly when executing this step:** the `toggle()` body and the `assignedSkillKeys` cross-reference are left as precise TODO-shaped prose above, not literal code, because they depend on `useInstalledSkills()`'s exact returned shape (`InstalledSkillDto[]` with `skillKey`, `employeeId`) which needs to be checked against `EmployeeSkillDto.installedSkillId` at execution time — read `features/skills/api.ts` and `@vaep/types`'s `InstalledSkillDto`/`EmployeeSkillDto` definitions before writing this function, don't guess the join.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 4: Browser verification**

Assign Gmail to the active employee — confirm `POST /skills/install` (first time) then `POST /employees/:id/skills` both fire, the skill shows checked, and `GET /employees/:id/skills` reflects it on reload. Assign the same Gmail to a *second* employee — confirm it does **not** call `POST /skills/install` again (reuses the existing `InstalledSkill`), only `POST /employees/:id/skills` for the second employee.

- [ ] **Step 5: Commit**

```bash
git add features/onboarding-flow/components/steps/SkillsStep.tsx features/onboarding-flow/useActiveEmployee.ts features/onboarding-flow/components/steps/ConfigureEmployeesStep.tsx
git commit -m "feat(onboarding-flow): wire Skills step to real catalog + install/assign"
```

---

### Task 11: Wire the Connections step

**Files:**
- Modify: `features/onboarding-flow/components/steps/ConnectionsStep.tsx`

**Interfaces:**
- Consumes: `useInstalledSkills()`, `useConnectSkill()`, `useVerifyConnection()`, `useConfigureSkill()` (`@/features/skills/hooks`), and for OAuth-type skills, a direct `apiClient.get('/skills/installed/:id/oauth/authorize', {params:{returnTo}})` call (no existing hook wraps the OAuth redirect per the research — write a small one-off `startOAuth(installedSkillId)` async function in this file, not a new shared hook, since it's a single `window.location.assign(url)` side effect, not cacheable query/mutation state).

- [ ] **Step 1: Rewrite**

```tsx
'use client';

import { useState } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { useInstalledSkills, useConnectSkill, useVerifyConnection } from '@/features/skills/hooks';
import { apiClient } from '@/lib/apiClient';
import { iconForSkill } from '../../skillIcons';
import { templateForRole } from '../../mockData';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

async function startOAuth(installedSkillId: string, returnTo: string) {
  const { data } = await apiClient.get<{ url: string }>(`/skills/installed/${installedSkillId}/oauth/authorize`, { params: { returnTo } });
  window.location.assign(data.url);
}

export function ConnectionsStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const { data: installedSkills = [] } = useInstalledSkills();
  const connect = useConnectSkill();
  const verify = useVerifyConnection();
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (!employee) {
    return (
      <FlowShell heading="Connect Services">
        <p className="text-sm text-fg-muted">No AI Employee selected yet.</p>
        <StepFooter onBack={() => goToStep('configureEmployees')} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  // Skills assigned to THIS employee that need a connection and aren't yet
  // connected — cross-reference useEmployeeSkills(employee.id) against
  // installedSkills by id, same join concern flagged in Task 10.
  const connectable = installedSkills.filter(
    (s) => s.employeeId === employee.id || s.employeeId === null,
  ).filter((s) => s.connectionStatus !== 'CONNECTED');

  const onConnect = (installedSkillId: string, connectionType: string | null) => {
    if (connectionType === 'oauth') {
      void startOAuth(installedSkillId, window.location.pathname);
      return;
    }
    setPendingId(installedSkillId);
    connect.mutate(
      { id: installedSkillId, data: { credentials: {} } }, // manual/api-key skills need real credential fields — see the skill's configSchema, not a blank object; adapt per skill at execution time
      { onSettled: () => setPendingId(null) },
    );
  };

  const backToHub = () => goToStep('configureEmployees');

  return (
    <FlowShell heading={`Connect Tools for ${employee.name}`} subtitle="Link the tools this employee will use." wide>
      <EmployeeContextHeader employee={employee} />
      {/* ... same list layout as before, iconForSkill(s.skillKey) for icons,
          onConnect(s.id, s.connectionType) on the Connect button, disabled
          while pendingId === s.id. */}
      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
```

**Flag explicitly:** the `credentials: {}` placeholder in `useConnectSkill()`'s call is not real — `ConnectSkillDto.credentials` must carry whatever fields that skill's `configSchema` actually asks for (e.g. an API key field for `stripe`). At execution time, render those fields from `SkillDefinitionDto.configSchema` (already fetched via `useCatalog()` in Task 10) as a small inline form per skill row, not a single blank object. This is real remaining design work for this task, not a mechanical wire-up — say so plainly rather than shipping a call that will 400 in practice.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 3: Browser verification**

For an OAuth-type skill (e.g. `gmail`), click Connect — confirm the browser navigates to the OAuth authorize URL and, after completing the provider flow in a real/sandboxed environment, returns to this screen with `connectionStatus: 'CONNECTED'`. For a manual skill (e.g. `stripe`), submit its real credential field(s) — confirm `POST /skills/installed/:id/connect` succeeds and `useVerifyConnection()` reflects `CONNECTED`.

- [ ] **Step 4: Commit**

```bash
git add features/onboarding-flow/components/steps/ConnectionsStep.tsx
git commit -m "feat(onboarding-flow): wire Connections step to real InstalledSkill connect/OAuth flow"
```

---

### Task 12: Wire the Knowledge step (role-scoped, not employee-scoped)

**Files:**
- Modify: `features/onboarding-flow/components/steps/KnowledgeStep.tsx`

**Interfaces:**
- Consumes: `useDocuments(category)`, `useUploadDocument()` (`@/features/knowledge/hooks`).

- [ ] **Step 1: Rewrite, scoping every call by `employee.role`**

```tsx
'use client';

import { useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import { useDocuments, useUploadDocument, useDeleteDocument } from '@/features/knowledge/hooks';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function KnowledgeStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: docs = [] } = useDocuments(employee?.role);
  const upload = useUploadDocument();
  const remove = useDeleteDocument(employee?.role);

  if (!employee) {
    return (
      <FlowShell heading="Knowledge">
        <p className="text-sm text-fg-muted">No AI Employee selected yet.</p>
        <StepFooter onBack={() => goToStep('configureEmployees')} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      upload.mutate({ file, category: employee.role });
    }
  };

  const backToHub = () => goToStep('configureEmployees');

  return (
    <FlowShell heading={`Add Knowledge for ${employee.name}`} subtitle={`Shared with every ${employee.role} AI employee — not just ${employee.name}.`}>
      <EmployeeContextHeader employee={employee} />
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        className={`rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${dragOver ? 'border-violet-secondary bg-violet/[0.06]' : 'border-white/[0.12]'}`}
      >
        <Upload className="mx-auto h-8 w-8 text-violet-secondary" />
        <p className="mt-3 text-sm text-zinc-300">Drag and drop files here</p>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
        <button type="button" onClick={() => inputRef.current?.click()} className="mt-4 rounded-xl border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-300 hover:border-white/[0.2]">
          Browse Files
        </button>
      </div>

      {docs.length > 0 && (
        <ul className="mt-5 space-y-2">
          {docs.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-3">
                <FileText className="h-4 w-4 shrink-0 text-violet-secondary" />
                <span className="truncate text-sm text-zinc-200">{doc.filename}</span>
                <span className="shrink-0 text-xs text-fg-muted">{doc.status}</span>
              </div>
              <button type="button" aria-label={`Remove ${doc.filename}`} onClick={() => remove.mutate(doc.id)} className="text-fg-muted hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
```
Dropped: the "Add Text" and "Use Existing" tabs, and the `KNOWLEDGE_SUGGESTIONS` quick-add chips — none have a real backend counterpart (`POST /knowledge/documents` is file-upload only). Removing fake-looking affordances that don't do anything real is intentional, not an oversight — flag it in the task's completion note so it isn't mistaken for a missed requirement.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 3: Browser verification**

Upload a PDF for a Sales employee — confirm it appears, and a *second* Sales employee (if one exists) sees the *same* document in their Knowledge step (proves role-scoping, not id-scoping). A Support employee should **not** see it.

- [ ] **Step 4: Commit**

```bash
git add features/onboarding-flow/components/steps/KnowledgeStep.tsx
git commit -m "feat(onboarding-flow): wire Knowledge step to real role-scoped document upload"
```

---

### Task 13: Wire the Workflows step

**Files:**
- Modify: `features/onboarding-flow/components/steps/WorkflowsStep.tsx`

**Interfaces:**
- Consumes: `useWorkflowTemplates(category?)`, `useInstallWorkflowTemplate()` (`@/features/workflows/hooks`), `TemplateParameter`, `TEMPLATE_PARAMETER_BINDS` (`@vaep/types`).

- [ ] **Step 1: Rewrite**

```tsx
'use client';

import { Bot, LayoutTemplate, Wrench } from 'lucide-react';
import { useWorkflowTemplates, useInstallWorkflowTemplate } from '@/features/workflows/hooks';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function WorkflowsStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const { data: templates = [] } = useWorkflowTemplates();
  const installTemplate = useInstallWorkflowTemplate();

  if (!employee) {
    return (
      <FlowShell heading="Workflows">
        <p className="text-sm text-fg-muted">No AI Employee selected yet.</p>
        <StepFooter onBack={() => goToStep('configureEmployees')} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  const relevant = templates.filter((t) => t.recommendedFor?.includes(employee.role) /* confirm exact field name on WorkflowTemplateSummaryDto at execution time — not verified against the DTO source during research, flag if it doesn't exist and filter by category instead */);

  const onInstall = (templateId: string, employeeParamKey: string) => {
    installTemplate.mutate({
      id: templateId,
      body: { parameters: { [employeeParamKey]: employee.id } },
      idempotencyKey: `onboarding-${employee.id}-${templateId}`,
    });
  };

  const backToHub = () => goToStep('configureEmployees');

  return (
    <FlowShell heading={`Set Up Workflows for ${employee.name}`} subtitle="Choose how this employee will work." wide>
      <EmployeeContextHeader employee={employee} />
      {/* For each template in `relevant`: find its `employee`-bound parameter
          via GET /workflow-templates/:id/parameters (useWorkflowTemplate(id),
          lazily on expand) to know which parameter key to pass — don't
          hardcode a key name, TemplateParameter[].find(p => p.binds ===
          'employee')?.key is the real lookup. Render a checkbox-style card
          per template; onInstall(template.id, thatKey) on toggle-on. */}
      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
```

**Flag explicitly:** `t.recommendedFor?.includes(employee.role)` is written on the assumption `WorkflowTemplateSummaryDto` carries a role-recommendation field — this was **not** confirmed against the actual DTO during research (only `parameters`/`requires`/`category` were). At execution time, read `packages/types/src/index.ts`'s `WorkflowTemplateSummaryDto` definition first; if no such field exists, filter by `category` (matching the employee's department) instead, or show all templates ungrouped — don't ship a filter against a field that doesn't exist.

Manual build (`POST /workflows` + draft/publish) is intentionally **out of scope** for this task — the onboarding wizard only offers the template-install path, matching the "3 build modes" card row's "Use a template" option; "Create with AI Assist" and "Build manually" stay as inert/decorative cards here (or are removed — a product call, flag it) since wiring the full workflow builder into a wizard step is a separate, much larger scope than this plan covers.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 3: Browser verification**

Install a template for the active employee — confirm `POST /workflow-templates/:id/install` fires with the employee's real id bound to the correct parameter, and a `WorkflowDto` (DRAFT status) is created. Confirm re-clicking the same template does not create a duplicate (the `idempotencyKey` should make the second call a no-op returning the original).

- [ ] **Step 4: Commit**

```bash
git add features/onboarding-flow/components/steps/WorkflowsStep.tsx
git commit -m "feat(onboarding-flow): wire Workflows step to real template install"
```

---

### Task 14: Wire Review + Complete (readiness, activation, stamping `onboardedAt`)

**Why:** `GET /employees/:id/readiness` already computes almost exactly what the mock's local `computeReadiness()` faked — replace it outright rather than keeping a parallel client-side reimplementation that can drift from the server's real rules.

**Files:**
- Modify: `features/onboarding-flow/components/steps/ReviewStep.tsx`
- Modify: `features/onboarding-flow/components/steps/SuccessStep.tsx`

**Interfaces:**
- Consumes: `useEmployeeReadiness(id)` (`@/features/employees/hooks`), `useUpdateEmployee()`, `useCompleteOnboarding()` (`@/features/onboarding/hooks`).

- [ ] **Step 1: Rewrite `ReviewStep.tsx`**

```tsx
'use client';

import { AlertTriangle, Check } from 'lucide-react';
import { useEmployeeReadiness, useUpdateEmployee } from '@/features/employees/hooks';
import { templateForRole } from '../../mockData';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { EmployeeTabs } from '../EmployeeTabs';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function ReviewStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const { data: readiness } = useEmployeeReadiness(employee?.id ?? '');
  const updateEmployee = useUpdateEmployee();

  if (!employee) {
    return (
      <FlowShell heading="Review your AI Employees">
        <p className="text-sm text-fg-muted">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={prevStep} continueLabel="Back" />
      </FlowShell>
    );
  }

  const template = templateForRole(employee.role);
  const isActive = employee.status === 'ACTIVE';

  const fixTarget: Record<string, () => void> = {
    STATUS: () => goToStep('configureEmployees'),
    SKILLS: () => goToStep('skills'),
    CONNECTIONS: () => goToStep('connections'),
    KNOWLEDGE: () => goToStep('knowledge'),
    WORKFLOWS: () => goToStep('workflows'),
  };

  return (
    <FlowShell heading="Review your AI Employees" subtitle="Make sure everything is ready before activating." wide>
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <EmployeeTabs />
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <EmployeeAvatar template={template} />
              <div>
                <p className="text-sm font-semibold text-white">{employee.name}</p>
                <p className="text-xs text-fg-muted">{employee.role}</p>
              </div>
            </div>
            {isActive && <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">Activated</span>}
          </div>

          <ul className="mt-5 space-y-2.5">
            {readiness?.checks.map((check) => (
              <li key={check.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-zinc-300">
                  {check.status === 'PASS' ? <Check className="h-4 w-4 text-emerald-400" /> : <AlertTriangle className={`h-4 w-4 ${check.status === 'FAIL' ? 'text-red-400' : 'text-amber-400'}`} />}
                  {check.label}
                </span>
                {check.status !== 'PASS' && (
                  <button type="button" onClick={fixTarget[check.key]} className="text-xs font-medium text-violet-secondary underline hover:text-violet">Fix</button>
                )}
              </li>
            ))}
          </ul>

          {readiness && readiness.issues.length > 0 && (
            <ul className="mt-4 space-y-1.5 border-t border-white/[0.06] pt-4">
              {readiness.issues.map((issue, i) => (
                <li key={`${issue.code}-${issue.skillKey ?? i}`} className={`text-xs ${issue.severity === 'BLOCKER' ? 'text-red-400' : 'text-amber-400'}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            disabled={!readiness?.ready || isActive}
            onClick={() => updateEmployee.mutate({ id: employee.id, data: { status: 'ACTIVE' } })}
            className="mt-6 w-full rounded-xl bg-violet px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isActive ? 'Activated ✓' : readiness?.ready ? 'Activate Employee' : 'Not ready'}
          </button>
        </div>
      </div>
      <StepFooter onBack={prevStep} onContinue={nextStep} continueLabel="Finish →" />
    </FlowShell>
  );
}
```
Note the fixed duplicate-`key` bug from the original mock version (`key={\`${issue.code}-${issue.skillKey ?? i}\`}` instead of bare `key={issue.code}`) — multiple `SKILL_NOT_CONNECTED` issues for different skills previously collided on the same React key; carry this fix forward, don't reintroduce it.

Also note: `continueDisabled={!allActivated}` (the mock's "every employee must be activated to Finish" gate) is **dropped** here in favor of letting `Finish` always proceed — re-deriving "are all N employees active" purely client-side by re-fetching `useEmployeeReadiness` for every roster member on this one screen is possible but adds real complexity (N parallel readiness queries) for a soft nicety. If the hard gate matters to the product, add it back with `useQueries` over `roster.map(e => e.id)` — flag this to the user as an explicit yes/no during execution rather than silently deciding either way.

- [ ] **Step 2: Wire the Complete step to stamp `onboardedAt`**

`SuccessStep.tsx` currently just renders a local summary. Real completion needs `company.onboardedAt` set — the only existing mechanism is `POST /onboarding/complete`. **Verify before wiring**: call it with `{ departments: [], employees: [] }` against a test company that already has employees hired via Task 9's path, and confirm it still stamps `onboardedAt` with an empty `employees` array (the DTO's research notes it diffs against `alreadyHired` and short-circuits if `onboardedAt` is already set, but an *empty* `employees[]` on a company with zero prior onboarding-module employees was not confirmed to still stamp the flag). If it does not, this is a real backend gap — add a minimal `PATCH /onboarding/complete-flag`-style endpoint (or extend the existing service to accept an empty roster) as its own reviewed sub-task, do not fake completion client-side by writing to a cache that doesn't reach the server.

```tsx
// SuccessStep.tsx — replace the local-only rendering with:
import { useCompleteOnboarding } from '@/features/onboarding/hooks';
import { useEmployees } from '@/features/employees/hooks';
// ...
const { data: employees = [] } = useEmployees();
const completeOnboarding = useCompleteOnboarding();

useEffect(() => {
  completeOnboarding.mutate({ departments: [], employees: [] });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount
}, []);
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 4: Browser verification**

Reach the Success screen for a company with 2 already-hired employees — confirm `POST /onboarding/complete` fires, `GET /tenant/me` afterward shows `onboardedAt` set, and — this is the important cross-check — logging out and back in routes straight to `/dashboard` rather than being force-redirected to `/onboarding` by `(app)/layout.tsx` (proves the flag genuinely reached the server, not just this screen's local state).

- [ ] **Step 5: Commit**

```bash
git add features/onboarding-flow/components/steps/ReviewStep.tsx features/onboarding-flow/components/steps/SuccessStep.tsx
git commit -m "feat(onboarding-flow): wire Review to real readiness, Complete to stamp onboardedAt"
```

---

### Task 15: Delete the mock reducer, final full-flow verification

**Files:**
- Delete: `features/onboarding-flow/state.tsx`
- Modify: any remaining `import ... from '../state'` or `'../../state'` stragglers (search first, don't assume Tasks 1–14 caught every one).

- [ ] **Step 1: Confirm nothing still imports the old module**

Run: `cd apps/web && grep -rn "from '.*onboarding-flow/state'" src/`
Expected: no results. If any remain, fix them before deleting the file — do not delete first and patch compile errors after; that hides which callers were missed.

- [ ] **Step 2: Delete**

```bash
rm apps/web/src/features/onboarding-flow/state.tsx
```

- [ ] **Step 3: Typecheck the whole app**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: zero errors.

- [ ] **Step 4: Full-flow browser verification (the real acceptance test for this whole plan)**

Against a fresh test company on a real local stack: walk Welcome → Company → Goals → Plan (pick Growth) → Select 2 employees (Sales + Support) → for each: Configure name/persona → assign 2 real skills → connect at least one → upload one knowledge doc → install one workflow template → Review (confirm real readiness, Activate) → Next Employee → repeat → Finish. Confirm at every step the Network tab shows the expected real request, and confirm in a DB client (Adminer, `:8080`) that `AiEmployee`, `EmployeeSkill`, `InstalledSkill`, `KnowledgeDocument`, and `Workflow` rows exist for this company matching what was entered. This is the plan's actual definition of done — not "it typechecks."

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(onboarding-flow): remove mock reducer, wiring to real backend complete"
```

---

## Self-Review

**1. Spec coverage:** Every numbered research finding (company profile, billing/plan, employee creation, skills install+assign+connect+OAuth, knowledge role-scoping, workflow template install, readiness, and the existing frontend hook/convention inventory) maps to a task above (Tasks 5–14 respectively), plus the three cross-cutting corrections it surfaced (auth gate — Task 1; role/skill/knowledge-scope mismatches — Task 2; hook-reuse discipline stated in Global Constraints and enforced task-by-task).

**2. Placeholder scan:** Two spots are *intentionally* left as precise prose instead of literal code — the Skills/Connections cross-reference join (Task 10 Step 2, Task 11 Step 1) and the Workflows template role-filter field (Task 13 Step 1) — both because they depend on exact DTO shapes (`InstalledSkillDto`/`EmployeeSkillDto` join keys; `WorkflowTemplateSummaryDto`'s role-recommendation field) that direct backend research did not fully confirm, and guessing wrong would ship a silently-broken filter rather than a working one. Each is called out explicitly as "flag this, verify against the real DTO before writing it" rather than hand-waved as generic "add validation" — this is a deliberate, narrow exception to the no-placeholder rule where the alternative (fabricating a field name) is worse.

**3. Type consistency:** `useActiveEmployee()` (introduced Task 10) is used identically in Tasks 11, 12, 13, 14 — same `{ employee, isLoading }` shape throughout. `wizardStore`'s `activeEmployeeId: string | null` type is flagged as needing a signature fix in Task 9 (accept `null` in `setActiveEmployee`, not just `string`) — apply that fix in Task 9 itself, not deferred. `templateForRole(role: EmployeeRole)` (Task 4) is used consistently in Tasks 9, 10, 11, 12, 13, 14 wherever a `DraftEmployee`'s `templateKey` lookup used to happen.

---

Plan complete and saved to `docs/superpowers/plans/2026-09-12-onboarding-preview-backend-wiring.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
