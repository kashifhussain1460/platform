import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Plan, SubscriptionStatus } from '@vaep/types';
import type { Subscription } from '@prisma/client';
import type {
  BillingCompany,
  BillingProvider,
  BillingWebhookEvent,
  ChangePlanResult,
  EnsureCustomerResult,
} from '../billing.provider';

/**
 * Opt-in Stripe billing backend (`BILLING_PROVIDER=stripe`). `stripe` is imported
 * LAZILY (NOT a package.json dependency — install it only when this provider is
 * used) and needs `STRIPE_SECRET_KEY`.
 *
 * - ensureCustomer: create/retrieve the Stripe customer (id stored on the row).
 * - changePlan: create a hosted Checkout Session for the target plan's price
 *   (`STRIPE_PRICE_<PLAN>`) and return its `checkoutUrl`; the LOCAL plan is left
 *   unchanged until the webhook confirms the switch.
 * - parseWebhookEvent: verify the Stripe signature (`STRIPE_WEBHOOK_SECRET`) and
 *   normalize checkout/subscription events for BillingService to apply.
 *
 * TODO: proration on same-session upgrades, a customer billing portal link, and
 * richer status handling (trialing/incomplete).
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';

  // Stripe SDK client, created once (lazy). Typed loosely — optional dep.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  constructor(private readonly config: ConfigService) {}

  async ensureCustomer(company: BillingCompany): Promise<EnsureCustomerResult> {
    const stripe = await this.getClient();
    const customer = await stripe.customers.create({
      name: company.name,
      metadata: { companyId: company.id },
    });
    return { externalCustomerId: customer.id as string };
  }

  async changePlan(
    subscription: Subscription,
    plan: Plan,
  ): Promise<ChangePlanResult> {
    const priceId = this.config.get<string>(`STRIPE_PRICE_${plan}`)?.trim();
    if (!priceId) {
      throw new BadRequestException(
        `No Stripe price configured for plan ${plan} (set STRIPE_PRICE_${plan})`,
      );
    }
    const stripe = await this.getClient();

    // Ensure a real Stripe customer (older rows may carry a `cus_mock_*` id).
    let customerId = subscription.externalCustomerId ?? undefined;
    if (!customerId || customerId.startsWith('cus_mock_')) {
      const customer = await stripe.customers.create({
        metadata: { companyId: subscription.companyId },
      });
      customerId = customer.id as string;
    }

    const web = this.webOrigin();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${web}/billing?checkout=success`,
      cancel_url: `${web}/billing?checkout=cancel`,
      metadata: { companyId: subscription.companyId, plan },
      subscription_data: {
        metadata: { companyId: subscription.companyId, plan },
      },
    });

    // Keep the CURRENT plan/status — the webhook flips it once payment succeeds.
    return {
      plan: subscription.plan,
      status: subscription.status,
      externalCustomerId: customerId,
      checkoutUrl: (session.url as string) ?? null,
    };
  }

  async parseWebhookEvent(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<BillingWebhookEvent | null> {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim();
    if (!secret) {
      throw new BadRequestException('Stripe webhook secret not configured');
    }
    if (!rawBody || !signature) {
      throw new BadRequestException('Missing webhook body or signature');
    }
    const stripe = await this.getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let event: any;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      throw new BadRequestException(
        `Invalid Stripe signature: ${
          err instanceof Error ? err.message : 'verification failed'
        }`,
      );
    }

    const object = event.data?.object ?? {};
    switch (event.type) {
      case 'checkout.session.completed':
        return {
          type: event.type,
          companyId: object.metadata?.companyId ?? null,
          externalCustomerId: this.idOf(object.customer),
          externalSubscriptionId: this.idOf(object.subscription),
          plan: this.planOf(object.metadata?.plan),
          status: 'ACTIVE',
        };
      case 'customer.subscription.updated':
        return {
          type: event.type,
          companyId: object.metadata?.companyId ?? null,
          externalCustomerId: this.idOf(object.customer),
          externalSubscriptionId: this.idOf(object.id),
          plan: this.planOf(object.metadata?.plan) ?? this.planForPrice(object),
          status: this.statusOf(object.status),
          currentPeriodEnd: this.periodEnd(object.current_period_end),
        };
      case 'customer.subscription.deleted':
        return {
          type: event.type,
          companyId: object.metadata?.companyId ?? null,
          externalCustomerId: this.idOf(object.customer),
          externalSubscriptionId: this.idOf(object.id),
          status: 'CANCELED',
        };
      // Explicit alongside customer.subscription.updated (which Stripe also
      // sends on a failed payment) so a failure is never missed if Stripe's
      // event ordering/timing ever varies -- BillingService logs the
      // transition into PAST_DUE either way.
      case 'invoice.payment_failed':
        return {
          type: event.type,
          companyId: object.subscription_details?.metadata?.companyId ?? null,
          externalCustomerId: this.idOf(object.customer),
          externalSubscriptionId: this.idOf(object.subscription),
          status: 'PAST_DUE',
        };
      default:
        return null; // event we don't act on
    }
  }

  /** Hosted Stripe Customer Portal session (manage payment method, invoices, cancel). */
  async createPortalSession(
    externalCustomerId: string,
  ): Promise<{ url: string } | null> {
    const stripe = await this.getClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: externalCustomerId,
      return_url: `${this.webOrigin()}/billing`,
    });
    return { url: session.url as string };
  }

  // --- helpers --------------------------------------------------------------

  /** Stripe fields are `string | { id }` when expanded — normalize to the id. */
  private idOf(value: unknown): string | null {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object' && 'id' in value) {
      return String((value as { id: unknown }).id);
    }
    return null;
  }

  private planOf(value: unknown): Plan | null {
    const plans: Plan[] = ['STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE'];
    return typeof value === 'string' && plans.includes(value as Plan)
      ? (value as Plan)
      : null;
  }

  /** Reverse-map the subscription's price id back to a plan via STRIPE_PRICE_*. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private planForPrice(sub: any): Plan | null {
    const priceId: string | undefined =
      sub?.items?.data?.[0]?.price?.id ?? undefined;
    if (!priceId) {
      return null;
    }
    const plans: Plan[] = ['STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE'];
    for (const plan of plans) {
      if (this.config.get<string>(`STRIPE_PRICE_${plan}`)?.trim() === priceId) {
        return plan;
      }
    }
    return null;
  }

  private statusOf(stripeStatus: unknown): SubscriptionStatus | null {
    switch (stripeStatus) {
      case 'active':
      case 'trialing':
        return 'ACTIVE';
      case 'past_due':
      case 'unpaid':
        return 'PAST_DUE';
      case 'canceled':
      case 'incomplete_expired':
        return 'CANCELED';
      default:
        return null; // leave the local status unchanged
    }
  }

  private periodEnd(unixSeconds: unknown): Date | null {
    return typeof unixSeconds === 'number'
      ? new Date(unixSeconds * 1000)
      : null;
  }

  private webOrigin(): string {
    return (
      this.config.get<string>('WEB_ORIGIN')?.replace(/\/$/, '') ??
      'http://localhost:3000'
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sdk(): Promise<any> {
    return import('stripe');
  }

  private async getClient() {
    if (!this.client) {
      const mod = await this.sdk();
      const Stripe = mod.default ?? mod;
      this.client = new Stripe(
        this.config.getOrThrow<string>('STRIPE_SECRET_KEY'),
      );
    }
    return this.client;
  }
}
