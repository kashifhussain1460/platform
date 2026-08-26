import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { CREDIT_RESERVATION_SWEEP_QUEUE } from './credit-reservation-sweep.constants';
import { CreditReservationSweepProcessor } from './credit-reservation-sweep.processor';
import { CreditReservationSweepService } from './credit-reservation-sweep.service';
import { CreditBalanceService } from './credit-balance.service';
import { CreditCostCalculatorService } from './credit-cost-calculator.service';
import { CreditLedgerService } from './credit-ledger.service';
import { CreditRateAdminService } from './credit-rate-admin.service';
import { CreditReservationService } from './credit-reservation.service';
import { CreditRefundService } from './credit-refund.service';
import { SubscriptionCreditRenewalService } from './subscription-credit-renewal.service';
import { EnterpriseCreditAgreementService } from './enterprise-credit-agreement.service';
import { CreditLimitsService } from './credit-limits.service';
import { CreditReconciliationService } from './credit-reconciliation.service';
import { CreditRollupService } from './credit-rollup.service';
import { CompanyConcurrencyGuardService } from './company-concurrency-guard.service';

/**
 * Credit system (docs/architecture/orlixa-ai-credit-usage-billing-plan.md) —
 * the home for every cross-cutting credit service (ledger, reservation, cost
 * calculator, limits), mirroring this repo's existing precedent that
 * `workflow-runtime` lives alongside, not nested inside, `workflows`, and
 * `approval-routing` alongside `approvals`. This lets
 * EmployeesModule/WorkflowsModule/WorkflowRuntimeModule/SkillsModule import
 * it directly without pulling in BillingModule's Stripe/subscription
 * concerns.
 *
 * House rule (same as WorkflowRuntimeModule's): CreditsModule must never
 * import WorkflowsModule, EmployeesModule, or SkillsModule back — those
 * modules import THIS one, one-directionally, in later phases.
 *
 * Phase 1: empty and inert. Phase 2 (this revision) adds the core
 * money-moving primitives — append/balance/cost/rate/reserve/settle/
 * release/sweep — with ZERO real call sites wired to them yet (that is
 * Phase 3). Nothing in the running application reads or writes a credit
 * table through a real spend path until then.
 */
@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: CREDIT_RESERVATION_SWEEP_QUEUE }),
  ],
  providers: [
    CreditLedgerService,
    CreditBalanceService,
    CreditRateAdminService,
    CreditCostCalculatorService,
    CreditReservationService,
    CreditReservationSweepService,
    CreditRefundService,
    SubscriptionCreditRenewalService,
    EnterpriseCreditAgreementService,
    CreditLimitsService,
    CreditReconciliationService,
    CreditRollupService,
    CompanyConcurrencyGuardService,
    ...(queueWorkersEnabled() ? [CreditReservationSweepProcessor] : []),
  ],
  exports: [
    CreditLedgerService,
    CreditBalanceService,
    CreditRateAdminService,
    CreditCostCalculatorService,
    CreditReservationService,
    CreditReservationSweepService,
    CreditRefundService,
    SubscriptionCreditRenewalService,
    EnterpriseCreditAgreementService,
    CreditLimitsService,
    CreditReconciliationService,
    CreditRollupService,
    CompanyConcurrencyGuardService,
  ],
})
export class CreditsModule {}
