# OAuth Provider Adapters, Wave 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give Gmail, Google Calendar, Google Drive and Slack real `SkillProviderAdapter`s (the framework
shipped for `email`), so connecting them actually verifies instead of trusting a completed OAuth
handshake — and unify every installed skill's Settings action into one popup wizard instead of today's
split between an inline config form and an email-only inline wizard.

**Architecture:** four new adapter files implementing the existing `SkillProviderAdapter` contract
(`validateCredentials`/`discoverAccount`/`test`/`healthCheck`/`classifyError`), registered into the
existing `providers/index.ts` registry and `health-probe.ts`'s `PROBES` map — both already generic, so
registering is most of the work. `SkillsService.connectOAuth()` gains a verification step it doesn't
have today. A new `resolveFreshCredentials` helper closes a token-refresh gap shared by
`verifyConnection()` and the health-check sweep. The frontend wraps the existing `SkillSetupWizard` in
the existing `Modal` component and makes it universal, closing a real dead-end in its `verify` stage for
providers with no adapter.

**Tech Stack:** NestJS + Prisma (backend, no schema change this wave), Next.js + TanStack Query + Tailwind
(frontend), native `fetch` for all provider HTTP calls (Node 18+, already the convention — see
`google-calendar.util.ts`, `*-client.service.ts`).

**Spec:** `docs/specs/2026-08-18-oauth-provider-adapters-wave2-design.md` — read it first; this plan
argues from it and does not repeat its rationale in full.

## Global Constraints

- **No Prisma schema change.** `InstalledSkill.connectionType`/`connectionStatus`/`credentials`/
  `lastHealthCheckAt`/`consecutiveErrors`/`tokenExpiresAt` already cover everything this wave needs.
- **Opt-in per provider stays true.** `getProviderAdapter()` returning `null` for a skill with no
  adapter (hubspot, jira, stripe, github, http, scheduling, postiz, chatwoot, plane) must keep behaving
  exactly as today everywhere — every task that touches shared code (`connectOAuth`, `verifyConnection`,
  `runProbe`) needs an explicit regression test pinning the no-adapter path unchanged.
- **Never fake a pass.** A `test`/`validateCredentials`/`healthCheck` that cannot really check something
  reports `SKIPPED`/`assumed:true`, never a bare `PASSED`. The frontend's "done" stage must never say a
  connection is verified when `adapterAvailable` is false.
- **A "test" action never reaches a stranger.** Gmail defaults to the connection's own address; Slack
  DMs the connecting user, never a public channel.
- **Slack's `{ok:false}`-on-HTTP-200 quirk** must be checked via the parsed body (`body.ok`), never
  `res.ok` alone, on every Slack call (`04-skills-connectors.md` line 684 — already load-bearing
  elsewhere in this codebase).
- **Provider fetch calls use an abort timeout** (10s), matching `google-calendar.util.ts` and
  `health-probe.ts`'s existing `fetchWithTimeout` pattern — a hung provider must not hang a request.
- Run backend unit tests from `apps/api`: `npx jest --config ./test/jest-unit.json <path>`. Full suite:
  `pnpm run test:unit`. e2e: `pnpm test` (see `platform/CLAUDE.md` for required env vars). The suite is
  currently 100% green with no known-failing tests — a new failure is a real regression to fix, not to
  dismiss.
- Frontend: `pnpm --filter @vaep/web run typecheck` (or the workspace's usual `pnpm build`/`pnpm dev`
  cycle) after the frontend task — this repo has no separate frontend unit-test suite for this feature
  area; verification is typecheck + the final browser task.

---

### Task 1: Google API helper (`google-api.util.ts`)

**Files:**
- Create: `apps/api/src/modules/skills/providers/google-api.util.ts`
- Test: `apps/api/src/modules/skills/providers/google-api.util.spec.ts`

**Interfaces:**
- Produces: `googleApiGet(url, accessToken): Promise<{ok:true, body:any} | {ok:false, error:GoogleApiError}>`,
  `classifyGoogleError(error: unknown): ConnectionFailureCode`, `accessTokenFrom(creds): string | null`.
  Tasks 2, 8, 9 (Gmail/Calendar/Drive adapters) all import these three.
- Consumes: `ConnectionFailureCode` from `./provider-adapter` (already exists, unchanged).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/skills/providers/google-api.util.spec.ts
import { googleApiGet, classifyGoogleError, accessTokenFrom } from './google-api.util';

describe('google-api.util', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('googleApiGet', () => {
    it('returns the parsed body on a 2xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ emailAddress: 'hr@company.com' }),
      }) as unknown as typeof fetch;

      const result = await googleApiGet(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        'tok',
      );
      expect(result).toEqual({ ok: true, body: { emailAddress: 'hr@company.com' } });
    });

    it('returns a structured error on a non-2xx response, using the sent bearer token', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: { status: 'PERMISSION_DENIED', message: 'Insufficient scope' },
        }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await googleApiGet(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        'tok',
      );
      expect(result).toEqual({
        ok: false,
        error: { status: 403, reason: 'PERMISSION_DENIED', message: 'Insufficient scope' },
      });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.authorization).toBe('Bearer tok');
    });
  });

  describe('classifyGoogleError', () => {
    it('maps a 401 with UNAUTHENTICATED to EXPIRED', () => {
      expect(classifyGoogleError({ status: 401, reason: 'UNAUTHENTICATED', message: '' })).toBe(
        'EXPIRED',
      );
    });
    it('maps a bare 401 to AUTH_FAILED', () => {
      expect(classifyGoogleError({ status: 401, reason: null, message: '' })).toBe('AUTH_FAILED');
    });
    it('maps a 403 to INSUFFICIENT_SCOPE', () => {
      expect(classifyGoogleError({ status: 403, reason: 'PERMISSION_DENIED', message: '' })).toBe(
        'INSUFFICIENT_SCOPE',
      );
    });
    it('maps a 404 to ACCOUNT_NOT_FOUND', () => {
      expect(classifyGoogleError({ status: 404, reason: null, message: '' })).toBe(
        'ACCOUNT_NOT_FOUND',
      );
    });
    it('extracts an embedded status code from a plain error string (google-calendar.util shape)', () => {
      expect(classifyGoogleError('Calendar API error (403): insufficient scope')).toBe(
        'INSUFFICIENT_SCOPE',
      );
    });
    it('maps a thrown network error to CONNECTION_FAILED', () => {
      expect(classifyGoogleError(new Error('fetch failed'))).toBe('CONNECTION_FAILED');
    });
    it('falls back to ERROR for an unrecognisable shape', () => {
      expect(classifyGoogleError('nonsense')).toBe('ERROR');
    });
  });

  describe('accessTokenFrom', () => {
    it('reads accessToken or access_token, trims, and returns null when absent', () => {
      expect(accessTokenFrom({ accessToken: ' a ' })).toBe('a');
      expect(accessTokenFrom({ access_token: 'b' })).toBe('b');
      expect(accessTokenFrom({})).toBeNull();
      expect(accessTokenFrom({ accessToken: '' })).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/google-api.util.spec.ts`
Expected: FAIL — `Cannot find module './google-api.util'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/skills/providers/google-api.util.ts
import { asFetchResponse } from '../../../common/http/fetch-response';
import type { ConnectionFailureCode } from './provider-adapter';

/**
 * Shared, plain-function Google API helpers for the Wave-2 adapters (Gmail,
 * Calendar, Drive all speak the same Google JSON-error shape). Mirrors
 * `google-calendar.util.ts`'s "no injected services, just an access token in"
 * design so adapters stay easy to unit test.
 */

const GOOGLE_TIMEOUT_MS = 10_000;

export interface GoogleApiError {
  status: number;
  /** Google's `error.status` enum value, e.g. `PERMISSION_DENIED`. */
  reason: string | null;
  message: string;
}

export type GoogleApiResult<T> =
  | { ok: true; body: T }
  | { ok: false; error: GoogleApiError };

/** GET a Google API endpoint with a bearer token. Never throws for an HTTP-level failure. */
export async function googleApiGet<T = Record<string, unknown>>(
  url: string,
  accessToken: string,
): Promise<GoogleApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const res = await asFetchResponse(
      await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: { status?: string; message?: string };
    } & T;
    if (!res.ok) {
      return {
        ok: false,
        error: {
          status: res.status,
          reason: body?.error?.status ?? null,
          message: body?.error?.message ?? `Google API error (${res.status})`,
        },
      };
    }
    return { ok: true, body: body as T };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps a Google-shaped error (from {@link googleApiGet}, a thrown network
 * error, or the plain `"... (403): ..."` strings `google-calendar.util.ts`
 * already returns) onto the plan §3 vocabulary. A thrown `Error` is always a
 * network/timeout/DNS problem here — HTTP-level failures never throw.
 */
export function classifyGoogleError(error: unknown): ConnectionFailureCode {
  if (error instanceof Error) {
    return 'CONNECTION_FAILED';
  }
  const shape = normalise(error);
  if (!shape) return 'ERROR';
  if (shape.status === 401) return shape.reason === 'UNAUTHENTICATED' ? 'EXPIRED' : 'AUTH_FAILED';
  if (shape.status === 403) return 'INSUFFICIENT_SCOPE';
  if (shape.status === 404) return 'ACCOUNT_NOT_FOUND';
  if (shape.status >= 500) return 'CONNECTION_FAILED';
  return 'ERROR';
}

function normalise(error: unknown): { status: number; reason: string | null } | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const e = error as GoogleApiError;
    return { status: e.status, reason: e.reason ?? null };
  }
  if (typeof error === 'string') {
    const match = error.match(/\((\d{3})\)/);
    if (match) return { status: Number(match[1]), reason: null };
  }
  return null;
}

/** First non-empty trimmed access token field (providers spell it differently). */
export function accessTokenFrom(creds: Record<string, unknown>): string | null {
  const token = creds['accessToken'] ?? creds['access_token'];
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/google-api.util.spec.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/skills/providers/google-api.util.ts apps/api/src/modules/skills/providers/google-api.util.spec.ts
git commit -m "feat(skills): add shared Google API helper for Wave-2 adapters"
```

---

### Task 2: Gmail adapter

**Files:**
- Create: `apps/api/src/modules/skills/providers/gmail.adapter.ts`
- Test: `apps/api/src/modules/skills/providers/gmail.adapter.spec.ts`
- Modify: `apps/api/src/modules/skills/providers/index.ts`
- Modify: `apps/api/src/modules/skills/connectors/health-probe.ts`

**Interfaces:**
- Consumes: `googleApiGet`, `classifyGoogleError`, `accessTokenFrom` from Task 1;
  `SkillProviderAdapter`, `AdapterInput`, `AdapterCheck`, `DiscoveredAccount`, `ConnectionFailureCode`
  from `./provider-adapter` (unchanged).
- Produces: `gmailAdapter: SkillProviderAdapter` (`key: 'gmail'`), registered so
  `getProviderAdapter('gmail')` returns it from Task 3 onward.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/skills/providers/gmail.adapter.spec.ts
import { gmailAdapter } from './gmail.adapter';

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
  const fn = jest.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('gmailAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports INVALID_CREDENTIALS when there is no access token', async () => {
    const result = await gmailAdapter.validateCredentials({ creds: {}, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('validateCredentials passes on a real profile fetch and names the account', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ emailAddress: 'hr@company.com' }) });
    const result = await gmailAdapter.validateCredentials({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('hr@company.com');
  });

  it('classifies a 403 as INSUFFICIENT_SCOPE with a safe detail message', async () => {
    mockFetchSequence({
      ok: false,
      status: 403,
      json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Insufficient scope' } }),
    });
    const result = await gmailAdapter.validateCredentials({ creds: { accessToken: 'tok' }, config: {} });
    expect(result).toEqual({ ok: false, detail: 'Insufficient scope', code: 'INSUFFICIENT_SCOPE' });
  });

  it('discoverAccount returns the profile email', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ emailAddress: 'hr@company.com' }) });
    const result = await gmailAdapter.discoverAccount!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result).toEqual({ account: 'hr@company.com' });
  });

  it('validateInbound reports an honest "assumed" pass — Gmail is polled, not configured here', async () => {
    const result = await gmailAdapter.validateInbound!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.assumed).toBe(true);
  });

  it('test() defaults to the connection\'s own address and sends a real message', async () => {
    const fetchMock = mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ emailAddress: 'hr@company.com' }) }, // discoverAccount
      { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) }, // send
    );
    const result = await gmailAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('hr@company.com');
    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toContain('/messages/send');
    const body = JSON.parse((sendInit as { body: string }).body);
    expect(typeof body.raw).toBe('string');
  });

  it('test() sends to an explicit address when opts.to is given, without a discoverAccount call', async () => {
    const fetchMock = mockFetchSequence({ ok: true, status: 200, json: async () => ({ id: 'msg-2' }) });
    const result = await gmailAdapter.test!(
      { creds: { accessToken: 'tok' }, config: {} },
      { to: 'someone@else.com' },
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('healthCheck delegates to validateCredentials', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ emailAddress: 'hr@company.com' }) });
    const result = await gmailAdapter.healthCheck!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
  });

  it('classifyError delegates to classifyGoogleError', () => {
    expect(gmailAdapter.classifyError({ status: 401, reason: 'UNAUTHENTICATED', message: '' })).toBe(
      'EXPIRED',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/gmail.adapter.spec.ts`
Expected: FAIL — `Cannot find module './gmail.adapter'`.

- [ ] **Step 3: Implement the adapter**

```ts
// apps/api/src/modules/skills/providers/gmail.adapter.ts
import { googleApiGet, classifyGoogleError, accessTokenFrom } from './google-api.util';
import type {
  AdapterCheck,
  AdapterInput,
  ConnectionFailureCode,
  DiscoveredAccount,
  SkillProviderAdapter,
} from './provider-adapter';

/**
 * GMAIL — plan §8. Mailbox integration: send + (eventually) read inbox. Inbound
 * mail is POLLED by the existing `gmail-inbound.service.ts` cron, not configured
 * per-connection here, so `validateInbound` reports a fact, not a live check.
 */

const MISSING = 'Reconnect this Google account — no access token is stored yet.';
const SEND_TIMEOUT_MS = 10_000;

export const gmailAdapter: SkillProviderAdapter = {
  key: 'gmail',

  /** A real, cheap authenticated call — proves the token actually works. */
  async validateCredentials(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const result = await googleApiGet<{ emailAddress?: string }>(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      token,
    );
    if (!result.ok) {
      return { ok: false, detail: result.error.message, code: classifyGoogleError(result.error) };
    }
    return { ok: true, detail: `Signed in to Gmail as ${result.body.emailAddress}` };
  },

  async discoverAccount(input: AdapterInput): Promise<DiscoveredAccount> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { account: null };
    const result = await googleApiGet<{ emailAddress?: string }>(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      token,
    );
    return { account: result.ok ? (result.body.emailAddress ?? null) : null };
  },

  /**
   * Scopes are requested as a fixed pair (`gmail.send` + `gmail.readonly`)
   * regardless of tenant config — a documented, deferred gap
   * (`04-skills-connectors.md`). This states the current fact rather than
   * performing a live check; `assumed: true` keeps it from ever looking like a
   * verified pass (plan §37).
   */
  async validateInbound(): Promise<AdapterCheck> {
    return {
      ok: true,
      assumed: true,
      detail: 'Orlixa polls Gmail for new mail on a schedule; nothing to configure here.',
    };
  },

  /** §8 "Test Send" — a real email, defaulting to the connection's own address. */
  async test(input: AdapterInput, opts?: { to?: string }): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const explicit = (opts?.to ?? '').trim();
    const to = explicit || (await gmailAdapter.discoverAccount!(input)).account;
    if (!to) {
      return {
        ok: false,
        detail: 'Could not determine the mailbox address to send to.',
        code: 'ACCOUNT_NOT_FOUND',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: buildTestMessage(to) }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: { status?: string; message?: string };
      };
      if (!res.ok || !body.id) {
        return {
          ok: false,
          detail: body.error?.message ?? `Gmail send failed (${res.status})`,
          code: classifyGoogleError({
            status: res.status,
            reason: body.error?.status ?? null,
            message: body.error?.message ?? '',
          }),
        };
      }
      return { ok: true, detail: `Test email sent to ${to} (message ${body.id})` };
    } catch (error) {
      return { ok: false, detail: message(error), code: classifyGoogleError(error) };
    } finally {
      clearTimeout(timer);
    }
  },

  /** §33 liveness: the same authenticated profile fetch, no send. */
  async healthCheck(input: AdapterInput): Promise<AdapterCheck> {
    return gmailAdapter.validateCredentials(input);
  },

  classifyError(error: unknown): ConnectionFailureCode {
    return classifyGoogleError(error);
  },
};

/** RFC 2822 message, base64url-encoded per Gmail's `messages.send` contract. */
function buildTestMessage(to: string): string {
  const lines = [
    `To: ${to}`,
    'Subject: Orlixa connection test',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'This is a test message from Orlixa confirming your Gmail connection works.',
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/gmail.adapter.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Register the adapter and its health probe**

Read `apps/api/src/modules/skills/providers/index.ts` first (it currently has exactly one line,
`registerProviderAdapter(smtpAdapter)`) and add:

```ts
// apps/api/src/modules/skills/providers/index.ts
import { registerProviderAdapter } from './provider-adapter';
import { smtpAdapter } from './smtp.adapter';
import { gmailAdapter } from './gmail.adapter';

registerProviderAdapter(smtpAdapter);
registerProviderAdapter(gmailAdapter);

export * from './provider-adapter';
```

(Keep whatever `export *` / re-export lines already exist in the file — only add the new import and
registration call; do not remove the existing `smtpAdapter` line.)

In `apps/api/src/modules/skills/connectors/health-probe.ts`, add one entry to the existing `PROBES` map
(currently `{ github: githubProbe, email: adapterProbe('email') }`):

```ts
const PROBES: Record<string, HealthProbe> = {
  github: githubProbe,
  email: adapterProbe('email'),
  gmail: adapterProbe('gmail'),
};
```

- [ ] **Step 6: Run the full unit suite to confirm no regression**

Run: `pnpm run test:unit` (from `apps/api`)
Expected: PASS, same or higher total count than before this task.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/skills/providers/gmail.adapter.ts apps/api/src/modules/skills/providers/gmail.adapter.spec.ts apps/api/src/modules/skills/providers/index.ts apps/api/src/modules/skills/connectors/health-probe.ts
git commit -m "feat(skills): add real Gmail provider adapter + health probe"
```

---

### Task 3: Shared credential-freshness helper + refactor `resolveExecutorContext`

**Files:**
- Modify: `apps/api/src/modules/skills/connectors/credentials.util.ts`
- Create: `apps/api/src/modules/skills/connectors/credentials.util.spec.ts` (no existing spec file for
  this util today — confirmed via `Glob apps/api/src/modules/skills/connectors/*.spec.ts`)
- Modify: `apps/api/src/modules/skills/skills.service.ts` (`resolveExecutorContext`, ~lines 800-836)

**Interfaces:**
- Produces: `resolveFreshCredentials(tokens: AccessTokenResolver, installed: {id, connectionType},
  credentials: Record<string, unknown>, onRefreshError?: (message: string) => void): Promise<Record<string, unknown>>`
  and the `AccessTokenResolver` interface (`{ getAccessToken(installedSkillId: string): Promise<string> }`
  — matches `ConnectorTokenService.getAccessToken`'s real signature exactly, confirmed by reading
  `connector-token.service.ts:67`). Tasks 4 and 6 both call this.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/skills/connectors/credentials.util.spec.ts
import { resolveFreshCredentials, type AccessTokenResolver } from './credentials.util';

describe('resolveFreshCredentials', () => {
  it('returns credentials unchanged for a non-oauth connection', async () => {
    const tokens: AccessTokenResolver = { getAccessToken: jest.fn() };
    const creds = { smtpPassword: 'secret' };
    const result = await resolveFreshCredentials(tokens, { id: 'c1', connectionType: 'api_key' }, creds);
    expect(result).toBe(creds);
    expect(tokens.getAccessToken).not.toHaveBeenCalled();
  });

  it('returns credentials unchanged for oauth with no refresh token', async () => {
    const tokens: AccessTokenResolver = { getAccessToken: jest.fn() };
    const creds = { accessToken: 'still-valid' };
    const result = await resolveFreshCredentials(tokens, { id: 'c1', connectionType: 'oauth' }, creds);
    expect(result).toBe(creds);
    expect(tokens.getAccessToken).not.toHaveBeenCalled();
  });

  it('splices in a fresh access token for oauth with a refresh token', async () => {
    const tokens: AccessTokenResolver = { getAccessToken: jest.fn().mockResolvedValue('fresh-token') };
    const creds = { accessToken: 'stale', refreshToken: 'rt-1' };
    const result = await resolveFreshCredentials(tokens, { id: 'c1', connectionType: 'oauth' }, creds);
    expect(result).toEqual({ accessToken: 'fresh-token', refreshToken: 'rt-1' });
    expect(tokens.getAccessToken).toHaveBeenCalledWith('c1');
  });

  it('keeps the original credentials and reports the error when refresh throws', async () => {
    const tokens: AccessTokenResolver = {
      getAccessToken: jest.fn().mockRejectedValue(new Error('invalid_grant')),
    };
    const creds = { accessToken: 'stale', refreshToken: 'rt-1' };
    const onError = jest.fn();
    const result = await resolveFreshCredentials(
      tokens,
      { id: 'c1', connectionType: 'oauth' },
      creds,
      onError,
    );
    expect(result).toBe(creds);
    expect(onError).toHaveBeenCalledWith('invalid_grant');
  });

  it('keeps the original credentials when getAccessToken returns empty (connector not found)', async () => {
    const tokens: AccessTokenResolver = { getAccessToken: jest.fn().mockResolvedValue('') };
    const creds = { accessToken: 'stale', refreshToken: 'rt-1' };
    const result = await resolveFreshCredentials(tokens, { id: 'c1', connectionType: 'oauth' }, creds);
    expect(result).toBe(creds);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/connectors/credentials.util.spec.ts`
Expected: FAIL — `resolveFreshCredentials` is not exported.

- [ ] **Step 3: Implement**

Add to the end of `apps/api/src/modules/skills/connectors/credentials.util.ts` (keep every existing
export — `readCredentials`, `sealCredentials`, `credString` — unchanged):

```ts
/** The one method `resolveFreshCredentials` needs — satisfied by `ConnectorTokenService` as-is. */
export interface AccessTokenResolver {
  getAccessToken(installedSkillId: string): Promise<string>;
}

/**
 * Refresh an OAuth connector's access token if it's near/passed expiry, and
 * return credentials with the fresh value spliced in. Extracted from
 * `SkillsService.resolveExecutorContext` (the tool-execution path already did
 * this) so `verifyConnection` and the health-check sweep get the SAME
 * guarantee: neither should report a perfectly valid connection as broken just
 * because the last real tool call was over an hour ago.
 *
 * Non-oauth connectors, and oauth connectors with no refresh token, are
 * returned unchanged — mirrors the existing tool-execution check exactly.
 */
export async function resolveFreshCredentials(
  tokens: AccessTokenResolver,
  installed: { id: string; connectionType: string | null },
  credentials: Record<string, unknown>,
  onRefreshError?: (message: string) => void,
): Promise<Record<string, unknown>> {
  const hasRefreshToken = Boolean(credString(credentials, 'refreshToken', 'refresh_token'));
  if (installed.connectionType !== 'oauth' || !hasRefreshToken) {
    return credentials;
  }
  try {
    const fresh = await tokens.getAccessToken(installed.id);
    if (fresh) {
      return { ...credentials, accessToken: fresh };
    }
  } catch (err) {
    onRefreshError?.(err instanceof Error ? err.message : String(err));
  }
  return credentials;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/connectors/credentials.util.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Refactor `resolveExecutorContext` onto the new helper (behavior-preserving)**

In `apps/api/src/modules/skills/skills.service.ts`, find `resolveExecutorContext` (~line 800). Replace
this existing block:

```ts
    const credentials = this.readCredentials(installed.credentials);
    // OAuth egress uses a FRESH access token: when the connector has a refresh
    // token and its cached expiry is near/passed, ConnectorTokenService renews it
    // (single-flight) and persists the new token. API-key connectors are
    // unaffected (no refresh token → the stored value is used as-is).
    if (
      installed.connectionType === 'oauth' &&
      credString(credentials, 'refreshToken', 'refresh_token')
    ) {
      try {
        const fresh = await this.tokens.getAccessToken(installed.id);
        if (fresh) {
          credentials.accessToken = fresh;
        }
      } catch (err) {
        // Refresh failed (revoked → ConnectorTokenService already flipped the
        // connector DISCONNECTED; or a provider misconfig). Leave creds as-is: the
        // executor surfaces the auth error and dependent workflows quarantine.
        this.logger.warn(
          `Token refresh failed for connector ${installed.id} (${skillKey}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
```

with:

```ts
    const credentials = await resolveFreshCredentials(
      this.tokens,
      installed,
      this.readCredentials(installed.credentials),
      (msg) => this.logger.warn(`Token refresh failed for connector ${installed.id} (${skillKey}): ${msg}`),
    );
```

Add the import at the top of `skills.service.ts` (alongside the existing
`import { credString, readCredentials as decryptCreds, ... } from './connectors/credentials.util';` —
check the exact existing import line and add `resolveFreshCredentials` to it rather than creating a
second import from the same module):

```ts
import { credString, readCredentials as decryptCreds, resolveFreshCredentials, /* ...existing... */ } from './connectors/credentials.util';
```

- [ ] **Step 6: Run the skills service unit suite to confirm the refactor is behavior-preserving**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/skills.service.spec.ts`
Expected: PASS, identical pass count to before this step (this is a pure refactor — no test should need
to change).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/skills/connectors/credentials.util.ts apps/api/src/modules/skills/connectors/credentials.util.spec.ts apps/api/src/modules/skills/skills.service.ts
git commit -m "refactor(skills): extract resolveFreshCredentials, reuse in resolveExecutorContext"
```

---

### Task 4: `verifyConnection()` — `adapterAvailable` + fresh credentials

**Files:**
- Modify: `apps/api/src/modules/skills/skills.service.ts` (`verifyConnection`, ~lines 973-1059)
- Modify: `apps/api/src/modules/skills/skills.service.spec.ts`
- Modify: `apps/web/src/features/skills/api.ts` (`VerifyConnectionResult`)

**Interfaces:**
- Consumes: `resolveFreshCredentials` from Task 3.
- Produces: `verifyConnection(...)` now resolves to `{ ok, steps, account, code?, connectionStatus,
  adapterAvailable: boolean }`. Task 7 (frontend wizard) reads `adapterAvailable` off this response.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/modules/skills/skills.service.spec.ts`, following the file's existing convention
(confirmed by reading it — the `describe('SkillsService.runTool least-privilege gate', ...)` block at
the top of the file uses plain object-literal Prisma doubles cast `as never` and constructs
`SkillsService` positionally as `(prisma, crypto, health, tokens, breakers, rateLimiter, executor,
auditLog, metrics, suppression)`):

```ts
import { MetricsRegistry } from '../../common/observability/metrics.registry';

describe('SkillsService.verifyConnection — adapterAvailable', () => {
  function buildService(installed: Record<string, unknown>) {
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(installed),
        update: jest.fn().mockResolvedValue({}),
      },
    } as never;
    const tokens = { getAccessToken: jest.fn() } as never;
    return new SkillsService(
      prisma,
      {} as never,
      {} as never,
      tokens,
      {} as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      new MetricsRegistry(),
      { findSuppressed: jest.fn().mockResolvedValue([]) } as never,
    );
  }

  afterEach(() => jest.restoreAllMocks());

  it('reports adapterAvailable:false for a skill with no registered adapter (stripe)', async () => {
    const service = buildService({
      id: 'is-1',
      companyId: 'c1',
      skillKey: 'stripe',
      connectionType: 'api_key',
      connectionStatus: 'NOT_CONNECTED',
      credentials: {},
      config: {},
    });
    const result = await service.verifyConnection('c1', 'is-1', {});
    expect(result.adapterAvailable).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('reports adapterAvailable:true for an adapter-backed skill (gmail)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ emailAddress: 'hr@company.com' }),
    }) as unknown as typeof fetch;
    const service = buildService({
      id: 'is-2',
      companyId: 'c1',
      skillKey: 'gmail',
      connectionType: 'oauth',
      connectionStatus: 'NOT_CONNECTED',
      credentials: { accessToken: 'tok' },
      config: {},
    });
    const result = await service.verifyConnection('c1', 'is-2', {});
    expect(result.adapterAvailable).toBe(true);
    expect(result.ok).toBe(true);
  });
});
```

If `SkillsService`'s tenant-owned lookup (the private `findOwnedInstalled`) uses a Prisma call other
than `installedSkill.findFirst`, confirm by reading that method before running this and adjust the
`prisma` double to match exactly — do not guess a second time if the first assumption is wrong.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/skills.service.spec.ts -t "adapterAvailable"`
Expected: FAIL — `adapterAvailable` is `undefined`.

- [ ] **Step 3: Implement**

In `verifyConnection` (`skills.service.ts`), update the method's declared return type to add
`adapterAvailable: boolean` alongside the existing fields. Update the no-adapter early return:

```ts
    if (!adapter) {
      return {
        ok: false,
        steps: [
          {
            key: 'credentials',
            label: 'Sign in to the provider',
            status: 'SKIPPED',
            detail: 'Orlixa cannot verify this provider automatically yet.',
          },
        ],
        account: null,
        connectionStatus: current,
        adapterAvailable: false,
      };
    }
```

Use `resolveFreshCredentials` when building the adapter input:

```ts
    const credentials = await resolveFreshCredentials(
      this.tokens,
      installed,
      this.readCredentials(installed.credentials),
      (msg) => this.logger.warn(`Token refresh failed for connector ${installed.id}: ${msg}`),
    );
    const input = {
      creds: credentials,
      config: (installed.config as Record<string, unknown> | null) ?? {},
    };
```

And the final return statement:

```ts
    return { ...result, connectionStatus: nextStatus, adapterAvailable: true };
```

In `apps/web/src/features/skills/api.ts`, add the field to the existing interface:

```ts
export interface VerifyConnectionResult {
  ok: boolean;
  steps: VerifyStepResult[];
  account: string | null;
  code?: string;
  connectionStatus: string;
  adapterAvailable: boolean;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/skills.service.spec.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/skills/skills.service.ts apps/api/src/modules/skills/skills.service.spec.ts apps/web/src/features/skills/api.ts
git commit -m "feat(skills): expose adapterAvailable on verifyConnection, use fresh credentials"
```

---

### Task 5: `connectOAuth()` — verify before `CONNECTED`

**Files:**
- Modify: `apps/api/src/modules/skills/skills.service.ts` (`connectOAuth`, ~lines 1061-1084)
- Modify: `apps/api/src/modules/skills/skills.service.spec.ts`

**Interfaces:**
- Consumes: `getProviderAdapter`, `runVerification` (already imported in this file), `gmailAdapter`
  registered from Task 2 (used as the "adapter-backed" case in tests).
- Produces: no signature change to `connectOAuth(companyId, installedSkillId, tokens)` — same call
  sites (the OAuth callback controller) need no change.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/modules/skills/skills.service.spec.ts`, same object-literal-double style as Task
4's `buildService` (a separate helper here since `connectOAuth` needs `findFirst` to return a row with
an existing `connectionStatus`, and asserts on what was passed to `update`/`record` rather than reading
a value back from a stateful fake database):

```ts
describe('SkillsService.connectOAuth — verify before CONNECTED', () => {
  function buildService(installed: Record<string, unknown>) {
    const update = jest.fn().mockResolvedValue({});
    const record = jest.fn();
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(installed),
        update,
      },
    } as never;
    const tokens = { getAccessToken: jest.fn() } as never;
    const service = new SkillsService(
      prisma,
      {} as never,
      {} as never,
      tokens,
      {} as never,
      {} as never,
      {} as never,
      { record } as never,
      new MetricsRegistry(),
      { findSuppressed: jest.fn().mockResolvedValue([]) } as never,
    );
    return { service, update, record };
  }

  afterEach(() => jest.restoreAllMocks());

  it('sets CONNECTED and audits connector.connected when the adapter verifies successfully', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ emailAddress: 'hr@company.com' }),
    }) as unknown as typeof fetch;
    const { service, update, record } = buildService({
      id: 'is-1',
      companyId: 'c1',
      skillKey: 'gmail',
      connectionType: 'oauth',
      connectionStatus: 'NOT_CONNECTED',
      credentials: {},
      config: {},
    });

    await service.connectOAuth('c1', 'is-1', { accessToken: 'tok' });

    expect(update.mock.calls[0][0].data.connectionStatus).toBe('CONNECTED');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'connector.connected' }),
    );
  });

  it('sets NOT_CONNECTED (not DEGRADED) on a failed first-time verification', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Insufficient scope' } }),
    }) as unknown as typeof fetch;
    const { service, update, record } = buildService({
      id: 'is-2',
      companyId: 'c1',
      skillKey: 'gmail',
      connectionType: 'oauth',
      connectionStatus: 'NOT_CONNECTED',
      credentials: {},
      config: {},
    });

    await service.connectOAuth('c1', 'is-2', { accessToken: 'bad-scope-tok' });

    expect(update.mock.calls[0][0].data.connectionStatus).toBe('NOT_CONNECTED');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'connector.connect_failed' }),
    );
  });

  it('keeps the unconditional CONNECTED behavior for a skill with no adapter (hubspot)', async () => {
    const { service, update } = buildService({
      id: 'is-3',
      companyId: 'c1',
      skillKey: 'hubspot',
      connectionType: 'oauth',
      connectionStatus: 'NOT_CONNECTED',
      credentials: {},
      config: {},
    });

    await service.connectOAuth('c1', 'is-3', { accessToken: 'tok' });

    expect(update.mock.calls[0][0].data.connectionStatus).toBe('CONNECTED');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/skills.service.spec.ts -t "connectOAuth"`
Expected: FAIL — status is unconditionally `CONNECTED`, no audit call.

- [ ] **Step 3: Implement**

Replace `connectOAuth` in `skills.service.ts`:

```ts
  async connectOAuth(
    companyId: string,
    installedSkillId: string,
    tokens: Record<string, unknown>,
  ): Promise<void> {
    const installed = await this.findOwnedInstalled(companyId, installedSkillId);
    const merged = {
      ...this.readCredentials(installed.credentials),
      ...tokens,
    };

    const adapter = getProviderAdapter(installed.skillKey);
    let connectionStatus: SkillConnectionStatus = 'CONNECTED';
    let account: string | null = null;
    let failureCode: string | undefined;
    let steps: VerifyStep[] = [];

    if (adapter) {
      const current = installed.connectionStatus as SkillConnectionStatus;
      const result = await runVerification(
        adapter,
        { creds: merged, config: (installed.config as Record<string, unknown> | null) ?? {} },
        { includeTest: false },
      );
      steps = result.steps;
      account = result.account;
      failureCode = result.code;
      // Same rule verifyConnection() uses: a first-time connect's `current` is
      // always NOT_CONNECTED, so a failed verification lands there too, never
      // DEGRADED (which would wrongly imply a working connection broke).
      connectionStatus = result.ok
        ? 'CONNECTED'
        : current === 'CONNECTED'
          ? 'DEGRADED'
          : 'NOT_CONNECTED';
    }

    await this.prisma.installedSkill.update({
      where: { id: installedSkillId },
      data: {
        credentials: this.sealCredentials(merged),
        connectionType: this.defFor(installed.skillKey).connection.type,
        connectionStatus,
        consecutiveErrors: 0,
        lastHealthError: connectionStatus === 'CONNECTED' ? null : (lastFailure(steps) ?? null),
        disabledReason: null,
        tokenExpiresAt: this.parseExpiry(merged),
        ...(account
          ? {
              config: {
                ...((installed.config as Record<string, unknown> | null) ?? {}),
                connectedAccount: account,
              } as Prisma.InputJsonObject,
            }
          : {}),
      },
    });

    await this.auditLog.record({
      companyId,
      action: connectionStatus === 'CONNECTED' ? 'connector.connected' : 'connector.connect_failed',
      entityType: 'InstalledSkill',
      entityId: installedSkillId,
      metadata: {
        skillKey: installed.skillKey,
        connectionType: this.defFor(installed.skillKey).connection.type,
        account,
        code: failureCode ?? null,
      },
    });
  }
```

Check whether a `lastFailure(steps: VerifyStep[]): string | null` helper already exists in this file
(it is referenced by the existing `verifyConnection` method's `lastHealthError` line — reuse it; do not
redefine it). If `VerifyStep`/`SkillConnectionStatus`/`Prisma` aren't already imported at the top of this
file, they are (this file already uses all three in `verifyConnection` a few dozen lines above) — no new
imports needed for this task.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/skills.service.spec.ts`
Expected: PASS, full file green, including the pre-existing non-OAuth `connectSkill` regression tests
unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/skills/skills.service.ts apps/api/src/modules/skills/skills.service.spec.ts
git commit -m "fix(skills): verify OAuth connections before marking CONNECTED"
```

---

### Task 6: Health-check sweep uses fresh credentials

**⚠️ Circular DI risk, resolved below — read before implementing.** `ConnectorTokenService` already
imports and constructor-injects `ConnectorHealthService` (to call `markDisconnected` on a revoked
refresh — confirmed in `connector-token.service.ts:10,57`, real constructor:
`(prisma, crypto, config, health: ConnectorHealthService, @Inject(CONNECTOR_FETCH) fetchImpl,
metrics)`). Naively adding `ConnectorTokenService` as a plain constructor param on
`ConnectorHealthService` creates a circular dependency graph Nest cannot resolve without `forwardRef`
on **both** sides. This is a same-module provider cycle (both live in `SkillsModule`) — the standard,
well-supported NestJS pattern for exactly this shape, and does not require touching either service's
actual logic, only the DI decorator on each side's existing parameter.

**Files:**
- Modify: `apps/api/src/modules/skills/connectors/connector-health.service.ts` (constructor +
  `runProbe`, lines 41-54 and 237-249 of the file as read for this plan)
- Modify: `apps/api/src/modules/skills/connectors/connector-token.service.ts` (constructor, line 57 —
  wrap the existing `health` param in `forwardRef`; no other change)
- Create: `apps/api/src/modules/skills/connectors/connector-health.service.spec.ts` (confirmed via
  `Glob apps/api/src/modules/skills/connectors/*.spec.ts` — no spec file exists for this service today)

**Interfaces:**
- Consumes: `resolveFreshCredentials`, `AccessTokenResolver` from Task 3; `gmailAdapter` registered
  from Task 2 (used as the real-integration case in the new spec).

- [ ] **Step 1: Break the cycle with `forwardRef` on both sides**

In `apps/api/src/modules/skills/connectors/connector-token.service.ts`, its `@nestjs/common` import
already includes `Inject` (line 1: `import { Inject, Injectable, Logger } from '@nestjs/common';`) —
add `forwardRef` to it:

```ts
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
```

Change the constructor's existing `health` parameter (line 57):

```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => ConnectorHealthService))
    private readonly health: ConnectorHealthService,
    @Inject(CONNECTOR_FETCH) private readonly fetchImpl: FetchLike,
    private readonly metrics: MetricsRegistry,
  ) {}
```

In `apps/api/src/modules/skills/connectors/connector-health.service.ts`, add `Inject`/`forwardRef` to
its existing `@nestjs/common` import (line 1: `import { Injectable, Logger, NotFoundException } from
'@nestjs/common';`):

```ts
import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
```

Add the import `import { ConnectorTokenService } from './connector-token.service';` and change the
constructor (lines 47-54):

```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    config: ConfigService,
    @Inject(forwardRef(() => ConnectorTokenService))
    private readonly tokens: ConnectorTokenService,
  ) {
    const mode = (config.get<string>('SKILL_EXECUTOR') ?? 'mock').toLowerCase();
    this.liveProbes = mode === 'real' || mode === 'auto';
  }
```

- [ ] **Step 2: Verify the DI graph actually resolves before writing more code**

Run: `pnpm test -- --testPathPattern=engines-support` (from `apps/api` — or any single fast e2e spec;
the point is booting the full Nest application, which is what actually exercises the DI graph, not a
unit test with hand-built fixtures)
Expected: the app boots and the suite runs. If Nest throws `Error: Nest can't resolve dependencies of
the ConnectorTokenService (?, ...)` or similar at this step, the `forwardRef` wiring above has a mistake
— stop and fix it before proceeding; nothing past this point can be trusted until the app boots clean.

- [ ] **Step 3: Write the failing test (new file — no existing spec for this service)**

```ts
// apps/api/src/modules/skills/connectors/connector-health.service.spec.ts
import type { ConfigService } from '@nestjs/config';
import type { InstalledSkill } from '@prisma/client';
import { ConnectorHealthService } from './connector-health.service';
import type { AccessTokenResolver } from './credentials.util';
// Import side effect: registers the real provider adapters (gmail, email, ...)
// into the shared registry this service reads via getHealthProbe/getProviderAdapter.
import '../providers';

function buildConnector(overrides: Partial<InstalledSkill>): InstalledSkill {
  return {
    id: 'conn-1',
    companyId: 'company-1',
    skillKey: 'gmail',
    employeeId: null,
    displayName: 'Gmail',
    connectionType: 'oauth',
    connectionStatus: 'CONNECTED',
    consecutiveErrors: 0,
    credentials: {},
    config: {},
    enabled: true,
    createdAt: new Date(),
    lastHealthCheckAt: null,
    lastHealthError: null,
    tokenExpiresAt: null,
    disabledReason: null,
    inboundCursor: null,
    ...overrides,
  } as unknown as InstalledSkill;
}

describe('ConnectorHealthService — token freshness', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refreshes a near-expired OAuth token before probing an adapter-backed connector', async () => {
    const connector = buildConnector({
      credentials: { accessToken: 'stale', refreshToken: 'rt-1' },
    });
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockResolvedValue(connector),
      },
    } as never;
    const config = { get: () => 'real' } as unknown as ConfigService;
    const getAccessToken = jest.fn().mockResolvedValue('fresh-token');
    const tokens: AccessTokenResolver = { getAccessToken };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ emailAddress: 'hr@company.com' }),
    }) as unknown as typeof fetch;

    const service = new ConnectorHealthService(prisma, {} as never, config, tokens as never);
    await service.runHealthCheck('company-1', 'conn-1');

    expect(getAccessToken).toHaveBeenCalledWith('conn-1');
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer fresh-token',
    );
  });

  it('does not call getAccessToken for a non-oauth connector', async () => {
    const connector = buildConnector({
      skillKey: 'stripe', // no registered adapter → genericProbe, no network call
      connectionType: 'api_key',
      credentials: { apiKey: 'sk-123' },
    });
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockResolvedValue(connector),
      },
    } as never;
    const config = { get: () => 'real' } as unknown as ConfigService;
    const getAccessToken = jest.fn();
    const tokens: AccessTokenResolver = { getAccessToken };

    const service = new ConnectorHealthService(prisma, {} as never, config, tokens as never);
    await service.runHealthCheck('company-1', 'conn-1');

    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('does nothing (no fetch, no refresh) when SKILL_EXECUTOR is mock', async () => {
    const connector = buildConnector({ credentials: { accessToken: 'stale', refreshToken: 'rt-1' } });
    const prisma = {
      installedSkill: {
        findFirst: jest.fn().mockResolvedValue(connector),
        update: jest.fn().mockResolvedValue(connector),
      },
    } as never;
    const config = { get: () => 'mock' } as unknown as ConfigService;
    const getAccessToken = jest.fn();
    const service = new ConnectorHealthService(prisma, {} as never, config, { getAccessToken } as never);

    const result = await service.runHealthCheck('company-1', 'conn-1');

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(result.status).toBe('CONNECTED');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/connectors/connector-health.service.spec.ts`
Expected: FAIL — `ConnectorHealthService`'s constructor doesn't yet accept a 4th `tokens` argument
(TypeScript error) until Step 1 above is applied; once Step 1 is applied but before Step 5's
`runProbe` change, the first test fails on the `authorization` header assertion (still `Bearer stale`).

- [ ] **Step 5: Implement `runProbe`**

```ts
  private async runProbe(connector: InstalledSkill) {
    if (!this.liveProbes) {
      return { healthy: true, mock: true };
    }
    const creds = await resolveFreshCredentials(
      this.tokens,
      connector,
      readCredentials(this.crypto, connector.credentials),
      (msg) => this.logger.warn(`Token refresh failed for connector ${connector.id}: ${msg}`),
    );
    const config = (connector.config as Record<string, unknown> | null) ?? {};
    try {
      return await getHealthProbe(connector.skillKey).probe(creds, config);
    } catch (err) {
      return { healthy: false, error: this.msg(err) };
    }
  }
```

Add `resolveFreshCredentials` to the file's existing `credentials.util` import (line 12:
`import { readCredentials, resolveFreshCredentials } from './credentials.util';`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/connectors/connector-health.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full unit suite AND an e2e pass to re-confirm the DI graph under real app boot**

Run: `pnpm run test:unit` (from `apps/api`), then `pnpm test`
Expected: both PASS, no regressions — this second full-app-boot check matters more than usual here
given Step 1's circular-DI fix; do not skip it.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/skills/connectors/connector-health.service.ts apps/api/src/modules/skills/connectors/connector-token.service.ts apps/api/src/modules/skills/connectors/connector-health.service.spec.ts
git commit -m "fix(health): refresh OAuth access token before probing connector health"
```

---

### Task 7: Frontend — universal Settings popup wizard

**Files:**
- Modify: `apps/web/src/features/skills/components/SkillSetupWizard.tsx`
- Modify: `apps/web/src/features/skills/components/InstalledSkillList.tsx`

**Interfaces:**
- Consumes: `Modal` from `@/components/ui/Modal` (existing, unchanged — `{open, onClose, title,
  children, size}`); `VerifyConnectionResult.adapterAvailable` from Task 4.
- Produces: no new exports — this is the UI's terminal task for this wave (Calendar/Drive/Slack in
  Tasks 8-10 need zero frontend change, since the wizard is already generic per-skill).

- [ ] **Step 1: Update `SkillSetupWizard.tsx` — remove the duplicate header, add the graceful no-adapter path**

Replace the component's outer wrapper and header block (the `<div className="rounded-2xl border...">`
through the closing of the `onClose` header block, roughly lines 77-98) — since this component now
always renders inside the `Modal` from Task 7's Step 2, which already provides a title bar and a close
button:

```tsx
export function SkillSetupWizard({
  installed,
  def,
  onClose,
}: {
  installed: InstalledSkillDto;
  def: SkillDefinitionDto;
  onClose?: () => void;
}) {
  const [stage, setStage] = useState<Stage>(
    installed.connectionStatus === 'CONNECTED' ? 'test' : 'details',
  );
  const [steps, setSteps] = useState<VerifyStepResult[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [adapterAvailable, setAdapterAvailable] = useState(true);
  const [testTo, setTestTo] = useState('');
  const verify = useVerifyConnection();

  const run = (sendTest: boolean) => {
    verify.mutate(
      { id: installed.id, sendTest, testTo: sendTest ? testTo : undefined },
      {
        onSuccess: (result) => {
          setSteps(result.steps);
          setAccount(result.account);
          setAdapterAvailable(result.adapterAvailable);
          if (!result.ok) return;
          setStage(sendTest ? 'done' : 'test');
        },
      },
    );
  };

  // Auto-run the check once, the first time this render reaches the `verify`
  // stage — so a skill with no adapter shows its honest "can't verify yet"
  // state immediately instead of behind an extra click. Guarded by a ref, not
  // a `run` dependency: `run` closes over the mutation object and is rebuilt
  // every render, and depending on it directly re-fires the effect on every
  // render (the exact infinite-loop shape already hit and fixed elsewhere in
  // this codebase's workflow canvas autosave).
  const autoChecked = useRef(false);
  useEffect(() => {
    if (stage !== 'verify' || autoChecked.current) return;
    autoChecked.current = true;
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const currentIndex = ORDER.findIndex((s) => s.key === stage);

  return (
    <div>
      <p className="mb-4 text-xs text-app-ink-3">
        Each step has to pass before this skill can run.
      </p>

      <ol className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {ORDER.map((s, i) => {
          const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo';
          return (
            <li key={s.key} className="flex items-center gap-1.5 text-xs">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                  state === 'done'
                    ? 'bg-status-succeeded/20 text-sl-succeeded'
                    : state === 'current'
                      ? 'bg-violet text-white'
                      : 'bg-app-raised text-app-ink-3'
                }`}
              >
                {state === 'done' ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              </span>
              <span className={state === 'todo' ? 'text-app-ink-3' : 'text-app-ink-2'}>
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {stage === 'details' ? (
        <ConfigureSkillForm
          installed={installed}
          def={def}
          onDone={() => setStage('verify')}
        />
      ) : null}

      {stage === 'verify' ? (
        <div className="space-y-3">
          {adapterAvailable ? (
            <>
              <p className="text-sm text-app-ink-2">
                Orlixa will sign in to the provider with the details you saved. Nothing
                is sent yet.
              </p>
              <StepList steps={steps} />
              <div className="flex items-center gap-2">
                <Button variant="violet" onClick={() => run(false)} disabled={verify.isPending}>
                  {verify.isPending ? 'Checking…' : 'Check connection'}
                </Button>
                <button
                  type="button"
                  onClick={() => setStage('details')}
                  className="text-xs text-app-ink-2 hover:text-app-ink"
                >
                  Back to details
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-app-ink-2">
                Orlixa can&apos;t automatically verify this provider yet — your settings
                are saved and this skill is ready to use.
              </p>
              <div className="flex items-center gap-2">
                <Button variant="violet" onClick={() => setStage('done')}>
                  Continue
                </Button>
                <button
                  type="button"
                  onClick={() => setStage('details')}
                  className="text-xs text-app-ink-2 hover:text-app-ink"
                >
                  Back to details
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {stage === 'test' ? (
        <div className="space-y-3">
          {account ? (
            <p className="text-sm text-sl-succeeded">
              Signed in as {account}.
            </p>
          ) : null}
          <p className="text-sm text-app-ink-2">
            Send one real test message to prove it works end to end.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder={account ? `${account} (itself)` : 'Where to send it'}
              aria-label="Send the test to"
              className="field-modern max-w-xs"
            />
            <Button variant="violet" onClick={() => run(true)} disabled={verify.isPending}>
              {verify.isPending ? 'Sending…' : 'Send test'}
            </Button>
            <button
              type="button"
              onClick={() => setStage('done')}
              className="text-xs text-app-ink-2 hover:text-app-ink"
            >
              Skip the test
            </button>
          </div>
          <StepList steps={steps} />
        </div>
      ) : null}

      {stage === 'done' ? (
        <div className="space-y-3">
          {adapterAvailable ? (
            <p className="flex items-center gap-1.5 text-sm text-sl-succeeded">
              <Check className="h-4 w-4" aria-hidden />
              {def.name} is connected{account ? ` as ${account}` : ''}.
            </p>
          ) : (
            <p className="text-sm text-app-ink-2">
              {def.name} is set up. Automatic verification isn&apos;t available for this
              provider yet.
            </p>
          )}
          <StepList steps={steps} />
          {onClose ? (
            <Button variant="violet" onClick={onClose}>
              Done
            </Button>
          ) : null}
        </div>
      ) : null}

      {verify.isError ? (
        <p className="mt-3 text-sm text-sl-failed">
          {verify.error?.message ?? 'Could not check the connection.'}
        </p>
      ) : null}
    </div>
  );
}
```

Add `useRef` to the existing `import { useState } from 'react';` line (`import { useEffect, useRef,
useState } from 'react';`). `StepList` and `WizardLoading` at the bottom of the file are unchanged.
Remove the now-unused `X` icon import if the header removal leaves it unused elsewhere in the file
(check — `StepList` uses `X` for FAILED steps, so it very likely stays imported; only remove it if a
check confirms zero remaining uses).

- [ ] **Step 2: Rewrite `InstalledSkillList.tsx` — one popup for every skill**

```tsx
// apps/web/src/features/skills/components/InstalledSkillList.tsx
'use client';

import { useEffect, useRef, useState, type ElementType } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Activity,
  Calendar,
  CalendarClock,
  CreditCard,
  Globe,
  Kanban,
  Mail,
  Power,
  PowerOff,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  GitHubIcon,
  GmailIcon,
  GoogleDriveIcon,
  HubSpotIcon,
  SlackIcon,
} from '@/components/marketing-dark/brand-icons';
import { Modal } from '@/components/ui/Modal';
import { RecentConnectorEvents } from '@/features/events/components/RecentConnectorEvents';
import {
  useCatalog,
  useCheckConnectorHealth,
  useInstalledSkills,
  useUninstallSkill,
  useUpdateInstalledSkill,
} from '../hooks';
import { CONNECTION_STATUS_STYLES, formatConnectionStatus } from '../labels';
import type { InstalledSkillDto, SkillDefinitionDto } from '../schemas';
import { SkillSetupWizard } from './SkillSetupWizard';

/** Real brand marks where we have one; a plain lucide glyph in a badge otherwise. */
const CONNECTOR_ICON: Record<string, ElementType<{ className?: string }>> = {
  slack: SlackIcon,
  gmail: GmailIcon,
  gdrive: GoogleDriveIcon,
  hubspot: HubSpotIcon,
  github: GitHubIcon,
  email: Mail,
  stripe: CreditCard,
  http: Globe,
  jira: Kanban,
  calendar: Calendar,
  scheduling: CalendarClock,
};
const BRAND_KEYS = new Set(['slack', 'gmail', 'gdrive', 'hubspot', 'github']);

function ConnectorMark({ skillKey }: { skillKey: string }) {
  const Icon = CONNECTOR_ICON[skillKey] ?? Sparkles;
  if (BRAND_KEYS.has(skillKey)) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center">
        <Icon className="h-9 w-9" />
      </span>
    );
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet">
      <Icon className="h-5 w-5" />
    </span>
  );
}

function ActionIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  danger,
  spin,
}: {
  icon: ElementType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  spin?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-violet/50 bg-violet/15 text-violet'
          : danger
            ? 'border-app-border text-app-ink-2 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-600'
            : 'border-app-border text-app-ink-2 hover:border-app-border-strong hover:text-app-ink'
      }`}
    >
      <Icon className={spin ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
    </button>
  );
}

/** One installed-skill card: Settings opens the popup wizard for every skill; events, health, enable/disable, uninstall stay inline. */
function InstalledSkillRow({
  skill,
  def,
}: {
  skill: InstalledSkillDto;
  def?: SkillDefinitionDto;
}) {
  const update = useUpdateInstalledSkill();
  const uninstall = useUninstallSkill();
  const checkHealth = useCheckConnectorHealth();
  const [showEvents, setShowEvents] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const isTemp = skill.id.startsWith('temp_');
  const health = checkHealth.data;

  /**
   * Arrived from AI Assist's "finish connecting it" link (`?connect=<key>`) or
   * the catalog's own anchor. Scroll this row into view and open the popup,
   * because landing at the top of a long Skills page and being told to
   * "connect it" is how people ended up connecting nothing at all.
   */
  const rowRef = useRef<HTMLDivElement>(null);
  const search = useSearchParams();
  const targeted = search.get('connect') === skill.skillKey;
  useEffect(() => {
    if (!targeted) return;
    rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setShowWizard(true);
  }, [targeted]);

  return (
    <div
      ref={rowRef}
      id={`installed-${skill.skillKey}`}
      className={`scroll-mt-24 rounded-2xl border bg-app-surface p-4 transition-colors ${
        targeted
          ? 'border-violet/60 ring-1 ring-violet/40'
          : 'border-app-border hover:border-app-border-strong'
      }`}
    >
      <div className="flex items-center gap-3">
        <ConnectorMark skillKey={skill.skillKey} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-app-ink">{skill.displayName}</p>
          <span
            className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${CONNECTION_STATUS_STYLES[skill.connectionStatus]}`}
          >
            {formatConnectionStatus(skill.connectionStatus)}
          </span>
        </div>
        {!skill.enabled && (
          <span className="shrink-0 rounded-full bg-app-raised px-2 py-0.5 text-[10px] font-medium text-app-ink-3">
            Disabled
          </span>
        )}
      </div>

      <p className="mt-3 truncate text-xs text-app-ink-3">{skill.skillKey}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!def ? (
          <span className="text-xs text-app-ink-3">Unknown skill</span>
        ) : (
          <button
            type="button"
            onClick={() => setShowWizard(true)}
            disabled={isTemp}
            className="rounded-xl border border-app-border-strong bg-app-surface px-4 py-2 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            {skill.connectionStatus === 'CONNECTED'
              ? 'Manage connection'
              : (def.connection?.label ?? 'Set up')}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {def && (
            <ActionIconButton
              icon={Settings}
              label="Settings"
              onClick={() => setShowWizard(true)}
              disabled={isTemp}
            />
          )}
          <ActionIconButton
            icon={Activity}
            label="Events"
            active={showEvents}
            onClick={() => setShowEvents((v) => !v)}
            disabled={isTemp}
          />
          <ActionIconButton
            icon={RefreshCw}
            label="Check health"
            spin={checkHealth.isPending}
            onClick={() => checkHealth.mutate(skill.id)}
            disabled={isTemp || checkHealth.isPending}
          />
          <ActionIconButton
            icon={skill.enabled ? PowerOff : Power}
            label={skill.enabled ? 'Disable' : 'Enable'}
            onClick={() =>
              update.mutate({ id: skill.id, data: { enabled: !skill.enabled } })
            }
            disabled={isTemp || update.isPending}
          />
          <ActionIconButton
            icon={Trash2}
            label="Uninstall"
            danger
            onClick={() => uninstall.mutate(skill.id)}
            disabled={isTemp || uninstall.isPending}
          />
        </div>
      </div>

      {def && (
        <Modal
          open={showWizard}
          onClose={() => setShowWizard(false)}
          title={`Connect ${def.name}`}
          size="lg"
        >
          <SkillSetupWizard installed={skill} def={def} onClose={() => setShowWizard(false)} />
        </Modal>
      )}

      {showEvents && !isTemp && (
        <div className="mt-4 rounded-xl border border-app-border bg-app-surface p-4">
          <p className="mb-2 text-xs font-medium text-app-ink-3">Recent Events</p>
          <RecentConnectorEvents connectorId={skill.id} />
        </div>
      )}

      {(health || checkHealth.isError) && (
        <div className="mt-4 rounded-xl border border-app-border bg-app-surface p-3 text-xs">
          {health ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-app-ink-2">
              <span>
                Health:{' '}
                <span className="font-medium text-app-ink">
                  {formatConnectionStatus(health.status)}
                </span>
              </span>
              <span>Consecutive errors: {health.consecutiveErrors}</span>
              {health.lastHealthError && (
                <span className="text-red-600">
                  Last error: {health.lastHealthError}
                </span>
              )}
              {health.lastHealthCheckAt && (
                <span className="text-app-ink-3">
                  Checked {new Date(health.lastHealthCheckAt).toLocaleString()}
                </span>
              )}
            </div>
          ) : (
            <span className="text-red-600">
              {checkHealth.error?.message ?? 'Health check failed'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Installed skills as connection cards: Settings/connect/events/health/enable/uninstall (all optimistic). */
export function InstalledSkillList() {
  const { data: installed, isLoading } = useInstalledSkills();
  const { data: catalog } = useCatalog();

  const defByKey = new Map((catalog ?? []).map((d) => [d.key, d]));

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading installed skills…</p>;
  }

  if (!installed || installed.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No skills installed yet. Install one from the catalog above.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {installed.map((skill) => (
        <InstalledSkillRow
          key={skill.id}
          skill={skill}
          def={defByKey.get(skill.skillKey)}
        />
      ))}
    </div>
  );
}
```

Note what was deliberately removed versus the pre-existing file: `WIZARD_SKILLS`, the `usesWizard`
branch, `ConfigureSkillForm`'s direct import (it is now only reached through `SkillSetupWizard`'s
`details` stage), and the `showConfig` state + its inline-rendered block — the gear icon's "Configure"
action and the wizard are now the same popup, so the second surface is gone rather than kept alongside
it.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @vaep/web run typecheck` (or this repo's equivalent — check `apps/web/package.json`
for the exact script name if `typecheck` doesn't exist; `tsc --noEmit` via the workspace's usual
command)
Expected: no new errors. If `ConfigureSkillForm` or any other import in `InstalledSkillList.tsx` is
reported unused, remove it — this task intentionally drops that direct usage.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/skills/components/SkillSetupWizard.tsx apps/web/src/features/skills/components/InstalledSkillList.tsx
git commit -m "feat(skills): unify Settings into one popup wizard for every installed skill"
```

---

### Task 8: Calendar adapter

**Files:**
- Create: `apps/api/src/modules/skills/providers/calendar.adapter.ts`
- Test: `apps/api/src/modules/skills/providers/calendar.adapter.spec.ts`
- Modify: `apps/api/src/modules/skills/providers/index.ts`
- Modify: `apps/api/src/modules/skills/connectors/health-probe.ts`

**Interfaces:**
- Consumes: `googleApiGet`, `classifyGoogleError`, `accessTokenFrom` (Task 1);
  `createGoogleCalendarEvent`, `deleteGoogleCalendarEvent` from the EXISTING
  `../executors/google-calendar.util.ts` (`createGoogleCalendarEvent(accessToken, {title, startIso,
  endIso, calendarId?, timezone?, addMeetLink?}): Promise<{ok:true,id,htmlLink,meetLink} |
  {ok:false,error:string}>`; `deleteGoogleCalendarEvent(accessToken, {eventId, calendarId?}):
  Promise<boolean>` — reused as-is, not reimplemented).
- Produces: `calendarAdapter: SkillProviderAdapter` (`key: 'calendar'`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/skills/providers/calendar.adapter.spec.ts
import { calendarAdapter } from './calendar.adapter';

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
  const fn = jest.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('calendarAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports INVALID_CREDENTIALS with no access token', async () => {
    const result = await calendarAdapter.validateCredentials({ creds: {}, config: {} });
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('validateCredentials passes on a real calendarList fetch', async () => {
    mockFetchSequence({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'primary', summary: 'hr@company.com', primary: true }] }),
    });
    const result = await calendarAdapter.validateCredentials({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
  });

  it('discoverAccount returns the primary calendar id', async () => {
    mockFetchSequence({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'hr@company.com', summary: 'HR', primary: true }] }),
    });
    const result = await calendarAdapter.discoverAccount!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.account).toBe('hr@company.com');
  });

  it('test() creates then deletes a real event, and still passes if cleanup fails', async () => {
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ id: 'evt-1', htmlLink: 'https://x', conferenceData: undefined }) }, // create
      { ok: false, status: 500, json: async () => ({}) }, // delete fails
    );
    const result = await calendarAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('could not remove it automatically');
  });

  it('test() fails cleanly when event creation fails', async () => {
    mockFetchSequence({ ok: false, status: 403, json: async () => ({ error: { message: 'insufficient scope' } }) });
    const result = await calendarAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('healthCheck delegates to validateCredentials', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ items: [] }) });
    const result = await calendarAdapter.healthCheck!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/calendar.adapter.spec.ts`
Expected: FAIL — `Cannot find module './calendar.adapter'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/skills/providers/calendar.adapter.ts
import { googleApiGet, classifyGoogleError, accessTokenFrom } from './google-api.util';
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from '../executors/google-calendar.util';
import type {
  AdapterCheck,
  AdapterInput,
  ConnectionFailureCode,
  DiscoveredAccount,
  SkillProviderAdapter,
} from './provider-adapter';

/** GOOGLE CALENDAR — plan §18. Reuses the existing real create/delete helpers. */

const MISSING = 'Reconnect this Google account — no access token is stored yet.';

interface CalendarListItem {
  id?: string;
  summary?: string;
  primary?: boolean;
}

export const calendarAdapter: SkillProviderAdapter = {
  key: 'calendar',

  async validateCredentials(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const result = await googleApiGet<{ items?: CalendarListItem[] }>(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
      token,
    );
    if (!result.ok) {
      return { ok: false, detail: result.error.message, code: classifyGoogleError(result.error) };
    }
    return { ok: true, detail: 'Signed in to Google Calendar' };
  },

  async discoverAccount(input: AdapterInput): Promise<DiscoveredAccount> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { account: null };
    const result = await googleApiGet<{ items?: CalendarListItem[] }>(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
      token,
    );
    if (!result.ok) return { account: null };
    const primary = (result.body.items ?? [])[0];
    return {
      account: primary?.id ?? null,
      metadata: primary ? { summary: primary.summary } : undefined,
    };
  },

  /**
   * §18 "Test Create Event" — a same-day, 1-minute test event, deleted right
   * after. A cleanup failure is reported but does not fail the test: the
   * create already proved the connection end to end.
   */
  async test(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const start = new Date(Date.now() + 5 * 60_000);
    const end = new Date(start.getTime() + 60_000);
    const created = await createGoogleCalendarEvent(token, {
      title: 'Orlixa connection test',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    });
    if (!created.ok) {
      return { ok: false, detail: created.error, code: classifyGoogleError(created.error) };
    }
    const deleted = await deleteGoogleCalendarEvent(token, { eventId: created.id });
    return {
      ok: true,
      detail: deleted
        ? 'Created and removed a test event on your primary calendar.'
        : 'Created a test event on your primary calendar (could not remove it automatically — delete "Orlixa connection test" manually).',
    };
  },

  async healthCheck(input: AdapterInput): Promise<AdapterCheck> {
    return calendarAdapter.validateCredentials(input);
  },

  classifyError(error: unknown): ConnectionFailureCode {
    return classifyGoogleError(error);
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/calendar.adapter.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Register**

`apps/api/src/modules/skills/providers/index.ts`:

```ts
import { calendarAdapter } from './calendar.adapter';
// ...
registerProviderAdapter(calendarAdapter);
```

`apps/api/src/modules/skills/connectors/health-probe.ts`'s `PROBES` map:

```ts
  calendar: adapterProbe('calendar'),
```

- [ ] **Step 6: Run the full unit suite**

Run: `pnpm run test:unit` (from `apps/api`)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/skills/providers/calendar.adapter.ts apps/api/src/modules/skills/providers/calendar.adapter.spec.ts apps/api/src/modules/skills/providers/index.ts apps/api/src/modules/skills/connectors/health-probe.ts
git commit -m "feat(skills): add real Google Calendar provider adapter + health probe"
```

---

### Task 9: Google Drive adapter

**Files:**
- Create: `apps/api/src/modules/skills/providers/gdrive.adapter.ts`
- Test: `apps/api/src/modules/skills/providers/gdrive.adapter.spec.ts`
- Modify: `apps/api/src/modules/skills/providers/index.ts`
- Modify: `apps/api/src/modules/skills/connectors/health-probe.ts`

**Interfaces:**
- Consumes: `googleApiGet`, `classifyGoogleError`, `accessTokenFrom` (Task 1).
- Produces: `gdriveAdapter: SkillProviderAdapter` (`key: 'gdrive'`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/skills/providers/gdrive.adapter.spec.ts
import { gdriveAdapter } from './gdrive.adapter';

function mockFetchSequence(...responses: Array<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
  const fn = jest.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('gdriveAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports INVALID_CREDENTIALS with no access token', async () => {
    const result = await gdriveAdapter.validateCredentials({ creds: {}, config: {} });
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('validateCredentials passes and names the account', async () => {
    mockFetchSequence({
      ok: true,
      status: 200,
      json: async () => ({ user: { emailAddress: 'hr@company.com', displayName: 'HR' } }),
    });
    const result = await gdriveAdapter.validateCredentials({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('hr@company.com');
  });

  it('discoverAccount returns the user email', async () => {
    mockFetchSequence({
      ok: true,
      status: 200,
      json: async () => ({ user: { emailAddress: 'hr@company.com' } }),
    });
    const result = await gdriveAdapter.discoverAccount!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.account).toBe('hr@company.com');
  });

  it('test() creates then deletes a real file, and still passes if cleanup fails', async () => {
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ id: 'file-1' }) }, // upload
      { ok: false, status: 500, json: async () => ({}) }, // delete fails
    );
    const result = await gdriveAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('could not remove it automatically');
  });

  it('test() uses the configured folder as a parent when set', async () => {
    const fetchMock = mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ id: 'file-2' }) },
      { ok: true, status: 200, json: async () => ({}) },
    );
    await gdriveAdapter.test!({ creds: { accessToken: 'tok' }, config: { folderId: 'folder-abc' } });
    const [, uploadInit] = fetchMock.mock.calls[0];
    expect((uploadInit as { body: string }).body).toContain('folder-abc');
  });

  it('test() fails cleanly when upload fails', async () => {
    mockFetchSequence({ ok: false, status: 403, json: async () => ({ error: { message: 'insufficient scope' } }) });
    const result = await gdriveAdapter.test!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('healthCheck delegates to validateCredentials', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ user: {} }) });
    const result = await gdriveAdapter.healthCheck!({ creds: { accessToken: 'tok' }, config: {} });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/gdrive.adapter.spec.ts`
Expected: FAIL — `Cannot find module './gdrive.adapter'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/skills/providers/gdrive.adapter.ts
import { googleApiGet, classifyGoogleError, accessTokenFrom } from './google-api.util';
import type {
  AdapterCheck,
  AdapterInput,
  ConnectionFailureCode,
  DiscoveredAccount,
  SkillProviderAdapter,
} from './provider-adapter';

/** GOOGLE DRIVE — plan §19. */

const MISSING = 'Reconnect this Google account — no access token is stored yet.';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
const TEST_TIMEOUT_MS = 10_000;

export const gdriveAdapter: SkillProviderAdapter = {
  key: 'gdrive',

  async validateCredentials(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const result = await googleApiGet<{ user?: { emailAddress?: string } }>(
      'https://www.googleapis.com/drive/v3/about?fields=user',
      token,
    );
    if (!result.ok) {
      return { ok: false, detail: result.error.message, code: classifyGoogleError(result.error) };
    }
    return {
      ok: true,
      detail: `Signed in to Google Drive as ${result.body.user?.emailAddress ?? 'unknown user'}`,
    };
  },

  async discoverAccount(input: AdapterInput): Promise<DiscoveredAccount> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { account: null };
    const result = await googleApiGet<{ user?: { emailAddress?: string } }>(
      'https://www.googleapis.com/drive/v3/about?fields=user',
      token,
    );
    return { account: result.ok ? (result.body.user?.emailAddress ?? null) : null };
  },

  /** §19 "Test List Files" — creates a small real file, then deletes it. */
  async test(input: AdapterInput): Promise<AdapterCheck> {
    const token = accessTokenFrom(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const folderId = str(input.config?.['folderId']);
    const boundary = `orlixa-${Date.now()}`;
    const metadata: Record<string, unknown> = { name: 'Orlixa connection test.txt' };
    if (folderId) metadata.parents = [folderId];
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\nCreated by Orlixa to test this connection.\r\n` +
      `--${boundary}--`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let created: { id?: string; error?: { message?: string } };
    let status = 0;
    try {
      const res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body,
        signal: controller.signal,
      });
      status = res.status;
      created = (await res.json().catch(() => ({}))) as typeof created;
      if (!res.ok || !created.id) {
        return {
          ok: false,
          detail: created.error?.message ?? `Drive upload failed (${status})`,
          code: classifyGoogleError({ status, reason: null, message: created.error?.message ?? '' }),
        };
      }
    } catch (error) {
      return { ok: false, detail: message(error), code: classifyGoogleError(error) };
    } finally {
      clearTimeout(timer);
    }
    const deleted = await deleteFile(token, created.id);
    return {
      ok: true,
      detail: deleted
        ? 'Created and removed a test file in Google Drive.'
        : 'Created a test file in Google Drive (could not remove it automatically — delete "Orlixa connection test.txt" manually).',
    };
  },

  async healthCheck(input: AdapterInput): Promise<AdapterCheck> {
    return gdriveAdapter.validateCredentials(input);
  },

  classifyError(error: unknown): ConnectionFailureCode {
    return classifyGoogleError(error);
  },
};

async function deleteFile(token: string, fileId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/gdrive.adapter.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Register**

`apps/api/src/modules/skills/providers/index.ts`:

```ts
import { gdriveAdapter } from './gdrive.adapter';
// ...
registerProviderAdapter(gdriveAdapter);
```

`apps/api/src/modules/skills/connectors/health-probe.ts`'s `PROBES` map:

```ts
  gdrive: adapterProbe('gdrive'),
```

- [ ] **Step 6: Run the full unit suite**

Run: `pnpm run test:unit` (from `apps/api`)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/skills/providers/gdrive.adapter.ts apps/api/src/modules/skills/providers/gdrive.adapter.spec.ts apps/api/src/modules/skills/providers/index.ts apps/api/src/modules/skills/connectors/health-probe.ts
git commit -m "feat(skills): add real Google Drive provider adapter + health probe"
```

---

### Task 10: Slack adapter (+ new scope, + requester-email threading)

**Files:**
- Create: `apps/api/src/modules/skills/providers/slack.adapter.ts`
- Test: `apps/api/src/modules/skills/providers/slack.adapter.spec.ts`
- Modify: `apps/api/src/modules/skills/providers/index.ts`
- Modify: `apps/api/src/modules/skills/connectors/health-probe.ts`
- Modify: `apps/api/src/modules/skills/oauth/oauth.providers.ts` (add `users:read.email` scope)
- Modify: `apps/api/src/modules/skills/providers/provider-adapter.ts` (widen `test?`'s `opts` type +
  thread through `runVerification`)
- Modify: `apps/api/src/modules/skills/skills.service.ts` (`verifyConnection` accepts `requesterEmail`)
- Modify: `apps/api/src/modules/skills/skills.controller.ts` (pass the authenticated user's email)

**Interfaces:**
- Consumes: `AdapterInput`, `SkillProviderAdapter` (widened this task).
- Produces: `slackAdapter: SkillProviderAdapter` (`key: 'slack'`); `SkillProviderAdapter.test`'s `opts`
  gains `requesterEmail?: string` (Gmail/Calendar/Drive/email adapters from earlier tasks ignore it —
  no change needed in those files).

- [ ] **Step 1: Write the failing tests for the adapter**

```ts
// apps/api/src/modules/skills/providers/slack.adapter.spec.ts
import { slackAdapter } from './slack.adapter';

function mockFetchSequence(...bodies: unknown[]) {
  const fn = jest.fn();
  for (const body of bodies) fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('slackAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports INVALID_CREDENTIALS with no bot token', async () => {
    const result = await slackAdapter.validateCredentials({ creds: {}, config: {} });
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('validateCredentials passes on a real auth.test call', async () => {
    mockFetchSequence({ ok: true, team: 'Acme', user: 'orlixa-bot', team_id: 'T1', user_id: 'U1' });
    const result = await slackAdapter.validateCredentials({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Acme');
  });

  it('treats Slack\'s HTTP-200-with-{ok:false} as a failure, not a pass', async () => {
    mockFetchSequence({ ok: false, error: 'invalid_auth' });
    const result = await slackAdapter.validateCredentials({ creds: { accessToken: 'xoxb-bad' }, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('REVOKED');
  });

  it('maps missing_scope to INSUFFICIENT_SCOPE', async () => {
    mockFetchSequence({ ok: false, error: 'missing_scope' });
    const result = await slackAdapter.validateCredentials({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('discoverAccount returns the workspace name from auth.test, no second call', async () => {
    const fetchMock = mockFetchSequence({ ok: true, team: 'Acme', user: 'orlixa-bot' });
    const result = await slackAdapter.discoverAccount!({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.account).toBe('Acme');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('test() DMs the resolved user — lookup, open, then post', async () => {
    const fetchMock = mockFetchSequence(
      { ok: true, user: { id: 'U123' } }, // users.lookupByEmail
      { ok: true, channel: { id: 'D123' } }, // conversations.open
      { ok: true, ts: '123.456' }, // chat.postMessage
    );
    const result = await slackAdapter.test!(
      { creds: { accessToken: 'xoxb-1' }, config: {} },
      { requesterEmail: 'hr@company.com' },
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [postUrl, postInit] = fetchMock.mock.calls[2];
    expect(postUrl).toContain('chat.postMessage');
    expect(JSON.parse((postInit as { body: string }).body).channel).toBe('D123');
  });

  it('test() prefers an explicit opts.to over requesterEmail', async () => {
    mockFetchSequence(
      { ok: true, user: { id: 'U999' } },
      { ok: true, channel: { id: 'D999' } },
      { ok: true, ts: '1' },
    );
    await slackAdapter.test!(
      { creds: { accessToken: 'xoxb-1' }, config: {} },
      { to: 'explicit@company.com', requesterEmail: 'ignored@company.com' },
    );
    const fetchMock = global.fetch as jest.Mock;
    const [lookupUrl] = fetchMock.mock.calls[0];
    expect(lookupUrl).toContain(encodeURIComponent('explicit@company.com'));
  });

  it('test() fails cleanly (never falls back to a real channel) when no email is available', async () => {
    const result = await slackAdapter.test!({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TEST_FAILED');
  });

  it('test() fails cleanly when the email has no Slack account', async () => {
    mockFetchSequence({ ok: false, error: 'users_not_found' });
    const result = await slackAdapter.test!(
      { creds: { accessToken: 'xoxb-1' }, config: {} },
      { requesterEmail: 'nobody@company.com' },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('healthCheck delegates to validateCredentials', async () => {
    mockFetchSequence({ ok: true, team: 'Acme', user: 'orlixa-bot' });
    const result = await slackAdapter.healthCheck!({ creds: { accessToken: 'xoxb-1' }, config: {} });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/slack.adapter.spec.ts`
Expected: FAIL — `Cannot find module './slack.adapter'`.

- [ ] **Step 3: Widen the adapter contract's `test` signature**

In `apps/api/src/modules/skills/providers/provider-adapter.ts`, change:

```ts
  test?(input: AdapterInput, opts?: { to?: string }): Promise<AdapterCheck>;
```

to:

```ts
  /**
   * `to` is an explicit override; `requesterEmail` is the connecting user's own
   * account email, always supplied by the caller — a provider with no notion of
   * "the connection's own address" (Slack) uses it as its natural default,
   * providers that DO have one (email, Gmail) ignore it and keep defaulting to
   * themselves.
   */
  test?(input: AdapterInput, opts?: { to?: string; requesterEmail?: string }): Promise<AdapterCheck>;
```

Update `runVerification`'s options type and its call site (`provider-adapter.ts`, the `runVerification`
function signature and stage-4 call):

```ts
export async function runVerification(
  adapter: SkillProviderAdapter,
  input: AdapterInput,
  opts: { includeTest: boolean; testTo?: string; requesterEmail?: string } = { includeTest: false },
): Promise<{
  ok: boolean;
  steps: VerifyStep[];
  account: string | null;
  code?: ConnectionFailureCode;
}> {
```

and in stage 4:

```ts
    const tested = await safely(
      () => adapter.test!(input, { to: opts.testTo, requesterEmail: opts.requesterEmail }),
      adapter,
    );
```

(Every other part of `runVerification` is unchanged.)

- [ ] **Step 4: Thread `requesterEmail` through `verifyConnection` and the controller**

In `apps/api/src/modules/skills/skills.service.ts`, `verifyConnection`'s options parameter gains
`requesterEmail?: string`, passed straight through to `runVerification`:

```ts
  async verifyConnection(
    companyId: string,
    id: string,
    opts: { includeTest?: boolean; testTo?: string; requesterEmail?: string } = {},
  ): Promise<{
    // ...unchanged return type from Task 4...
  }> {
    // ...unchanged up to the runVerification call...
    const result = await runVerification(adapter, input, {
      includeTest: Boolean(opts.includeTest),
      testTo: opts.testTo,
      requesterEmail: opts.requesterEmail,
    });
    // ...rest unchanged...
```

In `apps/api/src/modules/skills/skills.controller.ts`, the `verify` route handler:

```ts
  @Post('installed/:id/verify')
  @RequirePermission('skill:connect')
  verify(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VerifyConnectionDto,
  ) {
    return this.skills.verifyConnection(companyId, id, {
      includeTest: dto.sendTest,
      testTo: dto.testTo,
      requesterEmail: user.email,
    });
  }
```

(`CurrentUser` and `AuthenticatedUser` are already imported in this file — used by two other routes.)

- [ ] **Step 5: Implement the Slack adapter**

```ts
// apps/api/src/modules/skills/providers/slack.adapter.ts
import { asFetchResponse } from '../../../common/http/fetch-response';
import type {
  AdapterCheck,
  AdapterInput,
  ConnectionFailureCode,
  DiscoveredAccount,
  SkillProviderAdapter,
} from './provider-adapter';

/**
 * SLACK — plan §12. `auth.test` per plan §13/04-skills-connectors.md-style
 * Slack quirk: HTTP 200 with `{ok:false, error}` on failure — every call here
 * checks the parsed body, never `res.ok` alone.
 */

const MISSING = 'Reconnect Slack — no bot token is stored yet.';
const SLACK_TIMEOUT_MS = 10_000;

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackFetch(url: string, init: NonNullable<Parameters<typeof fetch>[1]>): Promise<SlackResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await asFetchResponse(await fetch(url, { ...init, signal: controller.signal }));
    return (await res.json()) as SlackResponse;
  } finally {
    clearTimeout(timer);
  }
}

function slackGet(path: string, token: string, query?: Record<string, string>): Promise<SlackResponse> {
  const url = new URL(`https://slack.com/api/${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return slackFetch(url.toString(), { method: 'GET', headers: { authorization: `Bearer ${token}` } });
}

function slackPost(path: string, token: string, body: Record<string, unknown>): Promise<SlackResponse> {
  return slackFetch(`https://slack.com/api/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
}

function botToken(creds: Record<string, unknown>): string | null {
  const token = creds['accessToken'] ?? creds['access_token'] ?? creds['botToken'];
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

export const slackAdapter: SkillProviderAdapter = {
  key: 'slack',

  async validateCredentials(input: AdapterInput): Promise<AdapterCheck> {
    const token = botToken(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const result = await slackGet('auth.test', token);
    if (!result.ok) {
      return { ok: false, detail: humanise(result.error), code: classifySlackError(result.error) };
    }
    return { ok: true, detail: `Signed in to the "${result.team}" Slack workspace as ${result.user}` };
  },

  async discoverAccount(input: AdapterInput): Promise<DiscoveredAccount> {
    const token = botToken(input.creds);
    if (!token) return { account: null };
    const result = await slackGet('auth.test', token);
    if (!result.ok) return { account: null };
    return {
      account: typeof result.team === 'string' ? result.team : null,
      metadata: { botUser: result.user, teamId: result.team_id },
    };
  },

  /**
   * §12 test — DM the connecting user, never a public channel. Needs
   * `users:read.email` (added this task) to resolve an email to a Slack user
   * id; a connection made before this scope existed correctly reports
   * INSUFFICIENT_SCOPE here while validateCredentials/healthCheck/send_message
   * are unaffected.
   */
  async test(input: AdapterInput, opts?: { to?: string; requesterEmail?: string }): Promise<AdapterCheck> {
    const token = botToken(input.creds);
    if (!token) return { ok: false, detail: MISSING, code: 'INVALID_CREDENTIALS' };
    const email = (opts?.to ?? opts?.requesterEmail ?? '').trim();
    if (!email) {
      return {
        ok: false,
        detail: 'No account email to message — sign in and try again.',
        code: 'TEST_FAILED',
      };
    }
    const lookup = await slackGet('users.lookupByEmail', token, { email });
    if (!lookup.ok) {
      return { ok: false, detail: humanise(lookup.error), code: classifySlackError(lookup.error) };
    }
    const userId = (lookup.user as { id?: string } | undefined)?.id;
    if (!userId) {
      return { ok: false, detail: `No Slack user found for ${email}.`, code: 'ACCOUNT_NOT_FOUND' };
    }
    const opened = await slackPost('conversations.open', token, { users: userId });
    if (!opened.ok) {
      return { ok: false, detail: humanise(opened.error), code: classifySlackError(opened.error) };
    }
    const channelId = (opened.channel as { id?: string } | undefined)?.id;
    const posted = await slackPost('chat.postMessage', token, {
      channel: channelId,
      text: 'This is a test message from Orlixa confirming your Slack connection works.',
    });
    if (!posted.ok) {
      return { ok: false, detail: humanise(posted.error), code: classifySlackError(posted.error) };
    }
    return { ok: true, detail: `Sent a test DM to ${email}.` };
  },

  async healthCheck(input: AdapterInput): Promise<AdapterCheck> {
    return slackAdapter.validateCredentials(input);
  },

  classifyError(error: unknown): ConnectionFailureCode {
    const shape = error as { error?: string } | undefined;
    return classifySlackError(typeof shape?.error === 'string' ? shape.error : undefined);
  },
};

function classifySlackError(error: string | undefined): ConnectionFailureCode {
  switch (error) {
    case 'invalid_auth':
    case 'token_revoked':
      return 'REVOKED';
    case 'missing_scope':
      return 'INSUFFICIENT_SCOPE';
    case 'account_inactive':
    case 'token_expired':
      return 'AUTH_FAILED';
    case 'users_not_found':
    case 'channel_not_found':
      return 'ACCOUNT_NOT_FOUND';
    case 'ratelimited':
      return 'CONNECTION_FAILED';
    default:
      return 'ERROR';
  }
}

function humanise(error: string | undefined): string {
  switch (error) {
    case 'invalid_auth':
    case 'token_revoked':
      return 'Slack rejected this bot token — it may have been revoked. Reconnect Slack.';
    case 'missing_scope':
      return 'This Slack connection is missing a permission Orlixa needs. Reconnect Slack to grant it.';
    case 'account_inactive':
      return 'This Slack bot user is no longer active in the workspace.';
    case 'ratelimited':
      return 'Slack is rate-limiting these requests — try again shortly.';
    default:
      return error ? `Slack error: ${error}` : 'Unknown Slack error.';
  }
}
```

- [ ] **Step 6: Add the new scope**

In `apps/api/src/modules/skills/oauth/oauth.providers.ts`, `SKILL_OAUTH.slack`:

```ts
  // channels:read lets the executor resolve a human channel name ("#general")
  // to the id modern chat.postMessage calls require — see real-skill-executor.
  // users:read.email lets the connection wizard's test action DM the
  // connecting user (users.lookupByEmail) — added for the Wave-2 adapter;
  // a connection made before this existed correctly reports
  // INSUFFICIENT_SCOPE on the test action alone until reconnected.
  slack: { provider: 'slack', scopes: ['chat:write', 'channels:read', 'users:read.email'] },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx jest --config ./test/jest-unit.json src/modules/skills/providers/slack.adapter.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 8: Register**

`apps/api/src/modules/skills/providers/index.ts`:

```ts
import { slackAdapter } from './slack.adapter';
// ...
registerProviderAdapter(slackAdapter);
```

`apps/api/src/modules/skills/connectors/health-probe.ts`'s `PROBES` map:

```ts
  slack: adapterProbe('slack'),
```

- [ ] **Step 9: Run the full unit suite**

Run: `pnpm run test:unit` (from `apps/api`)
Expected: PASS, including the widened `provider-adapter.spec.ts` and `skills.service.spec.ts` /
`oauth.service.spec.ts` suites — if any existing test asserts the exact old Slack scopes array, update
it to include `users:read.email` (a deliberate, expected change, not a regression).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/skills/providers/slack.adapter.ts apps/api/src/modules/skills/providers/slack.adapter.spec.ts apps/api/src/modules/skills/providers/index.ts apps/api/src/modules/skills/providers/provider-adapter.ts apps/api/src/modules/skills/connectors/health-probe.ts apps/api/src/modules/skills/oauth/oauth.providers.ts apps/api/src/modules/skills/skills.service.ts apps/api/src/modules/skills/skills.controller.ts
git commit -m "feat(skills): add real Slack provider adapter (+ users:read.email scope)"
```

---

### Task 11: e2e coverage

**Files:**
- Modify: `apps/api/test/skill-connection-framework.e2e-spec.ts` — confirmed by reading it: real app
  boot via `Test.createTestingModule({imports:[AppModule]})`, real Postgres (`describeIfDb`, needs
  `DATABASE_URL`), `app.get(PrismaService)`/`app.get(CryptoService)` to reach services directly, a
  `bearer(token)` header helper, and `request(app.getHttpServer())` for HTTP assertions — the exact
  §3/§37 scope this task's tests extend. Add a Gmail/Slack `describe` block alongside the existing
  email one; do not create a second app-bootstrap.

**Interfaces:**
- Consumes: `SkillsService.connectOAuth`/`verifyConnection` (Tasks 4-5), `gmailAdapter`/`slackAdapter`
  (Tasks 2, 10), reached via `app.get(SkillsService)` — this file's own established pattern for
  reaching a service directly rather than only through HTTP (`app.get(PrismaService)` at line 44).

**Note on scope:** this task deliberately calls `SkillsService.connectOAuth()` directly (via
`app.get(SkillsService)`) rather than driving the full `GET /skills/oauth/callback` HTTP redirect
dance. Faking a valid HMAC-signed `state` param and a provider token-exchange response is a materially
bigger, separate piece of test infrastructure that no existing e2e file in this repo has built yet
(confirmed — grep for `oauth`/`OAuth`/`connectOAuth` across `apps/api/test/*.e2e-spec.ts` found no
existing coverage of the callback route to extend). Calling `connectOAuth` directly still exercises the
real thing this wave changed — real Nest DI (including Task 6's `forwardRef` wiring), real Postgres,
real encryption, the real adapter registry — with `global.fetch` mocked for the external Google/Slack
call, consistent with how this same file already fakes an unreachable SMTP server to get a real
failure path (lines 71-77) rather than stubbing `SkillsService` itself.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/skill-connection-framework.e2e-spec.ts`, as a new `describe` block alongside the
existing one (reuse the file's top-level `app`/`prisma`/`bearer`/`ts` — do not re-declare a second
`beforeAll`/app boot; add a second `describe(...)` inside the same `describeIfDb(...)` if the existing
structure is a single flat `describe`, or a sibling `describe` at the same level — match whichever the
file's read shows once you're editing it):

```ts
import { SkillsService } from '../src/modules/skills/skills.service';

// ...inside the existing describeIfDb('Skill connection framework (§3/§37)', () => { ... }) block,
// alongside the existing `it(...)` calls for email:

describe('OAuth provider adapters (Wave 2 — Gmail, Slack)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a Gmail OAuth connect that fails verification lands NOT_CONNECTED, not a silent CONNECTED', async () => {
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'gmail' })
      .expect(201);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Insufficient scope' } }),
    }) as unknown as typeof fetch;

    const skills = app.get(SkillsService);
    await skills.connectOAuth(companyId, installed.body.id, { accessToken: 'bad-scope-token' });

    const res = await request(app.getHttpServer())
      .get('/skills/installed')
      .set(bearer(token))
      .expect(200);
    const row = res.body.find((s: { id: string }) => s.id === installed.body.id);
    expect(row.connectionStatus).toBe('NOT_CONNECTED');
  });

  it('a successful Gmail OAuth connect shows CONNECTED and the discovered account', async () => {
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'gmail' })
      .expect(201);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ emailAddress: 'hr@company.com' }),
    }) as unknown as typeof fetch;

    const skills = app.get(SkillsService);
    await skills.connectOAuth(companyId, installed.body.id, { accessToken: 'good-token' });

    const res = await request(app.getHttpServer())
      .get('/skills/installed')
      .set(bearer(token))
      .expect(200);
    const row = res.body.find((s: { id: string }) => s.id === installed.body.id);
    expect(row.connectionStatus).toBe('CONNECTED');
    expect(row.config?.connectedAccount).toBe('hr@company.com');
  });

  it('a Slack connection made before the users:read.email scope existed fails only the test action', async () => {
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'slack' })
      .expect(201);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, team: 'Acme', user: 'orlixa-bot' }),
    }) as unknown as typeof fetch;
    const skills = app.get(SkillsService);
    await skills.connectOAuth(companyId, installed.body.id, { accessToken: 'xoxb-old-scope-token' });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'missing_scope' }),
    }) as unknown as typeof fetch;
    const verifyRes = await request(app.getHttpServer())
      .post(`/skills/installed/${installed.body.id}/verify`)
      .set(bearer(token))
      .send({ sendTest: true })
      .expect(201);
    expect(verifyRes.body.ok).toBe(false);
    expect(verifyRes.body.code).toBe('INSUFFICIENT_SCOPE');

    // validateCredentials/healthCheck are unaffected — the connection itself stays CONNECTED,
    // only the test action (which alone needs the new scope) fails.
    const list = await request(app.getHttpServer())
      .get('/skills/installed')
      .set(bearer(token))
      .expect(200);
    expect(
      list.body.find((s: { id: string }) => s.id === installed.body.id).connectionStatus,
    ).toBe('CONNECTED');
  });
});
```

- [ ] **Step 2: Run this file's suite to verify the new tests fail, then pass**

Run (from `apps/api`, with `DATABASE_URL`/`REDIS_URL` and the other env vars `platform/CLAUDE.md`
documents set — this file is skipped entirely without a real `DATABASE_URL`):
`npx jest --config ./test/jest-e2e.json test/skill-connection-framework.e2e-spec.ts`
Expected: FAIL before Tasks 1-10 exist in this branch (skip this expectation if Task 11 runs after
Tasks 1-10 are already committed — go straight to verifying PASS), then PASS.

- [ ] **Step 3: Run the full e2e suite in both engine modes**

Run: `pnpm test` (from `apps/api`), then `WORKFLOW_ENGINE_MODE=legacy_walk pnpm test`
Expected: both PASS. CLAUDE.md is explicit the suite has no known-failing tests — a new failure
anywhere else is a real regression to fix, not skip.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/skill-connection-framework.e2e-spec.ts
git commit -m "test(skills): e2e coverage for Wave-2 OAuth adapter verify-before-connect"
```

---

### Task 12: Browser verification (final)

No code changes — this task proves Tasks 1-11 actually work together in a real browser, per this
repo's stated discipline that typecheck/unit/e2e verify correctness, not feature completeness.

- [ ] **Step 1: Start the stack**

```bash
cd platform && docker compose -f infra/docker-compose.yml up -d
pnpm dev
```

Confirm real (not mock) execution is enabled for this pass if you want to see genuine Google/Slack
calls: set `SKILL_EXECUTOR=real` (or `auto`) and real `OAUTH_GOOGLE_CLIENT_ID/SECRET`,
`OAUTH_SLACK_CLIENT_ID/SECRET`, `OAUTH_REDIRECT_BASE` in `apps/api/.env` — otherwise this pass still
proves the UI/UX flow and the graceful no-adapter path (Step 4 below), just not real provider calls.

- [ ] **Step 2: Gmail, end to end**

Log in, go to `/skills`, install Gmail if not already installed. Click the gear "Settings" icon (or the
primary connect button — both must open the same popup). Confirm: the popup opens (not an inline
expansion), the OAuth redirect happens on "Continue with Google" (if real creds are configured) or the
existing details/config path renders correctly (if not), and after connecting, the wizard's `verify`
stage auto-runs without a manual click and shows real PASSED steps naming the connected Gmail address.
Click through to `test` and send a real test email (if real creds configured) or confirm "Skip the
test" reaches `done` cleanly. Confirm `/skills` list shows Gmail as CONNECTED.

- [ ] **Step 3: Calendar, Drive, Slack — replicate**

Repeat Step 2 for Calendar, Google Drive, and Slack. For Slack specifically, if real creds are
configured, confirm the test action arrives as a DM to the logged-in user's own Slack account, never a
channel post.

- [ ] **Step 4: The graceful no-adapter path — Stripe (or any other no-adapter skill)**

Open Settings on an installed Stripe (or GitHub/HubSpot/Jira) connection. Confirm the popup opens (this
is the point of Task 7 — it must now work for every skill, not just the 5 adapter-backed ones), the
`verify` stage shows the honest "Orlixa can't automatically verify this provider yet" message with a
working **Continue** button (not a "Check connection" button that spins forever or errors), and the
`done` stage's copy says the skill is "set up," never "connected" or "verified."

- [ ] **Step 5: Regression-check the health check + events panels still work**

On any connected skill's card, click "Check health" and confirm the inline health panel still renders
(this task didn't touch that UI, only removed the separate config-form toggle — confirm nothing else on
the card broke). Click "Events" and confirm the recent-events panel still renders.

- [ ] **Step 6: Stop the dev server**

Per this project's standing practice: kill the `pnpm dev` process (and `docker compose down` if it was
started solely for this verification pass) so ports 3200/4000 are free for the next session.

- [ ] **Step 7: Final full-suite confirmation and summary commit (if anything was fixed during browser testing)**

If Steps 2-5 surfaced anything needing a code fix, fix it, re-run the specific unit/e2e test that covers
it, then `pnpm run test:unit` and `pnpm test` (both engine modes) one more time from `apps/api` before
considering this plan complete. If nothing needed fixing, no commit is needed for this task — Task 11's
commit already closed out the code changes.
