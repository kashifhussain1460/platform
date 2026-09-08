/** CanonicalEvent/RawEvent provider discriminator (event-mapper.ts's switch, ingestVerified's `provider`). */
export const WHATSAPP_PROVIDER = 'whatsapp';

/**
 * C-07 shape: PER-COMPANY resource key (Chatwoot's shape, not Postiz's global
 * one) — each Orlixa company has its own Twilio account/number, so one
 * tenant's broken credentials must never trip the circuit breaker for another
 * tenant's independent WhatsApp number.
 *
 * It really is the COMPANY id, not the Twilio Account SID. Two Orlixa tenants
 * CAN end up on one SID — most obviously Twilio's shared WhatsApp Sandbox
 * number, which every trial account uses during onboarding (the same collision
 * `whatsapp-webhook.controller.ts` documents on its account lookup) — and
 * keying on the SID would then hand those tenants a shared breaker, which is
 * precisely the cross-tenant coupling this key exists to prevent. Keying on the
 * company can under-protect a genuinely shared upstream instead; that is the
 * safer side of the trade, since the breaker's job here is tenant isolation.
 */
export function whatsappResourceKey(companyId: string): string {
  return `engine:whatsapp:${companyId}`;
}

/**
 * Per-company outbound send budget.
 *
 * NOT a published Twilio quota — Twilio's own WhatsApp throughput depends on
 * the sender's tier and quality rating, and this code cannot know either. It is
 * an Orlixa-side sanity cap so a looping workflow cannot machine-gun a real
 * customer's phone (or burn the tenant's Twilio balance) before anybody
 * notices. Deliberately generous enough that no legitimate qualification
 * conversation touches it.
 */
export const WHATSAPP_RATE_LIMIT = 60;
export const WHATSAPP_RATE_WINDOW_MS = 60_000;

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';

/** WhatsApp's own platform rule (not an Orlixa policy) — free-form replies only within this window. */
export const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60_000;
