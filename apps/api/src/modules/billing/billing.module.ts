import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requireRealProviderInProduction } from '../../common/config/require-real-provider';
import { NotificationsModule } from '../notifications/notifications.module';
import { CreditsModule } from '../credits/credits.module';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingService } from './billing.service';
import { PlanGuard } from './plan.guard';
import {
  BILLING_PROVIDER_TOKEN,
  type BillingProvider,
} from './billing.provider';
import { MockBillingProvider } from './providers/mock-billing.provider';
import { StripeBillingProvider } from './providers/stripe-billing.provider';
import { CreditPackCatalogService } from './credit-packs';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { PlatformAdminCreditsController } from './platform-admin/platform-admin-credits.controller';
import { FinanceReportingController } from './platform-admin/finance-reporting.controller';
import { EnforcementCohortController } from './platform-admin/enforcement-cohort.controller';

/**
 * Pick the billing backend from BILLING_PROVIDER (default: mock — offline,
 * deterministic, no external calls). `stripe` is opt-in and lazily imports the
 * Stripe SDK (NOT a package.json dependency). Mirrors the embeddings / storage
 * provider factories.
 */
function billingProviderFactory(config: ConfigService): BillingProvider {
  const kind = (config.get<string>('BILLING_PROVIDER') ?? 'mock').toLowerCase();
  switch (kind) {
    case 'stripe':
      return new StripeBillingProvider(config);
    case 'mock':
    default:
      requireRealProviderInProduction('BILLING_PROVIDER', 'mock');
      return new MockBillingProvider();
  }
}

/**
 * Billing & Subscription module. Exports BillingService so AuthModule can create
 * a default subscription at registration. Billing must NOT import AuthModule
 * (avoids a cycle — AuthModule imports this one); JwtAuthGuard works because the
 * JWT passport strategy is registered globally by AuthModule.
 */
@Module({
  imports: [NotificationsModule, CreditsModule, PlatformAdminModule],
  controllers: [
    BillingController,
    BillingWebhookController,
    PlatformAdminCreditsController,
    FinanceReportingController,
    EnforcementCohortController,
  ],
  providers: [
    BillingService,
    PlanGuard,
    CreditPackCatalogService,
    {
      provide: BILLING_PROVIDER_TOKEN,
      inject: [ConfigService],
      useFactory: billingProviderFactory,
    },
  ],
  exports: [BillingService, PlanGuard, CreditPackCatalogService],
})
export class BillingModule {}
