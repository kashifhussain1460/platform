# Skill Connect Wizard — Category Routing + WhatsApp Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Skills catalog page's connection wizard a fourth connection
category (`'custom'`) so WhatsApp routes to its existing, already-correct
dedicated form instead of silently saving to the wrong table, and fix the
wizard's idle-field contrast bug the screenshot that started this surfaced.

**Architecture:** Widen the shared `SkillConnectionType` union with a
`'custom'` value; reclassify WhatsApp's catalog entry to it; teach
`SkillSetupWizard` to render a small skillKey→component registry (today: just
`whatsapp` → the existing `WhatsAppConnectForm`) instead of the generic form
for that category, with a shorter 3-step sequence since that form's single
submit already both saves and live-verifies. Sync `InstalledSkill
.connectionStatus` from the dedicated connect endpoint so the rest of the app
(catalog list, employee skill picker) agrees with reality. No database
migration; no changes to `WhatsAppAccount`'s existing, already-correct
backend logic.

**Tech Stack:** NestJS + Prisma (backend), Next.js App Router + React Hook
Form + TanStack Query (frontend), shared types in `@vaep/types`.

**Spec:** `docs/superpowers/specs/2026-09-17-skill-connect-wizard-categories-design.md`

## Global Constraints

- No database schema changes — this is catalog-metadata + frontend-rendering
  + one status-sync write to an existing column.
- `WhatsAppConnectForm`'s existing save/verify logic and its
  `/leads/whatsapp-connect` page mount must keep working unchanged — only an
  additive, optional prop is added to it.
- Reuse `WhatsAppConnectForm` as-is; do not build a second WhatsApp connect
  form inside the wizard.
- Every other skill's wizard behavior (`oauth`, `api_key`, `none`) must be
  visually and functionally unchanged — verify by hand after the change.

---

### Task 1: Widen the shared `SkillConnectionType` and reclassify WhatsApp

**Why:** Every other task in this plan depends on `'custom'` existing as a
real value both the backend catalog and the frontend wizard can check
against. This has to land first.

**Files:**
- Modify: `packages/types/src/index.ts:906-911`
- Modify: `apps/api/src/modules/skills/catalog.ts:856`

**Interfaces:**
- Produces: `SkillConnectionType = 'oauth' | 'api_key' | 'none' | 'custom'`,
  consumed by `SkillConnectionDto.type` (same file, line 915, unchanged) and
  by Task 5's wizard branch.

- [ ] **Step 1: Widen the union type**

In `packages/types/src/index.ts`, replace lines 906-911:

```ts
/**
 * How a skill authenticates against its (real) backend. `api_key` prompts for a
 * secret key; `oauth` is a stubbed connect flow (real OAuth = TODO); `none` needs
 * no connection (mock/sandbox executors run without one either way).
 */
export type SkillConnectionType = 'oauth' | 'api_key' | 'none';
```

with:

```ts
/**
 * How a skill authenticates against its (real) backend. `api_key` prompts
 * for a secret key/form via the generic InstalledSkill credentials path;
 * `oauth` is a real authorization-code flow (see skills/oauth); `none` needs
 * no connection; `custom` means the skill owns a dedicated connect
 * endpoint/table outside InstalledSkill entirely (e.g. `whatsapp` →
 * `WhatsAppAccount`) and the wizard must render that skill's own component
 * instead of the generic form.
 */
export type SkillConnectionType = 'oauth' | 'api_key' | 'none' | 'custom';
```

- [ ] **Step 2: Reclassify WhatsApp in the catalog**

In `apps/api/src/modules/skills/catalog.ts:856`, change:

```ts
    connection: { type: 'api_key', label: 'Connect WhatsApp (Twilio)' },
```

to:

```ts
    connection: { type: 'custom', label: 'Connect WhatsApp (Twilio)' },
```

Leave `configSchema` on this entry unchanged (lines 857-861) — it still
documents what the skill needs; only the wizard's rendering choice changes
(Task 5).

- [ ] **Step 3: Rebuild `@vaep/types` and typecheck**

```bash
cd "D:/Vertical AI/platform"
pnpm --filter @vaep/types build
```

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors (the union widen is additive; nothing exhaustively
switches on `SkillConnectionType` today per the spec's grep).

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/index.ts apps/api/src/modules/skills/catalog.ts
git commit -m "feat(skills): add 'custom' connection category, reclassify whatsapp"
```

---

### Task 2: Relocate `skillIcons.ts` to `features/skills/`

**Why:** The wizard (Task 5) needs a skillKey→icon map for its header icon.
One already exists, fully covering every icon needed (Slack, Gmail,
Calendar, Google Drive, WhatsApp), but it lives under `onboarding-flow/`,
which is the wrong home for something the Skills catalog page also needs.
Move it once, update its two existing importers, rather than duplicating it.

**Files:**
- Create: `apps/web/src/features/skills/skillIcons.ts`
- Delete: `apps/web/src/features/onboarding-flow/skillIcons.ts`
- Modify: `apps/web/src/features/onboarding-flow/components/steps/ConnectionsStep.tsx:16`
- Modify: `apps/web/src/features/onboarding-flow/components/steps/SkillsStep.tsx:14`

**Interfaces:**
- Produces: `SKILL_ICONS: Record<string, ElementType<{ className?: string }>>`
  and `iconForSkill(key: string): ElementType<{ className?: string }>`, same
  signatures as today — only the import path changes for existing
  consumers, and Task 5 becomes a third consumer.

- [ ] **Step 1: Create the file at its new location with the exact current content**

```ts
// apps/web/src/features/skills/skillIcons.ts
import { Mail, Globe, Megaphone, Calendar as CalendarLucide, Puzzle } from 'lucide-react';
import {
  GmailIcon,
  SlackIcon,
  HubSpotIcon,
  CalendarIcon,
  GoogleDriveIcon,
  StripeIcon,
  GitHubIcon,
  WhatsAppIcon,
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

- [ ] **Step 2: Delete the old file**

```bash
rm "apps/web/src/features/onboarding-flow/skillIcons.ts"
```

- [ ] **Step 3: Update the two existing importers**

In `apps/web/src/features/onboarding-flow/components/steps/ConnectionsStep.tsx:16`, change:

```ts
import { iconForSkill } from '../../skillIcons';
```

to:

```ts
import { iconForSkill } from '@/features/skills/skillIcons';
```

In `apps/web/src/features/onboarding-flow/components/steps/SkillsStep.tsx:14`, make the identical change:

```ts
import { iconForSkill } from '@/features/skills/skillIcons';
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors. A missing-module error here means a third importer
exists that this step missed — search again with
`grep -rn "onboarding-flow/skillIcons\|'../../skillIcons'" apps/web/src`
before proceeding.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/skills/skillIcons.ts \
        apps/web/src/features/onboarding-flow/skillIcons.ts \
        apps/web/src/features/onboarding-flow/components/steps/ConnectionsStep.tsx \
        apps/web/src/features/onboarding-flow/components/steps/SkillsStep.tsx
git commit -m "refactor(skills): relocate skillIcons.ts from onboarding-flow to skills"
```

---

### Task 3: Add `onConnected` to `WhatsAppConnectForm`

**Why:** The wizard (Task 5) needs to know when the connect+verify call
inside this form succeeds, so it can advance past its "Connect" stage. The
form has no such callback today — it only clears its own local token state
on success. This is a small, additive, backward-compatible prop.

**Files:**
- Modify: `apps/web/src/features/whatsapp/components/WhatsAppConnectForm.tsx:16-36`

**Interfaces:**
- Consumes: nothing new.
- Produces: `WhatsAppConnectForm({ onConnected }: { onConnected?: () => void } = {})`
  — Task 5 passes `onConnected={() => setStage('test')}`.

- [ ] **Step 1: Add the prop and call it on success**

Change the component signature and `onSubmit` in
`apps/web/src/features/whatsapp/components/WhatsAppConnectForm.tsx`:

```ts
export function WhatsAppConnectForm({
  onConnected,
}: { onConnected?: () => void } = {}) {
  const { data: account, isLoading } = useWhatsAppAccount();
  const connect = useConnectWhatsAppAccount();

  const [twilioAccountSid, setTwilioAccountSid] = useState('');
  const [twilioAuthToken, setTwilioAuthToken] = useState('');
  const [whatsappSenderNumber, setWhatsappSenderNumber] = useState('');

  const isConnected = account?.status === 'CONNECTED';
  const canSubmit =
    twilioAccountSid.trim().length > 0 &&
    twilioAuthToken.trim().length > 0 &&
    whatsappSenderNumber.trim().length > 0;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    connect.mutate(
      { twilioAccountSid, twilioAuthToken, whatsappSenderNumber },
      {
        onSuccess: () => {
          setTwilioAuthToken('');
          onConnected?.();
        },
      },
    );
  };
```

Everything else in the file (the JSX, the `isLoading`/`isConnected` reads,
the rest of the form) is unchanged.

- [ ] **Step 2: Confirm the existing page still compiles with the new optional prop**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors. `apps/web/src/app/(app)/leads/whatsapp-connect/page.tsx`
calls `<WhatsAppConnectForm />` with no props today — since `onConnected` is
optional this must keep compiling unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/whatsapp/components/WhatsAppConnectForm.tsx
git commit -m "feat(whatsapp): add optional onConnected callback to WhatsAppConnectForm"
```

---

### Task 4: Sync `InstalledSkill.connectionStatus` from the dedicated connect endpoint

**Why:** `WhatsappAccountsService.connect()` only ever writes `WhatsAppAccount`.
Once Task 5 routes the wizard here, a successful connect must also update
`InstalledSkill.connectionStatus`, or the Skills catalog list and the
employee skill picker (both of which read `InstalledSkill.connectionStatus`,
not `WhatsAppAccount.status`) will keep showing WhatsApp as not connected
even right after a real, successful connect.

**Files:**
- Modify: `apps/api/src/modules/engines/whatsapp/whatsapp-accounts.service.ts:48-106`
- Test: `apps/api/src/modules/engines/whatsapp/whatsapp-accounts.service.spec.ts`
  (create if it doesn't already exist — check first with `find apps/api/src/modules/engines/whatsapp -name "*.spec.ts"`)

**Interfaces:**
- Consumes: `this.prisma.installedSkill.updateMany` (already used elsewhere
  in the codebase for tenant-scoped, may-not-exist-yet rows — same pattern
  as `ConnectorTokenService`).
- Produces: no change to `connect()`'s return type (`WhatsAppAccountDto`) —
  this is a side-effecting addition, not an interface change.

- [ ] **Step 1: Check for an existing spec file and read it if present**

```bash
find "D:/Vertical AI/platform/apps/api/src/modules/engines/whatsapp" -iname "*accounts*spec*"
```

If a spec exists, read it fully before Step 2 so the new test you write in
Step 3 matches its existing mocking conventions (likely a stubbed
`PrismaService` and `TwilioWhatsappClientService`).

- [ ] **Step 2: Add the sync write**

In `apps/api/src/modules/engines/whatsapp/whatsapp-accounts.service.ts`,
inside `connect()`, after the `whatsAppAccount.upsert` call and before the
`auditLog.record` call (i.e. right after the closing brace of the `upsert`
around line 90), add:

```ts
    // The Skills catalog list, EmployeeSkillPicker and the wizard's own
    // initial-stage check all read InstalledSkill.connectionStatus, not
    // WhatsAppAccount.status — without this, a real successful connect here
    // would still show as "Not connected" everywhere outside this form.
    // updateMany (not update): a company can reach this dedicated connect
    // form before ever installing the catalog entry, so there may be no
    // matching row yet — that's a no-op, not an error.
    await this.prisma.installedSkill.updateMany({
      where: { companyId, skillKey: 'whatsapp' },
      data: { connectionStatus: 'CONNECTED' },
    });
```

- [ ] **Step 3: Write the test**

Add to (or create) `apps/api/src/modules/engines/whatsapp/whatsapp-accounts.service.spec.ts`:

```ts
it('syncs InstalledSkill.connectionStatus to CONNECTED on a successful connect', async () => {
  const updateManySpy = jest.fn().mockResolvedValue({ count: 1 });
  prisma.installedSkill.updateMany = updateManySpy;

  await service.connect(companyId, {
    twilioAccountSid: 'ACxxx',
    twilioAuthToken: 'token',
    whatsappSenderNumber: '+15550001111',
  });

  expect(updateManySpy).toHaveBeenCalledWith({
    where: { companyId, skillKey: 'whatsapp' },
    data: { connectionStatus: 'CONNECTED' },
  });
});
```

Adjust `companyId`, the mocked `prisma`/`service` setup, and the Twilio
client stub to match whatever fixtures the existing spec file already
establishes (or, if the file is new, mirror the constructor-mocking pattern
used in `connector-token.service.spec.ts` — same module, sibling service).

- [ ] **Step 4: Run the test, confirm it fails first (if TDD), then passes after Step 2**

```bash
cd apps/api && npx jest --config ./test/jest-unit.json --testPathPattern="whatsapp-accounts"
```

Expected: PASS.

- [ ] **Step 5: Run the full whatsapp module test suite to confirm nothing else broke**

```bash
cd apps/api && npx jest --config ./test/jest-unit.json --testPathPattern="whatsapp"
```

Expected: all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/engines/whatsapp/whatsapp-accounts.service.ts \
        apps/api/src/modules/engines/whatsapp/whatsapp-accounts.service.spec.ts
git commit -m "fix(whatsapp): sync InstalledSkill.connectionStatus on real connect"
```

---

### Task 5: Wire the wizard's `custom` category branch

**Why:** This is the task that actually closes the bug — everything before
it was prerequisite. `SkillSetupWizard.tsx` needs to render
`WhatsAppConnectForm` (not `ConfigureSkillForm`) for `custom`-type skills,
with a 3-step sequence instead of 4, and show the provider icon in its
header.

**Files:**
- Modify: `apps/web/src/features/skills/components/SkillSetupWizard.tsx` (full file — see below for the complete replacement of the relevant sections)

**Interfaces:**
- Consumes: `WhatsAppConnectForm` (Task 3's signature), `iconForSkill` (Task 2's new location), `def.connection.type === 'custom'` (Task 1).
- Produces: no change to `SkillSetupWizard`'s own external props (`{ installed, def, onClose }`) — this task only changes internal rendering.

- [ ] **Step 1: Add the import and the registry**

At the top of `apps/web/src/features/skills/components/SkillSetupWizard.tsx`,
add two imports alongside the existing ones:

```ts
import type { ComponentType } from 'react';
import { WhatsAppConnectForm } from '@/features/whatsapp/components/WhatsAppConnectForm';
import { iconForSkill } from '../skillIcons';
```

Directly below the `type Stage = ...` / `const ORDER = ...` declarations,
add:

```ts
/**
 * Skills whose real credentials live outside InstalledSkill entirely (their
 * catalog `connection.type` is `'custom'`) get their own connect component
 * here instead of the generic ConfigureSkillForm/ConnectSkillControl. One
 * entry today; add one more line per future custom skill, not new plumbing.
 */
const CUSTOM_CONNECT_COMPONENTS: Record<string, ComponentType<{ onConnected?: () => void }>> = {
  whatsapp: WhatsAppConnectForm,
};

/** custom skills skip the separate "Sign in" stage — their one connect call
 * already both saves and live-verifies (see WhatsappAccountsService.connect,
 * which calls verifyTwilioCredentials before ever writing CONNECTED). */
const CUSTOM_ORDER: { key: Stage; label: string }[] = [
  { key: 'details', label: 'Connect' },
  { key: 'test', label: 'Test' },
  { key: 'done', label: 'Ready' },
];
```

- [ ] **Step 2: Compute `isCustom` alongside the existing `needsOAuth`**

Inside the `SkillSetupWizard` function body, right after the existing
`needsOAuth` line, add:

```ts
  const isCustom = def.connection?.type === 'custom';
  const CustomConnect = isCustom ? CUSTOM_CONNECT_COMPONENTS[def.key] : null;
```

- [ ] **Step 3: Use `CUSTOM_ORDER` when `isCustom`**

Find the line:

```ts
  const currentIndex = ORDER.findIndex((s) => s.key === stage);
```

Replace with:

```ts
  const order = isCustom ? CUSTOM_ORDER : ORDER;
  const currentIndex = order.findIndex((s) => s.key === stage);
```

And update the `<ol>` that maps over `ORDER` (a few lines below) to map over
`order` instead:

```ts
        {order.map((s, i) => {
```

(This is the only place `ORDER` is read for rendering; the original `ORDER`
constant itself stays unchanged and is still used for the non-custom
branch's `order` value.)

- [ ] **Step 4: Render `CustomConnect` in the `details` stage, before the existing `needsOAuth` check**

Find:

```tsx
      {stage === 'details' ? (
        needsOAuth ? (
          <ConnectSkillControl installed={installed} def={def} />
        ) : (
          <ConfigureSkillForm
            installed={installed}
            def={def}
            onDone={() => setStage('verify')}
          />
        )
      ) : null}
```

Replace with:

```tsx
      {stage === 'details' ? (
        CustomConnect ? (
          <CustomConnect onConnected={() => setStage('test')} />
        ) : needsOAuth ? (
          <ConnectSkillControl installed={installed} def={def} />
        ) : (
          <ConfigureSkillForm
            installed={installed}
            def={def}
            onDone={() => setStage('verify')}
          />
        )
      ) : null}
```

Note this changes what "details" advances to for custom skills:
`setStage('test')` (skipping `'verify'` entirely), matching `CUSTOM_ORDER`
having no `'verify'` entry.

- [ ] **Step 5: Skip the auto-verify effect and initial-stage logic for custom skills**

The existing `useEffect` that auto-runs `run(false)` the first time `stage
=== 'verify'` (search for `if (stage !== 'verify' || autoChecked.current)
return;`) must not fire for custom skills, since they never reach `'verify'`
— this is already true by construction (custom skills' stage never becomes
`'verify'`, per Step 4), so **no change needed here**; this step is a
verification note, not an edit. Confirm by reading the effect once more
after Step 4 to be sure `'verify'` is genuinely unreachable for a custom
skill — it is, because `CUSTOM_ORDER` never contains it and Step 4's
`CustomConnect` branch calls `setStage('test')` directly.

Also check the initial `useState<Stage>` computation (search for
`installed.connectionStatus === 'CONNECTED' ? 'test' : ...`) — this already
opens straight to `'test'` when already connected, and to `'details'`
otherwise via the `canReturnToDetails` guard chain, both of which are correct
for custom skills unchanged (a custom skill with no config fields still has
`hasNoConfig = true` today only because it reads `def.configSchema` — but
custom skills DO have a non-empty `configSchema` per Task 1 Step 2, so
`canReturnToDetails` evaluates the same as any other configured skill; no
special-casing needed).

- [ ] **Step 6: Add the provider icon to the wizard header**

Find the opening of the returned JSX:

```tsx
  return (
    <div>
      <p className="mb-4 text-xs text-app-ink-3">
        Each step has to pass before this skill can run.
      </p>
```

Replace with:

```tsx
  const Icon = iconForSkill(def.key);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-5 w-5 text-app-ink-2" aria-hidden />
        <p className="text-sm font-medium text-app-ink">{def.name}</p>
      </div>
      <p className="mb-4 text-xs text-app-ink-3">
        Each step has to pass before this skill can run.
      </p>
```

- [ ] **Step 7: Typecheck**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 8: Manual browser verification (this is the real acceptance test)**

With the dev stack up (`docker compose -f infra/docker-compose.yml up -d`,
`pnpm dev` from `apps/api` and `apps/web`):

1. Log in to a test company, go to `/skills`, find "WhatsApp (Twilio)",
   open its connect wizard.
2. Confirm the step bar now reads **Connect → Test → Ready** (3 steps, not
   4), and the header shows the WhatsApp icon + name.
3. Confirm the form shown is `WhatsAppConnectForm` (Account SID / Auth Token
   / sender number fields, "Connect WhatsApp" submit button — same fields as
   `/leads/whatsapp-connect`).
4. Enter real or test Twilio credentials and submit. Confirm the stage
   advances to "Test" on success.
5. Check `GET /engines/whatsapp/accounts` (or the DB directly) — confirm a
   real `WhatsAppAccount` row now exists with `status: CONNECTED`.
6. Reload `/skills` — confirm the WhatsApp card itself now shows connected
   (this is Task 4's fix — without it this step fails even though the
   wizard "worked").
7. Open Slack's or Gmail's connect wizard — confirm the 4-step OAuth sequence
   and generic behavior are visually unchanged.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/skills/components/SkillSetupWizard.tsx
git commit -m "feat(skills): route 'custom' connection type to its dedicated form"
```

---

### Task 6: Fix the idle-field contrast bug

**Why:** This is the concrete visual bug the original screenshot showed —
an unfocused field's border is nearly invisible against the light-theme
white card, which is exactly what made "Twilio Auth Token" look like it had
no input box at all. The comment already on this CSS (`apps/web/src/app/
globals.css:85-92`) documents a prior sweep that found the same class of
issue and only partially fixed it for this theme — the light-theme override
still relies on a single, very-low-contrast border color with no
distinguishing background tint.

**Files:**
- Modify: `apps/web/src/app/globals.css:93-97`

**Interfaces:** None — pure CSS, no component API changes.

- [ ] **Step 1: Strengthen the light-theme idle border + add a faint background tint**

Change:

```css
.app-light .field-modern {
  border-color: #d9d9e5;
  background: #ffffff;
  color: #14141c;
}
```

to:

```css
.app-light .field-modern {
  /* #d9d9e5 on #ffffff measured under 1.3:1 — effectively invisible on a
     white card (the exact bug a WhatsApp-connect screenshot surfaced: an
     idle field looked like it had no input box at all). #b9b9c9 clears a
     real, visible boundary; the faint background tint gives it a second,
     independent cue so it doesn't rely on border color alone. */
  border-color: #b9b9c9;
  background: #fbfbfe;
  color: #14141c;
}
```

- [ ] **Step 2: Manual visual verification**

With the dev stack up, open the WhatsApp connect wizard (or any `app-light`
form with an unfocused field, e.g. `/leads/whatsapp-connect` directly).
Confirm every field shows a visible box outline before you click into it,
not just the one that happens to be focused/autofocused.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/globals.css
git commit -m "fix(ui): strengthen idle-field border contrast on the light app canvas"
```

---

## Self-Review

**1. Spec coverage:** §1 (catalog category) → Task 1. §2 (wizard routing) →
Task 5. §2a (status consistency) → Task 4. §3 (step sequence) → Task 5 Step
3-4. §4 (visual polish, contrast + icon) → Task 6 (contrast) + Task 5 Step 6
(icon) + Task 2 (icon source relocation). "Known related gaps" section is
explicitly out of scope per the spec and correctly has no task here.

**2. Placeholder scan:** Every step has complete, copy-pasteable code —
no "TBD"/"similar to Task N"/bare prose describing what to do without
showing it. Task 4's test step tells the implementer to adapt fixture setup
to whatever the existing spec file (or sibling `connector-token.service
.spec.ts`) establishes, rather than inventing fixture code blind — this is a
deliberate "look at the real file first" instruction, not an unfilled
placeholder, and Step 1 of that task makes the lookup itself an explicit,
checkable step.

**3. Type consistency:** `WhatsAppConnectForm({ onConnected }: { onConnected?:
() => void } = {})` (Task 3) is the exact signature `CUSTOM_CONNECT_COMPONENTS`
(Task 5 Step 1) types against (`ComponentType<{ onConnected?: () => void }>`)
and the exact call Task 5 Step 4 makes (`<CustomConnect onConnected={() =>
setStage('test')} />`) — all three agree. `iconForSkill`/`SKILL_ICONS`
(Task 2) keep their existing signature; Task 5 Step 6 calls `iconForSkill(def
.key)` matching `SkillDefinitionDto.key: string` (unchanged, pre-existing
field). `connectionStatus: 'CONNECTED'` (Task 4) matches the existing
`SkillConnectionStatus` enum value already used throughout
`skills.service.ts`.

---

Plan complete and saved to `docs/superpowers/plans/2026-09-17-skill-connect-wizard-categories.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
