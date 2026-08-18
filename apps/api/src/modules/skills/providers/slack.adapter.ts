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
