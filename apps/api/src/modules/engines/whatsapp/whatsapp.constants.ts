/** CanonicalEvent/RawEvent provider discriminator (event-mapper.ts's switch, ingestVerified's `provider`). */
export const WHATSAPP_PROVIDER = 'whatsapp';

/**
 * C-07 shape: PER-COMPANY resource key (Chatwoot's shape, not Postiz's global
 * one) — each Orlixa company has its own Twilio account/number, so one
 * tenant's broken credentials must never trip the circuit breaker for another
 * tenant's independent WhatsApp number.
 */
export function whatsappResourceKey(companyId: string): string {
  return `engine:whatsapp:${companyId}`;
}

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';

/** WhatsApp's own platform rule (not an Orlixa policy) — free-form replies only within this window. */
export const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60_000;
