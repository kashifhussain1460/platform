# Skill connection wizard — category-driven routing + visual fix — design

## Goal

Two problems, one root cause: the Skills catalog page's connection wizard
(`SkillSetupWizard.tsx`) treats every credential-requiring skill the same way
(save via the generic `InstalledSkill` config/credentials path), but that is
factually wrong for WhatsApp, and the form itself has a visual contrast bug
that makes untouched fields look like they have no input at all.

1. **Functional bug:** WhatsApp's real executor reads credentials from a
   dedicated `WhatsAppAccount` table (`apps/api/prisma/schema.prisma`), not
   `InstalledSkill.credentials`. The generic wizard has no idea this
   distinction exists, so a user can fill in the exact form shown in the
   screenshot that started this, see every stage reach "Ready ✓", and their
   WhatsApp workflows will still fail with `No WhatsAppAccount configured for
   this company` — verified live during this session (see Evidence below). A
   second, fully-correct form (`features/whatsapp/components/
   WhatsAppConnectForm.tsx`) already exists and does the right thing (posts to
   `POST /engines/whatsapp/accounts`, which live-verifies against Twilio
   before ever marking CONNECTED) — but it only lives on a separate page
   (`/leads/whatsapp-connect`) nobody finds from the Skills catalog.
2. **Visual bug:** `ConfigureSkillForm.tsx`'s `field-modern` inputs have a
   border faint enough, in their idle (non-focused) state, that an unfocused
   field reads as if it has no input box at all — exactly what the screenshot
   showed for "Twilio Auth Token" sitting next to the visibly-bordered,
   focused "Twilio Account SID".

## Evidence (from live testing this session)

Using a real Twilio account (Account SID + Auth Token + a Sandbox WhatsApp
number), connecting through the generic Skills-page path left
`WhatsAppAccount` empty and `whatsapp.send_template` failed with `No
WhatsAppAccount configured for this company`. Connecting through
`POST /engines/whatsapp/accounts` instead (the dedicated, already-built
endpoint) succeeded, live-verified the credentials against Twilio, and a real
`send_template` call went through (Twilio SID `MM457c...`, delivered, later
confirmed `status: "read"`).

## Decisions (confirmed with the user)

- "Client + secret key" category = **OAuth skills only** (Slack, Gmail,
  Calendar, Google Drive, HubSpot, Jira) — platform-level `client_id`/
  `client_secret` from env, tenant just clicks Connect and is redirected. Not
  WhatsApp/email's multi-field forms.
- The WhatsApp routing fix **is in scope** for this change, not deferred.
- Visual work is **light polish** — fix the contrast bug, add a provider icon,
  keep the existing 4-step wizard shell. No layout restructuring.
- Explicitly out of scope: migrating `WhatsAppAccount` into `InstalledSkill`
  (only one skill has this shape today — YAGNI); touching Stripe/GitHub/
  HubSpot/Jira's SIMULATED-only status (separate, already-correct concern).

## 1. Catalog category (backend)

`apps/api/src/modules/skills/catalog.ts` — widen the `connection.type` union
from `'none' | 'api_key' | 'oauth'` to add a fourth value:

```ts
connection: { type: 'none' | 'api_key' | 'oauth' | 'custom'; label?: string };
```

Change WhatsApp's entry (currently `{ type: 'api_key', label: 'Connect
WhatsApp (Twilio)' }`, line ~856) to:

```ts
connection: { type: 'custom', label: 'Connect WhatsApp (Twilio)' },
```

`configSchema` stays on the catalog entry (unchanged) — it's still accurate
documentation of what the skill needs, and `skill-requirements.service.ts`'s
existing `hasAnyRealExecution`-gated `requiresConnection` logic is unaffected
(WhatsApp already has a real executor, so this keeps working exactly as
today). Only the *wizard's rendering choice* changes, not the requirement
model.

The `SkillDefinitionDto`/`SkillConnectionType` shared type
(`packages/types/src/index.ts`) gets the same widened union so the frontend
can discriminate on it.

## 2. Wizard routing (frontend)

`apps/web/src/features/skills/components/SkillSetupWizard.tsx` — add one more
branch alongside the existing `needsOAuth` check:

```ts
const CUSTOM_CONNECT_COMPONENTS: Record<string, ComponentType> = {
  whatsapp: WhatsAppConnectForm,
};
const isCustom = def.connection?.type === 'custom';
const CustomConnect = isCustom ? CUSTOM_CONNECT_COMPONENTS[def.key] : null;
```

In the `stage === 'details'` branch, when `CustomConnect` is set, render it
instead of `ConfigureSkillForm`/`ConnectSkillControl`. `WhatsAppConnectForm`
is imported from `features/whatsapp/components/WhatsAppConnectForm.tsx` —
**not duplicated**, just mounted from a second place — with **one small,
additive change**: it needs to tell its parent when the connect succeeded, so
the wizard can advance. Add an optional prop, mirroring the pattern
`ConfigureSkillForm` already uses (`onDone?: () => void`):

```ts
export function WhatsAppConnectForm({ onConnected }: { onConnected?: () => void } = {}) {
  // ...
  connect.mutate(
    { twilioAccountSid, twilioAuthToken, whatsappSenderNumber },
    { onSuccess: () => { setTwilioAuthToken(''); onConnected?.(); } },
  );
```

The prop is optional and unused by the existing `/leads/whatsapp-connect`
mount, so that page's behavior is unaffected — this is additive, not a
breaking change to the component's existing call site.

### 2a. Status consistency (found during self-review)

`WhatsappAccountsService.connect()` (`apps/api/src/modules/engines/whatsapp/
whatsapp-accounts.service.ts`) only writes `WhatsAppAccount`. It never
touches `InstalledSkill.connectionStatus` — but that field is what
`SkillCatalog.tsx`'s list, `EmployeeSkillPicker.tsx`, and the wizard's own
initial-stage logic (`installed.connectionStatus === 'CONNECTED'`, line ~88)
all read. Routing the wizard to the correct form is not enough on its own:
without this, WhatsApp would still show "Not connected" everywhere outside
the wizard itself, even immediately after a real, successful connect.

Fix: in `WhatsappAccountsService.connect()`, after the `whatsAppAccount`
upsert succeeds, also sync the matching `InstalledSkill` row:

```ts
await this.prisma.installedSkill.updateMany({
  where: { companyId, skillKey: 'whatsapp' },
  data: { connectionStatus: 'CONNECTED' },
});
```

A `updateMany` (not `update`) because there may be no matching
`InstalledSkill` row yet (a company could reach `/leads/whatsapp-connect`
before ever installing the catalog entry) — `updateMany` is a no-op rather
than a throw when there's nothing to match, which is the correct behavior
here (the catalog install step is unaffected either way).

This is a small, local registry keyed by `skillKey`, not a generic plugin
system — YAGNI: there is exactly one entry today, and adding a second
`custom` skill later means adding one more map entry, not new machinery.

## 3. Step sequence per category

`ORDER` in `SkillSetupWizard.tsx` becomes conditional on `isCustom`:

- **`oauth` / `api_key`** (unchanged): `Details → Sign in → Test → Ready`
  (4 steps).
- **`custom`** (WhatsApp): `Connect → Test → Ready` (3 steps). "Details" and
  "Sign in" collapse into one **"Connect"** stage because
  `WhatsAppConnectForm`'s single submit already both persists *and*
  live-verifies against Twilio (`WhatsappAccountsService.connect()` calls
  `verifyTwilioCredentials` before ever writing `CONNECTED` — see
  `whatsapp-accounts.service.ts`). Presenting a separate, empty "Sign in" step
  afterward would be ceremony with no real check behind it — the same
  §37/`SkillSetupWizard` "a stage must prove something or say so" discipline
  the file's own header comment already states.
- After `WhatsAppConnectForm` calls `onConnected`, the wizard sets `stage =
  'test'`. WhatsApp has no entry in `getProviderAdapter` (confirmed —
  `providers/` has no whatsapp adapter file), so this stage renders exactly
  what it already renders today for any adapter-less skill: "Orlixa can't
  automatically verify this provider yet — your settings are saved and this
  skill is ready to use" plus a "Continue" button straight to "Ready". No new
  behavior needed here — the existing fallback already does the honest thing.
  Building a real live-test adapter for WhatsApp (actually sending a test
  template through this stage) is a reasonable follow-up, but is **out of
  scope** for this spec — it doesn't block either bug this spec closes.

## 4. Visual polish

- **Contrast fix:** `apps/web/src/app/globals.css` (or wherever `.field-modern`
  is defined) — give the idle-state border a visible, non-focus-dependent
  color (e.g. `border-app-border-strong` at rest, not just on `:focus`).
  Confirm by screenshot-comparing the WhatsApp wizard's "Auth Token" field
  before/after.
- **Provider icon:** the wizard header (`SkillSetupWizard.tsx`'s top of
  render, above the step list) gains a small icon next to `def.name`, sourced
  from the existing `SKILL_ICONS` map
  (`apps/web/src/features/onboarding-flow/skillIcons.ts`) — every icon needed
  (Slack, Gmail, Calendar, Google Drive, WhatsApp) already exists there. Since
  this map is generic catalog-key → icon (nothing onboarding-specific in its
  content), **relocate** it to `apps/web/src/features/skills/skillIcons.ts`
  (its natural home) and update the one existing import in
  `onboarding-flow` to point at the new location, rather than duplicating the
  map. `iconForSkill(key)` already has a sane `Puzzle` fallback for catalog
  keys without a bespoke mark.
- No other layout changes — same 4-step (or 3-step) horizontal stepper shell,
  same modal chrome.

## Files touched

- `apps/api/src/modules/skills/catalog.ts` — widen `connection.type`,
  reclassify `whatsapp`.
- `packages/types/src/index.ts` — widen the shared `SkillConnectionType`
  union.
- `apps/web/src/features/skills/components/SkillSetupWizard.tsx` — custom
  registry branch, conditional `ORDER`, icon in header.
- `apps/web/src/features/whatsapp/components/WhatsAppConnectForm.tsx` — add
  the optional `onConnected` prop (additive; existing call site unaffected).
- `apps/api/src/modules/engines/whatsapp/whatsapp-accounts.service.ts` — sync
  `InstalledSkill.connectionStatus` after a successful connect (§2a).
- `apps/web/src/features/skills/skillIcons.ts` — **new** (moved from
  `onboarding-flow/skillIcons.ts`).
- `apps/web/src/features/onboarding-flow/skillIcons.ts` — **deleted**; its one
  importer updated to the new path.
- Wherever `.field-modern` is defined (styles) — idle-border contrast fix.

## Explicitly not touched

- `apps/api/src/modules/engines/whatsapp/*` otherwise (webhook controller,
  Twilio client, real executor — already correct, proven live). The one
  change in this module is the narrow status-sync addition in §2a.
- `WhatsAppConnectForm`'s existing save/verify logic and its
  `/leads/whatsapp-connect` mount — only the one additive prop changes; no
  behavior at that page changes.
- Stripe/GitHub/HubSpot/Jira connect gating (`ConnectSkillControl.tsx`'s
  `SIMULATED` check) — unrelated, already correct.
- Any database migration — this is a catalog-metadata + frontend-rendering
  change only; `WhatsAppAccount` and `InstalledSkill` both keep their current
  shape.

## Known related gaps (not in scope)

Two other places branch on `connectionType === 'oauth'` with a generic,
non-WhatsApp-aware else-path, and likely have the same latent routing
problem for WhatsApp specifically — found while checking every call site of
`connection.type`/`connectionType` for exhaustiveness fallout, not chased
further because they're outside the Skills catalog page this spec targets:

- `apps/web/src/features/assist/components/SkillRequirementCard.tsx` (the AI
  Assist chat-based workflow builder's requirement card).
- `apps/web/src/features/onboarding-flow/components/steps/ConnectionsStep.tsx`
  (the onboarding wizard's per-employee connect step).

Worth a follow-up spec once this one ships, using the same `'custom'`
category as the discriminator.

## Testing

- Typecheck both apps after the shared-type widen.
- Manual: open the WhatsApp card from `/skills` → confirm it now shows the
  3-step `Connect → Test → Ready` sequence, renders `WhatsAppConnectForm`, and
  a successful connect actually creates/updates the real `WhatsAppAccount` row
  (checked via `GET /engines/whatsapp/accounts`) — not just
  `InstalledSkill.credentialsSet`.
- Manual: open Slack/Gmail's card → confirm the 4-step OAuth sequence is
  visually unchanged.
- Visual: screenshot the WhatsApp wizard's "Auth Token" field idle (unfocused)
  and confirm the border is now visible.
