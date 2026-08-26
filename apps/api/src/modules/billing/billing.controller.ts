import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  CreditBalanceDto,
  CreditLedgerEntryDto,
  CreditPackDto,
  PlanDto,
  SubscriptionDto,
  UsageDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { BillingService } from './billing.service';
import { ChangePlanDto } from './dto/change-plan.dto';
import { PurchaseCreditsDto } from './dto/purchase-credits.dto';
import { CreditBalanceService } from '../credits/credit-balance.service';
import { CreditLedgerService } from '../credits/credit-ledger.service';
import { CreditPackCatalogService } from './credit-packs';
import { decimalToNumber } from '../credits/credits.types';

/**
 * Billing & Subscription routes: tenant-scoped by companyId (from the JWT),
 * JWT-guarded. Plans are code-defined; the subscription self-heals to a default
 * STARTER/ACTIVE on read. Plan limits are SOFT — usage is informational only.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly creditBalance: CreditBalanceService,
    private readonly creditLedger: CreditLedgerService,
    private readonly creditPackCatalog: CreditPackCatalogService,
  ) {}

  /** The code-defined plan catalog. */
  @Get('plans')
  plans(): PlanDto[] {
    return this.billing.plans();
  }

  /** Current subscription (auto-creates the default if missing). */
  @Get('subscription')
  subscription(@CurrentTenant() companyId: string): Promise<SubscriptionDto> {
    return this.billing.getSubscription(companyId);
  }

  /** Change plan via the active provider (mock: immediate; Stripe: TODO checkout). */
  @Post('subscription')
  @Roles('OWNER', 'ADMIN')
  changePlan(
    @CurrentTenant() companyId: string,
    @Body() dto: ChangePlanDto,
  ): Promise<SubscriptionDto> {
    return this.billing.changePlan(companyId, dto);
  }

  /** On-the-fly usage snapshot + plan limit + soft over-limit flag. */
  @Get('usage')
  usage(@CurrentTenant() companyId: string): Promise<UsageDto> {
    return this.billing.usage(companyId);
  }

  /** Credit system (Phase 4+) — the company's current credit balance, self-healing to zero. */
  @Get('credits')
  async credits(@CurrentTenant() companyId: string): Promise<CreditBalanceDto> {
    const [snapshot, trailingMonthlyDebits] = await Promise.all([
      this.creditBalance.getBalance(companyId),
      this.creditBalance.getTrailingMonthlyDebits(companyId),
    ]);
    return {
      companyId: snapshot.companyId,
      balance: snapshot.balance,
      reservedBalance: snapshot.reservedBalance,
      lastReconciledAt: snapshot.lastReconciledAt?.toISOString() ?? null,
      updatedAt: snapshot.updatedAt.toISOString(),
      trailingMonthlyDebits,
    };
  }

  /**
   * Credit system Phase 5 (PAYG), Task 5.2 — creates ONLY a Stripe Checkout
   * Session; mints zero credits (Phase 6's webhook is the only path allowed
   * to grant). Task 5.3's throttle reuses `workflows.controller.ts`'s
   * existing 10/60s constant verbatim.
   */
  @Post('credits/purchase')
  @Roles('OWNER', 'ADMIN')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  purchaseCredits(
    @CurrentTenant() companyId: string,
    @Body() dto: PurchaseCreditsDto,
  ): Promise<{ checkoutUrl: string | null }> {
    return this.billing.purchaseCredits(companyId, dto.packId);
  }

  /**
   * Credit system Phase 9, Task 9.3 — the active credit-pack catalog, a
   * straightforward read with no credit effect (never mints or reserves).
   */
  @Get('credit-packs')
  async creditPacks(): Promise<CreditPackDto[]> {
    const packs = await this.creditPackCatalog.listActive();
    return packs.map((p) => ({
      id: p.id,
      packKey: p.packKey,
      displayName: p.displayName,
      creditAmount: decimalToNumber(p.creditAmount),
      bonusPercent: decimalToNumber(p.bonusPercent),
      priceUsd: decimalToNumber(p.priceUsd),
    }));
  }

  /**
   * Credit system Phase 9, Task 9.5 — the row-level ledger for the Usage
   * page. OWNER/ADMIN only (§31.2.2's `credits:read` gate) — a MEMBER sees an
   * access-denied state in the UI rather than a raw 403 page.
   */
  @Get('credits/usage')
  @Roles('OWNER', 'ADMIN')
  async creditsUsage(
    @CurrentTenant() companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('source') source?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limit?: string,
  ): Promise<CreditLedgerEntryDto[]> {
    const entries = await this.creditLedger.listEntries({
      companyId,
      employeeId,
      source,
      since: since ? new Date(since) : undefined,
      until: until ? new Date(until) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return entries.map((e) => ({
      id: e.id,
      companyId: e.companyId,
      employeeId: e.employeeId,
      workflowId: e.workflowId,
      workflowRunId: e.workflowRunId,
      workflowStepRunId: e.workflowStepRunId,
      conversationId: e.conversationId,
      executionId: e.executionId,
      reservationId: e.reservationId,
      transactionType: e.transactionType,
      grantKind: e.grantKind,
      amount: e.amount,
      balanceBefore: e.balanceBefore,
      balanceAfter: e.balanceAfter,
      reason: e.reason,
      source: e.source,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  /**
   * A hosted page to manage payment method/invoices/cancellation. `url` is
   * null when the active provider has no such concept (mock) or there's no
   * real external customer yet.
   */
  @Post('portal')
  @Roles('OWNER', 'ADMIN')
  portal(@CurrentTenant() companyId: string): Promise<{ url: string | null }> {
    return this.billing.getPortalUrl(companyId);
  }
}
