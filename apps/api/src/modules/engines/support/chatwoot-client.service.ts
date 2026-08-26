import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter } from '../../../common/resilience/rate-limiter';
import { ResilientClientBase } from '../../../common/resilience/resilient-client.base';
import { CHATWOOT_ENV, SIGNATURE_MAX_AGE_MS } from './support.constants';

export interface ProvisionedAccount {
  chatwootAccountId: string;
  agentBotId: string;
  agentBotToken: string;
  webhookSecret: string;
}

/** C-07: one resource key PER Chatwoot account — see class doc comment. */
function chatwootResourceKey(chatwootAccountId: string): string {
  return `engine:chatwoot:${chatwootAccountId}`;
}

/**
 * Thin, typed wrapper around a self-hosted Chatwoot instance
 * (docs/architecture/engines/chatwoot-engine.md §11).
 *
 * Two auth contexts, never confused:
 *  - Platform API (`platform/api/v1/...`) — ONE shared super-admin
 *    `CHATWOOT_PLATFORM_API_TOKEN` for the whole Orlixa deployment, used only
 *    to provision new per-company accounts.
 *  - Agent-facing API (`api/v1/accounts/:account_id/...`) — a per-company
 *    `agentBotToken`, decrypted from the DB by the caller (via CryptoService,
 *    same pattern as RealSkillExecutor reading ctx.credentials), used for all
 *    day-to-day conversation/message calls.
 *
 * Extends ResilientClientBase (C-07) with a PER-chatwootAccountId resource
 * key — the mirror image of PostizClientService's single global key. Each
 * Orlixa company has its OWN self-hosted-account-scoped Chatwoot integration
 * (own `agentBotToken`, own real `chatwootAccountId`); a global breaker key
 * here would let one tenant's broken/revoked credentials trip the circuit for
 * every OTHER tenant's completely independent Chatwoot account — a
 * cross-tenant availability bug, not a protection. No rate-limit budget is
 * applied (Chatwoot has no documented shared cap the way Postiz does).
 */
@Injectable()
export class ChatwootClientService extends ResilientClientBase {
  private readonly logger = new Logger(ChatwootClientService.name);

  // CryptoService is injected for parity with how this service will be wired
  // once Task 4 reads/decrypts the per-company agentBotToken; this task does
  // not use it directly (the token arrives already-decrypted from the caller).
  constructor(
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    breakers: CircuitBreakerRegistry,
    rateLimiter: RateLimiter,
  ) {
    super(breakers, rateLimiter);
  }

  private baseUrl(): string {
    const url = this.config.get<string>(CHATWOOT_ENV.BASE_URL);
    if (!url) throw new Error(`${CHATWOOT_ENV.BASE_URL} is not configured`);
    return url.replace(/\/$/, '');
  }

  private platformHeaders(): Record<string, string> {
    const token = this.config.get<string>(CHATWOOT_ENV.PLATFORM_API_TOKEN);
    if (!token) throw new Error(`${CHATWOOT_ENV.PLATFORM_API_TOKEN} is not configured`);
    return { api_access_token: token, 'content-type': 'application/json' };
  }

  async provisionAccount(companyName: string): Promise<ProvisionedAccount> {
    // NOT LIVE-VERIFIED — no self-hosted Chatwoot instance exists in this dev
    // environment to run this against. The sequence below IS grounded in a
    // direct read of the real Chatwoot source (not guessed):
    //   app/controllers/platform/api/v1/{accounts,users,account_users,agent_bots}_controller.rb
    //   app/controllers/api/v1/accounts/{inboxes,agent_bots}_controller.rb
    //   app/models/agent_bot.rb (+ AccessTokenable/WebhookSecretable concerns)
    // 1. POST platform/api/v1/accounts {name} -> Account {id}
    // 2. POST platform/api/v1/users {name, email, password} -> User {id}
    // 3. POST platform/api/v1/account_users {account_id, user_id, role: 'administrator'}
    // 4. POST platform/api/v1/users/:id/login -> a real session token for THIS user
    //    (the Platform API's own token, not an admin session, per the doc's
    //    "users (create/show/update/destroy + login/token)" list)
    // 5. POST platform/api/v1/agent_bots {name, account_id, outgoing_url}
    //    -> AgentBot {id, access_token} -- IMPORTANT, verified directly in
    //    app/views/platform/api/v1/models/_agent_bot.json.jbuilder: the platform
    //    API's create/show response NEVER includes `secret` (the HMAC signing
    //    key) -- only api/v1/accounts/:id/agent_bots/:id's jbuilder exposes it,
    //    and ONLY when `Current.account_user&.administrator?` is true (see
    //    app/views/api/v1/models/_agent_bot.json.jbuilder). This is a real
    //    platform limitation, not an oversight in this plan.
    // 6. POST api/v1/accounts/:account_id/inboxes {channel: {type: 'api'}}
    //    (using step 4's user session token, NOT the platform token) -> Inbox {id}
    //    -- creates a headless Channel::Api inbox (no widget/UI), per
    //    chatwoot-engine.md's recommended integration seam.
    // 7. POST api/v1/accounts/:account_id/inboxes/:inbox_id/agent_bot
    //    {agent_bot: agentBotId} (user session token) -> attaches the bot.
    // 8. GET api/v1/accounts/:account_id/agent_bots/:id (user session token,
    //    as the administrator created in step 2) -> NOW `secret` is present
    //    in the response -- this is the ONLY way to retrieve it.
    // Implement this as 8 sequential fetch() calls; if any step's real response
    // shape doesn't match what's documented here once tested against a live
    // instance, that's new information -- update this comment, don't silently
    // patch around a mismatch.
    throw new Error(`NOT YET IMPLEMENTED (provisionAccount for "${companyName}") — sequence documented above from source, but requires a live Chatwoot instance to verify before implementing for real; do not fabricate a "working" implementation that has never been run`);
  }

  async sendReply(
    chatwootAccountId: string,
    chatwootConversationId: string,
    agentBotToken: string,
    content: string,
  ): Promise<{ chatwootMessageId: string }> {
    const res = await this.guardedFetch(
      chatwootResourceKey(chatwootAccountId),
      `${this.baseUrl()}/api/v1/accounts/${chatwootAccountId}/conversations/${chatwootConversationId}/messages`,
      {
        method: 'POST',
        headers: { api_access_token: agentBotToken, 'content-type': 'application/json' },
        body: JSON.stringify({ content, message_type: 'outgoing' }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Chatwoot sendReply failed (${res.status}): ${text}`);
      throw new Error(`Chatwoot sendReply failed: ${res.status}`);
    }
    const data = (await res.json()) as { id: number };
    return { chatwootMessageId: String(data.id) };
  }

  /**
   * Verifies Chatwoot's real Agent-Bot webhook HMAC scheme, confirmed by
   * reading the actual Chatwoot source (`lib/webhooks/trigger.rb#request_headers`,
   * the code path used for `:agent_bot_webhook` deliveries):
   *   X-Chatwoot-Signature: "sha256=" + HMAC_SHA256_hex(secret, "<timestamp>.<rawBody>")
   *   X-Chatwoot-Timestamp: unix seconds (the same value concatenated into the
   *     signed string above — NOT just a signature-adjacent header).
   * A prior version of this method (Task 4) incorrectly treated the signature
   * header as a bare hex digest of the body alone, which would reject every
   * real Chatwoot delivery; fixed here since it is this task's entire point to
   * verify against the real scheme, not a guessed one.
   *
   * Also enforces a 5-minute replay window on the timestamp — Chatwoot's own
   * source has no built-in expiry, but rejecting stale timestamps costs
   * nothing and closes a trivial replay hole for a captured request.
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | undefined,
    timestampHeader: string | undefined,
    webhookSecret: string,
  ): boolean {
    if (!signatureHeader || !timestampHeader) return false;

    const match = /^sha256=([0-9a-f]+)$/i.exec(signatureHeader.trim());
    if (!match) return false;

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) return false;
    const ageMs = Math.abs(Date.now() - timestamp * 1000);
    if (ageMs > SIGNATURE_MAX_AGE_MS) return false;

    const expectedHex = createHmac('sha256', webhookSecret)
      .update(`${timestampHeader}.${rawBody}`)
      .digest('hex');

    let a: Buffer;
    let b: Buffer;
    try {
      a = Buffer.from(expectedHex, 'hex');
      b = Buffer.from(match[1], 'hex');
    } catch {
      return false;
    }
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
