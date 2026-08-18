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
