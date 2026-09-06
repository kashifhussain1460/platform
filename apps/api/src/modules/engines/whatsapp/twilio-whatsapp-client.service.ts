import { Injectable } from '@nestjs/common';
import twilio from 'twilio';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter } from '../../../common/resilience/rate-limiter';
import { ResilientClientBase } from '../../../common/resilience/resilient-client.base';
import { whatsappResourceKey } from './whatsapp.constants';

export interface SendFreeformInput {
  accountSid: string;
  authToken: string;
  from: string; // E.164, no "whatsapp:" prefix
  to: string;
  body: string;
}

export interface SendTemplateInput {
  accountSid: string;
  authToken: string;
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

  async sendFreeform(input: SendFreeformInput): Promise<TwilioSendResult> {
    await this.breakers.guard(whatsappResourceKey(input.accountSid));
    const client = this.clientFor(input.accountSid, input.authToken);
    const message = await client.messages.create({
      from: waPrefix(input.from),
      to: waPrefix(input.to),
      body: input.body,
    });
    return { sid: message.sid, status: message.status };
  }

  async sendTemplate(input: SendTemplateInput): Promise<TwilioSendResult> {
    await this.breakers.guard(whatsappResourceKey(input.accountSid));
    const client = this.clientFor(input.accountSid, input.authToken);
    const message = await client.messages.create({
      from: waPrefix(input.from),
      to: waPrefix(input.to),
      contentSid: input.contentSid,
      contentVariables: JSON.stringify(input.contentVariables),
    });
    return { sid: message.sid, status: message.status };
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
