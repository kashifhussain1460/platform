import type { Plan, SubscriptionStatus } from '@vaep/types';
import type { Subscription } from '@prisma/client';

/**
 * Swappable billing backend (mirrors the auth AuthProvider / embeddings
 * EmbeddingProvider pattern). The active implementation is chosen by the
 * `BILLING_PROVIDER` env var and provided as a singleton under the
 * BILLING_PROVIDER_TOKEN DI token. The default MockBillingProvider makes NO
 * external calls (offline-first); StripeBillingProvider is opt-in.
 */
export interface BillingProvider {
  /** Provider identifier persisted on the subscription row ("mock" | "stripe"). */
  readonly name: string;

  /**
   * Ensure a billing customer exists for the company, returning its external id
   * (or null when the provider has no external concept). Called when a default
   * subscription is first created.
   */
  ensureCustomer(company: BillingCompany): Promise<EnsureCustomerResult>;

  /**
   * Apply a plan change to a subscription. Mock switches immediately; Stripe
   * creates a hosted Checkout Session for the target plan's price and returns its
   * `checkoutUrl` WITHOUT changing the local plan (the webhook confirms it).
   */
  changePlan(
    subscription: Subscription,
    plan: Plan,
  ): Promise<ChangePlanResult>;

  /**
   * Verify + parse a provider webhook into a normalized event, or null for an
   * event we ignore. OPTIONAL — providers without webhooks (mock) omit it, and
   * the route then answers 400. Implementations MUST throw on an unverifiable
   * signature so the route returns 400.
   */
  parseWebhookEvent?(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<BillingWebhookEvent | null>;

  /**
   * A hosted page where the company can manage payment methods, see past
   * invoices, and cancel — none of which this app builds its own UI for
   * (founder-market-readiness-audit.md §8). OPTIONAL — a provider with no
   * such concept (mock) omits it; BillingService then returns url: null and
   * the frontend explains billing management isn't available in mock mode.
   */
  createPortalSession?(
    externalCustomerId: string,
  ): Promise<{ url: string } | null>;

  /**
   * Credit system Phase 5, Task 5.2 (§31.2.3) — a one-time `mode:'payment'`
   * Checkout Session for a credit pack. Mints ZERO credits by itself (the
   * webhook, Phase 6, is the only path allowed to grant) — this only ever
   * creates the hosted payment page. OPTIONAL, same convention as
   * `createPortalSession`: the mock provider omits it, `BillingService`
   * then returns `{checkoutUrl: null}`.
   */
  createCreditCheckoutSession?(input: {
    externalCustomerId: string;
    companyId: string;
    packId: string;
    creditPackRateId: string;
    stripePriceId: string;
  }): Promise<{ url: string } | null>;
}

/** Minimal company shape a provider needs to create/lookup a customer. */
export interface BillingCompany {
  id: string;
  name?: string;
}

export interface EnsureCustomerResult {
  externalCustomerId: string | null;
}

/** Fields a provider resolves for a plan change; folded into the DB row. */
export interface ChangePlanResult {
  plan: Plan;
  status: SubscriptionStatus;
  externalCustomerId?: string | null;
  externalSubscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  /** Hosted checkout URL (Stripe only; surfaced in the DTO). */
  checkoutUrl?: string | null;
}

/**
 * Normalized subscription-affecting webhook event. A provider's parseWebhookEvent
 * verifies the raw request and maps it to this shape; BillingService then applies
 * it to the local Subscription (resolving the tenant by companyId, else by the
 * stored external customer/subscription id).
 */
export interface BillingWebhookEvent {
  /** Raw provider event type (e.g. checkout.session.completed) — for logging. */
  type: string;
  /**
   * Credit system Phase 6, Task 6.1 — the provider's own event id (Stripe's
   * `event.id`). The dedup key for `ProcessedWebhookEvent`; distinct from
   * `externalSubscriptionId`/`externalCustomerId`, which identify the
   * RESOURCE the event is ABOUT, not the delivery itself.
   */
  externalEventId: string;
  /** Task 6.1 — the raw provider payload, stored on `ProcessedWebhookEvent` for audit/replay. */
  payload: unknown;
  /** Task 6.2 (Q16 fix) — the provider's own event-creation instant, for the out-of-order guard. */
  createdAt: Date;
  companyId?: string | null;
  externalCustomerId?: string | null;
  externalSubscriptionId?: string | null;
  plan?: Plan | null;
  status?: SubscriptionStatus | null;
  currentPeriodEnd?: Date | null;
  /**
   * Task 6.3 (§31.2.3/Q19 fix) — present only for a `checkout.session.completed`
   * that is a ONE-TIME credit-pack purchase (`session.mode==='payment'`), never
   * a subscription checkout. `creditPackRateId` is the EXACT snapshotted
   * `CreditPack` row id captured at Task 5.2's session-creation time (never
   * "whichever pack is current when the webhook happens to be processed").
   */
  creditPurchase?: {
    packId: string;
    creditPackRateId: string;
    sessionId: string;
    amountTotalCents: number;
    currency: string;
  } | null;
  /** Task 6.4 (§40.7) — present only for a `charge.refunded` event. */
  refund?: {
    externalRefundId: string;
    chargeId: string;
    amountCents: number;
  } | null;
  /**
   * Credit system Phase 7 (Subscription Credits), Task 7.2 — present only
   * for an `invoice.payment_succeeded` whose `billing_reason` is
   * `subscription_cycle` (a genuine renewal). `subscription_create` (the
   * FIRST invoice) is explicitly excluded by the provider before this field
   * is ever set — never grants the plan's monthly allotment a second time
   * on top of the free-signup grant.
   */
  subscriptionRenewal?: {
    currentPeriodEnd: Date;
  } | null;
}

/** DI token for the active BillingProvider implementation. */
export const BILLING_PROVIDER_TOKEN = Symbol('BILLING_PROVIDER');
