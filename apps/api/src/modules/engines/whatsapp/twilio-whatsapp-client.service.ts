import { Injectable } from '@nestjs/common';
import twilio from 'twilio';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { countsTowardCircuit } from '../../../common/resilience/error-classifier';
import { RateLimiter, RateLimitedError } from '../../../common/resilience/rate-limiter';
import { ResilientClientBase } from '../../../common/resilience/resilient-client.base';
import {
  WHATSAPP_RATE_LIMIT,
  WHATSAPP_RATE_WINDOW_MS,
  whatsappResourceKey,
} from './whatsapp.constants';

/** Credentials + the tenant the circuit breaker / rate limiter are keyed on. */
export interface TwilioCallScope {
  /** The Orlixa tenant. THE resource-key identity — see `whatsappResourceKey`. */
  companyId: string;
  accountSid: string;
  authToken: string;
}

export interface SendFreeformInput extends TwilioCallScope {
  from: string; // E.164, no "whatsapp:" prefix
  to: string;
  body: string;
}

export interface SendTemplateInput extends TwilioCallScope {
  from: string;
  to: string;
  contentSid: string;
  contentVariables: Record<string, string>;
}

export interface TwilioSendResult {
  sid: string;
  status: string;
}

const waPrefix = (e164: string): string => `whatsapp:${e164}`;

/**
 * Thin, typed wrapper around the Twilio Programmable Messaging API for
 * WhatsApp (docs/plans/2026-09-06-whatsapp-sales-engine-plan.md §4/§5).
 *
 * PER-COMPANY resource key (whatsappResourceKey), unlike PostizClientService's
 * single global key — each Orlixa company holds its own Twilio Account
 * SID/Auth Token for its own WhatsApp Business number, so one tenant's
 * revoked/invalid credentials must never trip the circuit breaker for another
 * tenant's independent number. Mirrors ChatwootClientService's per-account
 * resource-key reasoning exactly.
 *
 * Credentials are never held on `this` — every call takes them as arguments
 * (already decrypted by the caller, same pattern RealSkillExecutor uses for
 * Chatwoot's agentBotToken) because a new Twilio Client must be constructed
 * per distinct account/token pair; there is no single shared client.
 */
@Injectable()
export class TwilioWhatsappClientService extends ResilientClientBase {
  constructor(breakers: CircuitBreakerRegistry, rateLimiter: RateLimiter) {
    super(breakers, rateLimiter);
  }

  /** Isolated for testing — jest.spyOn(service, 'clientFor') stubs the network boundary. */
  protected clientFor(accountSid: string, authToken: string) {
    return twilio(accountSid, authToken);
  }

  /**
   * The SDK equivalent of `ResilientClientBase.guardedFetch`.
   *
   * `guardedFetch` cannot be reused literally — it wraps `fetch`, and these
   * calls go through the Twilio SDK's own HTTP client — so the same four steps
   * are done by hand here, in the same order and with the same classifier:
   * circuit gate → rate limit → call → record the outcome.
   *
   * This is the whole of finding I1: `sendFreeform`/`sendTemplate` used to call
   * `breakers.guard(...)` and stop there. Nothing ever called `recordSuccess`
   * or `recordFailure`, so the breaker could never open no matter how hard
   * Twilio was failing, and the injected `RateLimiter` was dead weight.
   */
  private async guardedTwilioCall<T>(
    scope: TwilioCallScope,
    call: () => Promise<T>,
  ): Promise<T> {
    const resourceKey = whatsappResourceKey(scope.companyId);

    // 1) Circuit gate — OPEN → fast-fail, Twilio is NOT called.
    await this.breakers.guard(resourceKey);

    // 2) Per-tenant send budget.
    const allowed = await this.rateLimiter.tryAcquire(
      resourceKey,
      WHATSAPP_RATE_LIMIT,
      WHATSAPP_RATE_WINDOW_MS,
    );
    if (!allowed) {
      throw new RateLimitedError(resourceKey);
    }

    // 3) The call, and 4) the outcome. `countsTowardCircuit` is the same
    //    classifier every other egress path uses: transient failures and auth
    //    failures open the breaker, a plain 400/404 (our bad input, not
    //    Twilio failing) deliberately does not.
    try {
      const result = await call();
      await this.breakers.recordSuccess(resourceKey);
      return result;
    } catch (err) {
      if (countsTowardCircuit(err)) {
        await this.breakers.recordFailure(resourceKey);
      }
      throw err;
    }
  }

  async sendFreeform(input: SendFreeformInput): Promise<TwilioSendResult> {
    return this.guardedTwilioCall(input, async () => {
      const client = this.clientFor(input.accountSid, input.authToken);
      const message = await client.messages.create({
        from: waPrefix(input.from),
        to: waPrefix(input.to),
        body: input.body,
      });
      return { sid: message.sid, status: message.status };
    });
  }

  async sendTemplate(input: SendTemplateInput): Promise<TwilioSendResult> {
    return this.guardedTwilioCall(input, async () => {
      const client = this.clientFor(input.accountSid, input.authToken);
      const message = await client.messages.create({
        from: waPrefix(input.from),
        to: waPrefix(input.to),
        contentSid: input.contentSid,
        contentVariables: JSON.stringify(input.contentVariables),
      });
      return { sid: message.sid, status: message.status };
    });
  }

  /**
   * "Are these credentials real?" — one authenticated read of the account
   * itself, the standard Twilio credential check.
   *
   * Used by the connect route so an account is only marked CONNECTED after the
   * credentials have actually been exercised, matching the verify-before-READY
   * gate the generic skill-connection framework applies to every other
   * provider. Throws whatever Twilio threw (a 401 for a bad token), so the
   * caller can report the real reason rather than a generic failure.
   */
  async verifyCredentials(scope: TwilioCallScope): Promise<{ accountSid: string; status: string }> {
    return this.guardedTwilioCall(scope, async () => {
      const client = this.clientFor(scope.accountSid, scope.authToken);
      const account = await client.api.accounts(scope.accountSid).fetch();
      return { accountSid: account.sid, status: account.status };
    });
  }

  /**
   * Twilio's own guidance, not a style preference: "Use the SDK validator.
   * Do not implement your own — Twilio may add parameters without notice, and
   * the exact algorithm (including port handling) has edge cases the SDK
   * handles." `params` is the PARSED form-encoded body (Twilio signs
   * form fields, not raw JSON bytes, for inbound-message webhooks — unlike
   * Chatwoot's JSON+HMAC-SHA256 scheme).
   */
  verifyWebhookSignature(
    authToken: string,
    signatureHeader: string | undefined,
    url: string,
    params: Record<string, unknown>,
  ): boolean {
    if (!signatureHeader) return false;
    return twilio.validateRequest(authToken, signatureHeader, url, params as Record<string, string>);
  }
}
