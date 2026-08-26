import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ChangePlanDto,
  PlanDto,
  SubscriptionDto,
  UsageDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { AuditLogService } from '../audit/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  BILLING_PROVIDER_TOKEN,
  type BillingProvider,
  type BillingWebhookEvent,
} from './billing.provider';
import { toSubscriptionDto } from './billing.mapper';
import { PLAN_CATALOG, PLAN_LIST, maxEmployeesFor } from './billing.plans';
import { CREDIT_PACK_IDS } from './credit-packs';
import { creditPaygEnabled } from '../../common/config/credit-config';
import { CreditLedgerService } from '../credits/credit-ledger.service';
import { CreditRefundService } from '../credits/credit-refund.service';

/**
 * Billing & Subscription (Steps 1 + 13). One subscription per company; every
 * company gets a default STARTER/ACTIVE subscription at registration (and older
 * companies self-heal on read). Plan changes go through the swappable
 * BillingProvider (mock by default). Usage is computed ON THE FLY from existing
 * data (no usage table) and plan limits are SOFT — surfaced but never enforced.
 * Every query is scoped by companyId (from the JWT).
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER_TOKEN)
    private readonly provider: BillingProvider,
    private readonly usageService: UsageService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly creditLedger: CreditLedgerService,
    private readonly creditRefund: CreditRefundService,
  ) {}

  /** The code-defined plan catalog. */
  plans(): PlanDto[] {
    return [...PLAN_LIST];
  }

  /**
   * Create a default STARTER/ACTIVE subscription if the company has none.
   * Idempotent: safe to call at registration AND on every read (self-heal).
   */
  async ensureDefaultSubscription(companyId: string): Promise<SubscriptionDto> {
    const existing = await this.prisma.subscription.findUnique({
      where: { companyId },
    });
    if (existing) {
      return toSubscriptionDto(existing);
    }
    const { externalCustomerId } = await this.provider.ensureCustomer({
      id: companyId,
    });
    try {
      const created = await this.prisma.subscription.create({
        data: {
          companyId,
          plan: 'STARTER',
          status: 'ACTIVE',
          provider: this.provider.name,
          externalCustomerId,
          // Credit system Phase 6, Task 6.2 (Q17 fix) — a real stored
          // instant from day one, never left null (which previously made
          // EVERY freshly-registered company's period end permanently
          // unknown, mock or not).
          currentPeriodEnd: addOneMonth(new Date()),
        },
      });
      return toSubscriptionDto(created);
    } catch (err) {
      // Lost a create race (unique companyId) — return the winner.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const row = await this.prisma.subscription.findUniqueOrThrow({
          where: { companyId },
        });
        return toSubscriptionDto(row);
      }
      throw err;
    }
  }

  /** Current subscription (auto-creating the default if missing). */
  getSubscription(companyId: string): Promise<SubscriptionDto> {
    return this.ensureDefaultSubscription(companyId);
  }

  /** Change plan via the provider, then persist the resolved fields. */
  async changePlan(
    companyId: string,
    dto: ChangePlanDto,
  ): Promise<SubscriptionDto> {
    // ENTERPRISE is custom/sales-priced (docs/specs/hiring-and-subscription-
    // linkage.md Part D #7) — never self-serve, regardless of provider (mock
    // would otherwise switch anyone to "unlimited, free" instantly).
    if (dto.plan === 'ENTERPRISE') {
      throw new BadRequestException(
        'Enterprise is custom-priced — contact sales to switch to this plan.',
      );
    }
    await this.ensureDefaultSubscription(companyId);
    const current = await this.prisma.subscription.findUniqueOrThrow({
      where: { companyId },
    });
    const result = await this.provider.changePlan(current, dto.plan);
    const updated = await this.prisma.subscription.update({
      where: { companyId },
      data: {
        // Stripe returns the CURRENT plan/status (checkout pending) — the switch
        // is applied later by the webhook. Mock returns the target immediately.
        plan: result.plan,
        status: result.status,
        externalCustomerId:
          result.externalCustomerId ?? current.externalCustomerId,
        externalSubscriptionId:
          result.externalSubscriptionId ?? current.externalSubscriptionId,
        currentPeriodEnd:
          result.currentPeriodEnd ?? current.currentPeriodEnd,
      },
    });
    const dtoOut = toSubscriptionDto(updated);
    // Surface a hosted checkout url when a provider returns one (Stripe).
    if (result.checkoutUrl) {
      dtoOut.checkoutUrl = result.checkoutUrl;
    }
    return dtoOut;
  }

  /**
   * A hosted page to manage payment method, see past invoices, and cancel
   * (founder-market-readiness-audit.md §8) -- none of which this app builds
   * its own screen for. null when the active provider has no such concept
   * (mock) or the company has no external customer yet; the frontend then
   * explains billing management isn't available in mock mode.
   */
  async getPortalUrl(companyId: string): Promise<{ url: string | null }> {
    if (!this.provider.createPortalSession) {
      return { url: null };
    }
    await this.ensureDefaultSubscription(companyId);
    const subscription = await this.prisma.subscription.findUniqueOrThrow({
      where: { companyId },
    });
    if (
      !subscription.externalCustomerId ||
      subscription.externalCustomerId.startsWith('cus_mock_')
    ) {
      return { url: null };
    }
    const session = await this.provider.createPortalSession(
      subscription.externalCustomerId,
    );
    return { url: session?.url ?? null };
  }

  /**
   * Credit system Phase 5, Task 5.2 (§31.2.3) — the client picks a `packId`,
   * the SERVER ALONE decides the price (looked up fresh from the DB-
   * authoritative `CreditPack` row, never trusted from the request). Creates
   * ZERO ledger effect: `{checkoutUrl: null}` under mock or when the company
   * has no real external customer yet (matching `getPortalUrl`'s existing
   * convention) — never a broken redirect.
   */
  async purchaseCredits(
    companyId: string,
    packId: string,
  ): Promise<{ checkoutUrl: string | null }> {
    if (!(CREDIT_PACK_IDS as readonly string[]).includes(packId)) {
      throw new BadRequestException(`Unknown credit pack: ${packId}`);
    }
    if (!creditPaygEnabled() || !this.provider.createCreditCheckoutSession) {
      return { checkoutUrl: null };
    }
    const pack = await this.prisma.creditPack.findFirst({
      where: { packKey: packId, active: true },
    });
    if (!pack) {
      throw new BadRequestException(`Credit pack "${packId}" is not currently available`);
    }
    if (!pack.stripePriceId) {
      throw new BadRequestException(
        `No Stripe price configured for credit pack ${packId} (set STRIPE_PRICE_CREDITS_${packId})`,
      );
    }
    await this.ensureDefaultSubscription(companyId);
    const subscription = await this.prisma.subscription.findUniqueOrThrow({
      where: { companyId },
    });
    if (
      !subscription.externalCustomerId ||
      subscription.externalCustomerId.startsWith('cus_mock_')
    ) {
      return { checkoutUrl: null };
    }
    const session = await this.provider.createCreditCheckoutSession({
      externalCustomerId: subscription.externalCustomerId,
      companyId,
      packId,
      creditPackRateId: pack.id,
      stripePriceId: pack.stripePriceId,
    });
    return { checkoutUrl: session?.url ?? null };
  }

  /**
   * Verify + apply a provider webhook (Stripe). The provider verifies the raw
   * body/signature (throwing → 400 on an unverifiable request) and normalizes
   * the event. A provider without webhook support (mock) yields a 400.
   * Unknown/ignored events are a no-op.
   *
   * Credit system Phase 6, Task 6.1 (§17.2/§32.4) — `ProcessedWebhookEvent`
   * is the FIRST statement in the transaction, before any downstream effect;
   * a P2002 (this exact delivery already processed, or a concurrent
   * redelivery racing this one) is caught OUTSIDE the `$transaction` call —
   * never inside the callback, which would try to keep issuing statements
   * against a Postgres transaction Postgres has already aborted (the same
   * trap `CreditLedgerService.append`'s standalone branch guards against).
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ received: boolean }> {
    if (!this.provider.parseWebhookEvent) {
      throw new BadRequestException(
        'Billing provider does not support webhooks',
      );
    }
    const event = await this.provider.parseWebhookEvent(rawBody, signature);
    if (!event) {
      return { received: true };
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedWebhookEvent.create({
          data: {
            provider: 'stripe',
            externalEventId: event.externalEventId,
            eventType: event.type,
            companyId: event.companyId ?? null,
            payload: event.payload as Prisma.InputJsonValue,
          },
        });
        await this.applyWebhookEvent(event, tx);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Already processed (or lost this exact race) — a clean 200 no-op,
        // never a retry of a request the platform already understood.
        return { received: true };
      }
      throw err;
    }
    return { received: true };
  }

  /** Dispatch a normalized webhook event to its handler, inside the dedupe transaction. */
  private async applyWebhookEvent(
    event: BillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (event.creditPurchase) {
      return this.applyCreditPurchase(event, tx);
    }
    if (event.subscriptionRenewal) {
      return this.applySubscriptionRenewal(event, tx);
    }
    if (event.refund) {
      // Task 6.4 — deliberately NOT part of the same transaction: it has no
      // ledger effect today (see CreditRefundService's own doc comment), so
      // there is nothing here that needs the dedupe transaction's atomicity.
      await this.creditRefund.refundFromStripeEvent({
        companyId: event.companyId ?? null,
        chargeId: event.refund.chargeId,
        externalRefundId: event.refund.externalRefundId,
        amountCents: event.refund.amountCents,
      });
      return;
    }
    return this.applySubscriptionEvent(event, tx);
  }

  /**
   * Credit system Phase 6, Task 6.3 (§31.2.3/Q19) — the PAYG grant loop's
   * completion. Validates `session.amount_total`/`currency` against the
   * EXACT snapshotted `CreditPack` row (`creditPackRateId`, captured at
   * Task 5.2's session-creation time) — never "whichever pack row is
   * current now". On a mismatch: no grant, logged loudly, 200 (never retry
   * a request the platform already understood correctly).
   */
  private async applyCreditPurchase(
    event: BillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const cp = event.creditPurchase!;
    if (!event.companyId) {
      this.logger.error(
        `credit purchase webhook has no companyId (session=${cp.sessionId}) — cannot grant`,
      );
      return;
    }
    const pack = await tx.creditPack.findUnique({ where: { id: cp.creditPackRateId } });
    if (!pack) {
      this.logger.error(
        `credit purchase webhook references unknown CreditPack ${cp.creditPackRateId} (session=${cp.sessionId})`,
      );
      return;
    }
    const expectedCents = Math.round(Number(pack.priceUsd) * 100);
    if (cp.amountTotalCents !== expectedCents || cp.currency.toLowerCase() !== 'usd') {
      this.logger.error(
        `credit purchase amount mismatch: session=${cp.sessionId} expected=${expectedCents}c(usd) ` +
          `got=${cp.amountTotalCents}c(${cp.currency}) — NO GRANT, investigate immediately`,
      );
      return;
    }
    const amount = Number(pack.creditAmount) * (1 + Number(pack.bonusPercent) / 100);
    const entry = await this.creditLedger.append(
      {
        companyId: event.companyId,
        transactionType: 'CREDIT',
        grantKind: 'PACK_PURCHASE',
        amount,
        packId: pack.id,
        reason: `Credit pack purchase: ${pack.displayName}`,
        source: 'SYSTEM',
        idempotencyKey: `purchase:${cp.sessionId}`,
      },
      tx,
    );
    await tx.creditLot.create({
      data: {
        companyId: event.companyId,
        originLedgerEntryId: entry.id,
        grantKind: 'PACK_PURCHASE',
        grantedAmount: amount,
        remaining: amount,
        expiresAt: null, // purchased credits never expire (§40.6)
      },
    });
  }

  /**
   * Credit system Phase 7, Task 7.2 — the plan's `includedCreditsPerMonth`
   * allotment, granted on a genuine renewal cycle (never the first period —
   * the provider already filtered that out before this event ever reaches
   * here). `null` (STARTER/ENTERPRISE) is a no-op: no recurring grant via
   * this path. Idempotent on `alloc:{companyId}:{currentPeriodEnd}` — the
   * IDENTICAL key `Task 7.3`'s mock-subscription fallback uses, so a later
   * mock→Stripe migration for the same company/period never double-grants.
   */
  private async applySubscriptionRenewal(
    event: BillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const renewal = event.subscriptionRenewal!;
    let subscription = event.companyId
      ? await tx.subscription.findUnique({ where: { companyId: event.companyId } })
      : null;
    if (!subscription && event.externalSubscriptionId) {
      subscription = await tx.subscription.findFirst({
        where: { externalSubscriptionId: event.externalSubscriptionId },
      });
    }
    if (!subscription && event.externalCustomerId) {
      subscription = await tx.subscription.findFirst({
        where: { externalCustomerId: event.externalCustomerId },
      });
    }
    if (!subscription) {
      return; // unknown subscription — nothing to reconcile
    }

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { currentPeriodEnd: renewal.currentPeriodEnd },
    });

    const included = PLAN_CATALOG[subscription.plan as keyof typeof PLAN_CATALOG]
      ?.includedCreditsPerMonth;
    if (!included) {
      return; // this plan has no recurring allotment
    }
    const entry = await this.creditLedger.append(
      {
        companyId: subscription.companyId,
        transactionType: 'CREDIT',
        grantKind: 'PLAN_ALLOTMENT',
        amount: included,
        reason: `Monthly plan allotment (${subscription.plan})`,
        source: 'SYSTEM',
        idempotencyKey: `alloc:${subscription.companyId}:${renewal.currentPeriodEnd.toISOString()}`,
      },
      tx,
    );
    await tx.creditLot.create({
      data: {
        companyId: subscription.companyId,
        originLedgerEntryId: entry.id,
        grantKind: 'PLAN_ALLOTMENT',
        grantedAmount: included,
        remaining: included,
        expiresAt: renewal.currentPeriodEnd, // use-it-or-lose-it
      },
    });
  }

  /** Reconcile one normalized subscription-affecting webhook event onto the local Subscription. */
  private async applySubscriptionEvent(
    event: BillingWebhookEvent,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // Resolve the tenant: prefer the companyId in the event metadata, then the
    // stored external subscription/customer id.
    let subscription = event.companyId
      ? await tx.subscription.findUnique({
          where: { companyId: event.companyId },
        })
      : null;
    if (!subscription && event.externalSubscriptionId) {
      subscription = await tx.subscription.findFirst({
        where: { externalSubscriptionId: event.externalSubscriptionId },
      });
    }
    if (!subscription && event.externalCustomerId) {
      subscription = await tx.subscription.findFirst({
        where: { externalCustomerId: event.externalCustomerId },
      });
    }
    if (!subscription) {
      return; // unknown subscription — nothing to reconcile
    }

    // Credit system Phase 6, Task 6.2 (Q16 fix) — the out-of-order guard
    // covers `plan` too, not just `status`: a stale event arriving after a
    // newer one must not revert EITHER field. Still marks the event
    // processed (the outer transaction commits regardless) — just skips
    // the overwrite.
    const isStale =
      subscription.lastAppliedEventCreatedAt != null &&
      event.createdAt < subscription.lastAppliedEventCreatedAt;
    if (isStale) {
      this.logger.warn(
        `ignoring stale webhook event ${event.externalEventId} (${event.type}) for subscription ${subscription.id} — ` +
          `event created ${event.createdAt.toISOString()}, already applied one from ${subscription.lastAppliedEventCreatedAt!.toISOString()}`,
      );
      return;
    }

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        plan: event.plan ?? subscription.plan,
        status: event.status ?? subscription.status,
        externalCustomerId:
          event.externalCustomerId ?? subscription.externalCustomerId,
        externalSubscriptionId:
          event.externalSubscriptionId ?? subscription.externalSubscriptionId,
        currentPeriodEnd:
          event.currentPeriodEnd ?? subscription.currentPeriodEnd,
        lastAppliedEventId: event.externalEventId,
        lastAppliedEventCreatedAt: event.createdAt,
      },
    });

    // A genuine transition INTO past-due (not an already-past-due company
    // re-notifying) is recorded to the audit log AND emails the company owners
    // (best-effort; no-op when mail is disabled).
    if (event.status === 'PAST_DUE' && subscription.status !== 'PAST_DUE') {
      await this.auditLog.record({
        companyId: subscription.companyId,
        action: 'billing.payment_failed',
        entityType: 'Subscription',
        entityId: subscription.id,
        metadata: { plan: subscription.plan, eventType: event.type },
      });
      await this.notifications.paymentFailed(subscription.companyId);
    }
  }

  /**
   * On-the-fly usage snapshot. `tasks` reuses the analytics definition
   * (SkillExecution SUCCESS + assistant Messages + WorkflowRun COMPLETED).
   * `tokens`/`estimatedCostUsd` are real (UsageService); `voiceMinutes` is a
   * placeholder (no voice feature exists). `overEmployeeLimit` is SOFT/informational.
   */
  async usage(companyId: string): Promise<UsageDto> {
    const subscription = await this.ensureDefaultSubscription(companyId);
    const plan = subscription.plan;

    const [
      employees,
      installedSkills,
      toolSuccess,
      assistantMessages,
      workflowCompleted,
      llmUsage,
    ] = await Promise.all([
      this.prisma.aiEmployee.count({ where: { companyId } }),
      this.prisma.installedSkill.count({ where: { companyId } }),
      this.prisma.skillExecution.count({
        where: { companyId, status: 'SUCCESS' },
      }),
      this.prisma.message.count({ where: { companyId, role: 'ASSISTANT' } }),
      this.prisma.workflowRun.count({
        where: { companyId, status: 'COMPLETED' },
      }),
      this.usageService.totalsForCompany(companyId),
    ]);

    const maxEmployees = maxEmployeesFor(plan);
    return {
      plan,
      maxEmployees,
      employees,
      installedSkills,
      tasks: toolSuccess + assistantMessages + workflowCompleted,
      tokens: llmUsage.promptTokens + llmUsage.completionTokens,
      estimatedCostUsd: llmUsage.estimatedCostUsd,
      voiceMinutes: 0,
      overEmployeeLimit: maxEmployees !== null && employees > maxEmployees,
    };
  }
}

/** One calendar month out, matching a monthly billing cycle (Task 6.2). */
function addOneMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}
