# V-AEP Platform — OAuth Provider Adapters, Wave 2 (Design Spec)

**Date:** 2026-08-18 · **Status:** Approved · **Scope:** implement real `SkillProviderAdapter`s for
Gmail, Google Calendar, Google Drive and Slack — the plan's Wave 2 "Core Productivity"
(`orlixa-enterprise-skill-connection-installation-plan.md` §36) — continuing the framework shipped
2026-08-15 for `email` (see `[[skill-connection-framework]]`).

## Why this, why now

`docs/implementation/workflow-system/orlixa-enterprise-skill-connection-installation-plan.md` is the
canonical, already-adopted architecture doc — `providers/provider-adapter.ts` and `smtp.adapter.ts` cite
it by section number today. Its Wave 1 foundation (§36) and the `email` provider (§7/§10) are done. Four
Wave-2 providers (§8 Gmail, §12 Slack, §18 Calendar, §19 Drive) already have real **tool execution**
(`RealSkillExecutor`) but skip straight from "OAuth succeeded" to `CONNECTED` with no
`validateCredentials`/`discoverAccount`/`test` stage — `getProviderAdapter()` returns `null` for all
four (`providers/index.ts` registers only `email`). This is exactly the §37 anti-pattern the framework
exists to close, just not yet applied past provider #1.

Per `04-skills-connectors.md` §1.8, 12 of 14 providers also report health via `genericProbe()`
(`connectors/health-probe.ts:101-105`), which unconditionally returns `{healthy:true, mock:true}` —
so "Connected"/"Degraded" is meaningless for these four today. Registering an adapter fixes this for
free: `adapterProbe()` (`health-probe.ts:87-98`) already wraps any registered adapter's `healthCheck()` —
it just has no entry for these four yet.

## What already works generically (no changes needed)

- `SkillsService.verifyConnection()` (`skills.service.ts:973-1059`, backs
  `POST /skills/installed/:id/verify`) already does `getProviderAdapter(installed.skillKey)` and runs
  `runVerification()` for **any** skillKey with a registered adapter — the dispatch itself needs no
  change. (It does need one addition, not a change to this logic — see "Token freshness" below.)
- The wizard (`SkillSetupWizard.tsx`) already renders generically off the verify response; it only needs
  its skill allow-list extended (see Frontend).
- `connector.verified` / `connector.verify_failed` audit events (`skills.service.ts:1044-1056`) already
  fire generically from `verifyConnection()`.
- The health-probe registry pattern (`adapterProbe(skillKey)`) already exists; adding these providers is
  a one-line-each addition to the `PROBES` map.

## Token freshness — a real pre-existing gap this wave activates

Google access tokens expire in ~1 hour. The tool-execution path already handles this:
`resolveExecutorContext()` (`skills.service.ts:800-836`) checks `connectionType === 'oauth'` +
a stored refresh token, and calls `this.tokens.getAccessToken(installed.id)`
(`ConnectorTokenService`, single-flight, persists the renewed token) before building the executor's
context. **Neither `verifyConnection()` (`skills.service.ts:973-1059`) nor the scheduled health-check
sweep (`ConnectorHealthService.runProbe()`, `connector-health.service.ts:238-248`) do this today** —
both decrypt stored credentials directly and use them as-is. This is inert today because the only two
probed providers (`email`, `github`) don't use refresh tokens; it becomes an active bug the moment an
OAuth adapter is registered — a tenant with no recent real tool call would see spurious `EXPIRED`
failures on a perfectly valid connection, exactly the false-negative the plan's §33 health check exists
to avoid.

Fix: factor the refresh-if-needed logic already in `resolveExecutorContext()` into a small shared
helper — e.g. `resolveFreshCredentials(tokens: ConnectorTokenService, installed)` in
`connectors/credentials.util.ts` (already imported by both `SkillsService` and
`ConnectorHealthService`) — and call it from all three sites: `resolveExecutorContext()` (refactored
onto it, behavior unchanged), `verifyConnection()`, and `ConnectorHealthService.runProbe()`. Pure
extraction of existing logic to a third call site, not new behavior for the tool-execution path.

## Data model change

None. `InstalledSkill.connectionType` (already `'oauth'` for all four), `connectionStatus` (existing
4-state enum), `credentials` (already stores the OAuth token + `scope`), and
`lastHealthCheckAt`/`lastHealthError`/`consecutiveErrors`/`tokenExpiresAt` all already exist and are
sufficient. `ConnectionFailureCode` (`provider-adapter.ts:27-39`) already has every value the plan's §3
failure states ask for — this wave is what makes `INSUFFICIENT_SCOPE`, `EXPIRED`, `REVOKED`,
`HEALTH_CHECK_FAILED` actually get produced instead of sitting declared-but-unused.

Discovered account identity is **not** written to `displayName` (would silently clobber a user-set name).
It flows through the existing mechanism: `verifyConnection()` already stores it at
`config.connectedAccount` (`skills.service.ts:1032-1039`) and records it in audit metadata
(`account` field) — unchanged, generic, already works for any adapter.

## Components — four new adapter files

`apps/api/src/modules/skills/providers/{gmail,calendar,gdrive,slack}.adapter.ts`, each implementing
`SkillProviderAdapter` (`provider-adapter.ts:92-128`), matching `smtp.adapter.ts`'s shape (header comment
citing the plan section, `resolveXSettings`-style input readers, human-readable `classifyError`).

The three Google adapters share a small internal helper (`google-api.util.ts`) for "authenticated GET,
map 401/403 → the right `ConnectionFailureCode`" — mirroring how `imap.util.ts` already supports
`smtp.adapter.ts`. This is plumbing reuse, not a new abstraction over the adapter contract itself: each
adapter still owns its own `validateCredentials`/`discoverAccount`/`test` with provider-specific
endpoints and response shapes, per the chosen "Approach 1" (no generic OAuth-adapter base class).

### `gmail.adapter.ts` (§8)
- `validateCredentials`: `GET https://gmail.googleapis.com/gmail/v1/users/me/profile` with the bearer
  token. 200 → pass. 401 → `EXPIRED` (token invalid/expired) or `AUTH_FAILED`; 403 with
  `insufficientPermissions`/`ACCESS_TOKEN_SCOPE_INSUFFICIENT` in the body → `INSUFFICIENT_SCOPE`.
- `discoverAccount`: the profile's `emailAddress`.
- `test`: send a real email to **the connected account's own address** ("Orlixa connection test"),
  reusing the same non-stranger-safe default pattern as `smtp.adapter.ts`'s `test()`
  (`smtp.adapter.ts:191-219`) — via `POST /gmail/v1/users/me/messages/send` with a base64url-encoded
  RFC 2822 message.
- `validateInbound` (optional, lightweight): confirm the stored `scope` string contains
  `gmail.readonly` — this provider is **polled**, not webhooked (existing `gmail-inbound.service.ts`,
  unrelated cron), so there is no inbound infrastructure to *configure* here, only a scope fact to
  report. Matches `04-skills-connectors.md`'s documented scope-minimization gap: scopes are currently
  requested as a fixed pair regardless of tenant config, so this check passes unconditionally today —
  stated as a known limitation, not fixed here (out of scope, already documented elsewhere).
- `healthCheck`: delegates to `validateCredentials` (same as `smtp.adapter.ts:265-267`).
- `classifyError`: maps Google's JSON error body (`error.status`: `UNAUTHENTICATED` →
  `AUTH_FAILED`/`EXPIRED`, `PERMISSION_DENIED` → `INSUFFICIENT_SCOPE`, network/5xx →
  `CONNECTION_FAILED`).

### `calendar.adapter.ts` (§18)
- `validateCredentials`: `GET .../calendar/v3/users/me/calendarList?maxResults=1`.
- `discoverAccount`: the primary calendar's `id`/`summary`.
- `test`: create a same-day, 1-minute event on the primary calendar via the **existing**
  `createGoogleCalendarEvent()` (`executors/google-calendar.util.ts:40-80`, already used by
  `RealSkillExecutor` — reused, not reimplemented), then delete it via the **existing**
  `deleteGoogleCalendarEvent()` (`google-calendar.util.ts:123-139`). Cleanup failure logs a warning but
  does not fail the test — the create already proved the connection; `deleteGoogleCalendarEvent` already
  treats 404/410 as success.
- `healthCheck`: delegates to `validateCredentials`.
- `classifyError`: same Google mapping as Gmail.

### `gdrive.adapter.ts` (§19)
- `validateCredentials`: `GET .../drive/v3/about?fields=user`.
- `discoverAccount`: `about.user.emailAddress`/`displayName`.
- `test`: create a small text file ("Orlixa connection test.txt") via the Drive API in the configured
  folder (or root if none configured), then delete it. New, small, adapter-local — the existing
  `upload_file`/`create_folder` tool executors (`real-skill-executor.ts`) are for the chat tool-calling
  path with different input shapes (file content from a user/AI turn) and are not reused directly, to
  avoid coupling the adapter to executor-specific argument parsing.
- `healthCheck`: delegates to `validateCredentials`.
- `classifyError`: same Google mapping.

### `slack.adapter.ts` (§12)
- `validateCredentials`: `POST https://slack.com/api/auth.test` with the bot token. Per the documented
  gotcha (`04-skills-connectors.md` line 684, already load-bearing elsewhere in this codebase): Slack
  returns **HTTP 200 with `{ok:false, error}`** on failure — check `body.ok`, not `res.ok`.
  `error: 'invalid_auth'`/`'token_revoked'` → `REVOKED`; `'missing_scope'` → `INSUFFICIENT_SCOPE`;
  `'account_inactive'` → `AUTH_FAILED`.
- `discoverAccount`: `auth.test`'s own response already includes `team`/`user` — the workspace name and
  bot identity, no second call needed.
- `test`: DM the **connecting user**, never a public channel. This needs `users.lookupByEmail` (Slack
  user id from an email address) then `conversations.open` + `chat.postMessage` — `lookupByEmail`
  needs the `users:read.email` bot scope, which `SKILL_OAUTH.slack.scopes` (`oauth.providers.ts:76`)
  does not request today (only `chat:write`, `channels:read`). This wave adds it. Consequence stated
  explicitly: existing Slack connections keep working for everything already built (send_message,
  health, validateCredentials) since none of that needs the new scope — only the new test action needs
  it, and it correctly reports `INSUFFICIENT_SCOPE` for an old connection until the user reconnects
  (same as any other scope-gated capability, not a special case).
  The email looked up is **the requesting user's own account email** (the person clicking "Test" in the
  wizard), threaded through the adapter contract's existing `opts.to` field — the same field
  `smtp.adapter.ts`'s `test()` already uses for "who to send to," defaulting when the caller omits it.
  The controller passes the authenticated request user's email as the default, exactly the same way
  email's test defaults to the connection's own from-address. If lookup fails (no Slack account for
  that email), the test reports `FAILED` with a clear reason rather than falling back to a real channel.
- `healthCheck`: delegates to `validateCredentials` (`auth.test` is already the cheap liveness call).
- `classifyError`: maps Slack's `error` string per the table above; `'ratelimited'` → `CONNECTION_FAILED`.

## Data flow change — `connectOAuth()`

`skills.service.ts:1061-1084` currently:
```ts
async connectOAuth(companyId, installedSkillId, tokens) {
  const installed = await this.findOwnedInstalled(companyId, installedSkillId);
  const merged = { ...this.readCredentials(installed.credentials), ...tokens };
  await this.prisma.installedSkill.update({
    data: { credentials: this.sealCredentials(merged), connectionStatus: 'CONNECTED', ... },
  });
}
```
Becomes: after merging tokens (the OAuth exchange with the provider already succeeded — the token is
always persisted), if `getProviderAdapter(installed.skillKey)` returns non-null, call
`runVerification(adapter, { creds: merged, config: installed.config ?? {} }, { includeTest: false })`
**before** persisting, and set `connectionStatus` from the result using the **exact same rule
`verifyConnection()` already uses** (`skills.service.ts:1018-1022`):
`result.ok ? 'CONNECTED' : (current === 'CONNECTED' ? 'DEGRADED' : 'NOT_CONNECTED')` — for a first-time
connect, `current` is `NOT_CONNECTED`, so a failed first verification correctly lands on
`NOT_CONNECTED`, not `DEGRADED` (which would wrongly imply a previously-working connection broke).
Store `lastHealthError`/`config.connectedAccount` the same way `verifyConnection()` does, and emit
`connector.connected` / `connector.connect_failed` audit events (reusing the exact action names the
sibling API-key path `connectSkill()` already uses for this situation — not `connector.verify_failed`,
which is reserved for the explicit user-triggered re-verify). This also closes a documented gap for
free: `connectOAuth()` currently writes no audit row at all.

For `hubspot`/`jira` (still no adapter): `getProviderAdapter()` returns `null`, so `connectOAuth()`
behaves **exactly as today** — unconditional `CONNECTED`, no verification, no behavior change. This is
the same opt-in-per-provider guarantee `provider-adapter.ts`'s header comment already documents and a
test already pins for the non-OAuth path.

No new endpoints. The manual "test" step stays the existing
`POST /skills/installed/:id/verify?includeTest=true`.

## Provider registration

`providers/index.ts` (currently `registerProviderAdapter(smtpAdapter)` only) gains four more calls.
`connectors/health-probe.ts`'s `PROBES` map (`health-probe.ts:107-110`) gains four entries following the
existing `email: adapterProbe('email')` pattern: `gmail: adapterProbe('gmail')`, etc.

## Frontend

`InstalledSkillList.tsx`'s `WIZARD_SKILLS` set (`WIZARD_SKILLS = new Set(['email'])`) becomes
`new Set(['email', 'gmail', 'calendar', 'gdrive', 'slack'])`. `SkillSetupWizard`'s stages
(`details → verify → test → done`) apply as-is for these OAuth-only providers with one adjustment: the
`details` stage (currently a credentials form, meaningful for email/SMTP) is skipped for OAuth
providers — there is nothing to fill in before redirecting — so the wizard opens directly on `verify`,
which auto-runs the moment the OAuth callback returns control to the app (same
`?connected=<skillKey>` query-param handling `skills/page.tsx:33-44` already does). No changes to
`ConnectSkillControl.tsx`'s OAuth-redirect button itself — it already redirects to
`GET /skills/installed/:id/oauth/authorize` unchanged; only what happens *after* the callback changes
(the wizard now has something real to show).

## UI addition: universal Settings popup wizard

Added scope (2026-08-18, same day, user request): today `InstalledSkillList.tsx` splits configuration
across two inline-expanding affordances — the gear "Configure" icon (`ActionIconButton`, opens
`ConfigureSkillForm` inline) and, only for `WIZARD_SKILLS` (`email` alone today), a separate primary
button that opens `SkillSetupWizard` inline. This unifies them: **every** installed skill's gear icon
(and its primary action button) opens the **same** `SkillSetupWizard`, in a **popup**, using the
existing `Modal` component (`components/ui/Modal.tsx` — focus-trapped, portaled, Esc/backdrop-close,
already used elsewhere in the app; size `lg`). `WIZARD_SKILLS`'s allow-list is removed.

This is not just a wrapper change. `SkillSetupWizard`'s `verify` stage has no escape hatch today: when
`verifyConnection()` hits its no-adapter early return (`skills.service.ts:989-1003`, a single SKIPPED
step, `result.ok` always `false`), the wizard's `run()` (`SkillSetupWizard.tsx:61-73`) never advances
past `verify` — exactly why the allow-list existed. Two small, targeted changes fix this:

1. **Backend**: `verifyConnection()`'s response (and `VerifyConnectionDto`) gains `adapterAvailable:
   boolean` — `Boolean(getProviderAdapter(installed.skillKey))`, computed where the existing early
   return already knows this.
2. **Frontend**: when `adapterAvailable === false`, the `verify` stage renders an honest "Orlixa can't
   automatically verify this provider yet — your settings are saved" message with a **Continue** action
   that advances to `done` **without** calling `run()` again (never a fake PASSED step). The `done`
   stage's copy branches on whether a real verification actually ran: `"{name} is connected as
   {account}"` when it did, vs. `"{name} is set up. Automatic verification isn't available for this
   provider yet."` when it didn't. `ConfigureSkillForm` (the `details` stage) and the `test` stage's
   existing "Skip the test" escape are already generic and need no change.

Out of scope for this addition: changing what `ConfigureSkillForm` renders per-field (unchanged,
already data-driven off `configSchema`); removing the primary connect button (kept as a second entry
point into the same modal, not replaced).

## Explicitly out of scope for this wave

- Microsoft 365/Outlook (§9) — does not exist as a provider anywhere in the codebase today; separate
  future work.
- Stripe, GitHub, HubSpot, Jira real tool execution or adapters — different gap (mock execution behind
  already-real credentials), tracked separately, not touched here.
- The scope-minimization gap (`SKILL_OAUTH` requesting a fixed scope list regardless of tenant config)
  — documented and explicitly deferred in `04-skills-connectors.md`; this wave's `validateInbound` for
  Gmail reports against current (always-requested) scopes, it does not change what's requested.
- Slack channel *selection* UI — already exists as a `defaultChannel` config field; this wave's
  `discoverAccount` returns workspace/bot identity only, not a channel list.
- Any change to `ConnectorHealthService`'s DEGRADED-after-3-failures state machine — unchanged, it just
  starts receiving real signals for these four instead of `genericProbe`'s hardcoded success.
- The token-refresh mechanism itself (`ConnectorTokenService.getAccessToken()`) — untouched; this wave
  only wires two more call sites onto it (see "Token freshness"), the refresh/persist logic inside it
  does not change.

## Testing

- Unit: one spec per adapter (mocked `fetch`) covering validateCredentials pass/fail, discoverAccount,
  test pass/fail (including Slack's `{ok:false}`-on-200 case and Calendar's create-then-delete), and
  classifyError's mapping table.
- Unit: `connectOAuth()` — adapter-present success (CONNECTED + audit `connector.connected`), adapter
  present failure on first connect (NOT_CONNECTED, not DEGRADED + `connector.connect_failed`), and
  no-adapter skills (hubspot/jira) unchanged (regression pin, mirrors the existing test for the
  API-key path).
- e2e: extend the existing OAuth e2e coverage — a Gmail connect that fails verification (mocked
  insufficient-scope response) lands `NOT_CONNECTED` with a human-readable reason, not a silent
  `CONNECTED`; a passing connect flows into `GET /skills/installed` showing `CONNECTED` +
  `config.connectedAccount`.
- Browser: one adapter (Gmail) driven through the real wizard end-to-end before replicating the pattern
  to Calendar/Drive/Slack, per this repo's usual one-module-at-a-time verification discipline.
- Unit: `resolveFreshCredentials` — oauth + near-expired + refresh token present → calls
  `getAccessToken` and uses the fresh value; oauth + refresh-token-revoked → propagates the failure
  (connector already flipped `DISCONNECTED` by `ConnectorTokenService`, matching today's
  `resolveExecutorContext` behavior); non-oauth (email) → untouched, no call made (regression pin).
- e2e: a Slack connection created **before** this wave's scope addition (i.e. missing
  `users:read.email`) reports `INSUFFICIENT_SCOPE` specifically on the test action, while
  `validateCredentials`/`healthCheck`/normal `send_message` execution are unaffected — proving the new
  scope only gates the one capability that needs it, not the whole connection.
- Unit: `verifyConnection()` — `adapterAvailable` is `true` for an adapter-backed skill, `false` for one
  without (regression pin covering hubspot/jira/stripe/etc.).
- Browser: open the popup for a no-adapter skill (e.g. Stripe) end-to-end — verify stage shows the
  honest "can't auto-verify yet" message with a working Continue action, and the done stage never
  claims a connection was verified.
