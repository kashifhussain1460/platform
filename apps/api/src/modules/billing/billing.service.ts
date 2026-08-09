import { BadRequestException, Inject, Injectable } from '@nestjs/common';
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
import { PLAN_LIST, maxEmployeesFor } from './billing.plans';

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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER_TOKEN)
    private readonly provider: BillingProvider,
    private readonly usageService: UsageService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
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
   * Verify + apply a provider webhook (Stripe). The provider verifies the raw
   * body/signature (throwing → 400 on an unverifiable request) and normalizes the
   * event; we then reconcile the local Subscription. A provider without webhook
   * support (mock) yields a 400. Unknown/ignored events are a no-op.
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
    if (event) {
      await this.applyWebhookEvent(event);
    }
    return { received: true };
  }

  /** Reconcile one normalized webhook event onto the local Subscription. */
  private async applyWebhookEvent(event: BillingWebhookEvent): Promise<void> {
    // Resolve the tenant: prefer the companyId in the event metadata, then the
    // stored external subscription/customer id.
    let subscription = event.companyId
      ? await this.prisma.subscription.findUnique({
          where: { companyId: event.companyId },
        })
      : null;
    if (!subscription && event.externalSubscriptionId) {
      subscription = await this.prisma.subscription.findFirst({
        where: { externalSubscriptionId: event.externalSubscriptionId },
      });
    }
    if (!subscription && event.externalCustomerId) {
      subscription = await this.prisma.subscription.findFirst({
        where: { externalCustomerId: event.externalCustomerId },
      });
    }
    if (!subscription) {
      return; // unknown subscription — nothing to reconcile
    }
    await this.prisma.subscription.update({
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
