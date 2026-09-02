import { Injectable } from '@nestjs/common';
import { AuditRetentionService } from '../../audit/audit-retention.service';
import { CreditReconciliationService } from '../../credits/credit-reconciliation.service';
import { CreditRollupService } from '../../credits/credit-rollup.service';
import { EnterpriseCreditAgreementService } from '../../credits/enterprise-credit-agreement.service';
import { SubscriptionCreditRenewalService } from '../../credits/subscription-credit-renewal.service';
import { MarketingSyncService } from '../../engines/marketing/marketing-sync.service';
import { DataRetentionService } from '../../retention/data-retention.service';
import { AlertDispatchService } from '../alert-dispatch.service';
import type { PlatformSweepJob } from './platform-sweeps.constants';

/** One closed UTC day back — the window every nightly credit job operates on. */
function previousDay(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

/**
 * The eight periodic sweeps that have no queue of their own, behind ONE
 * implementation with two drivers:
 *
 *   - `PlatformSweepsProcessor` — BullMQ repeatables, on a worker deployment.
 *   - `CronController` — HTTP, for a serverless deployment or a manual ops run.
 *
 * Extracted so the two drivers cannot drift. Before this, the eight existed
 * only inside `CronController`'s switch, which meant a worker deployment ran
 * none of them — including the job that grants paying customers their monthly
 * credits.
 *
 * Return shapes are passed through untouched, because `/admin/cron/:job`
 * already returns them to whatever is scheduling it and that is a contract.
 */
@Injectable()
export class PlatformSweepsService {
  constructor(
    private readonly alerts: AlertDispatchService,
    private readonly auditRetention: AuditRetentionService,
    private readonly dataRetention: DataRetentionService,
    private readonly marketingSync: MarketingSyncService,
    private readonly subscriptionCreditRenewal: SubscriptionCreditRenewalService,
    private readonly enterpriseCreditAgreement: EnterpriseCreditAgreementService,
    private readonly creditReconciliation: CreditReconciliationService,
    private readonly creditRollup: CreditRollupService,
  ) {}

  async run(job: PlatformSweepJob): Promise<Record<string, unknown>> {
    switch (job) {
      case 'alerts':
        // WAVE 9 — the rules already evaluated correctly at `GET /admin/alerts`
        // and NOTHING EVER CALLED IT. Evaluating an alert nobody receives is a
        // log line with ambition; this is the half that notifies someone.
        return { ...(await this.alerts.sweep()) };
      case 'audit-retention':
        // WAVE 4 §4.5. Separate from `hr-retention` on purpose: audit has its
        // own floor and its own legal-hold rule, and must not be swept by a job
        // whose schedule and policy belong to operational data.
        return { ...(await this.auditRetention.sweep()) };
      case 'data-retention':
        // WAVE 8 §8.3 — workflow runs, step attempts, outbox, provider
        // snapshots, knowledge, memory, conversations and attachments. A third
        // sweep rather than an extension of the other two because each has a
        // genuinely different rule: audit has a floor it will not go below, HR
        // never touches the roster, and this one never touches an in-flight run.
        return { ...(await this.dataRetention.sweep()) };
      case 'marketing-analytics':
        // M-10 — deliberately a much lower cadence than marketing-sync (daily,
        // not every 10 minutes): see MarketingSyncService.snapshotAnalytics's
        // own doc comment for why folding this into the sync sweep would blow
        // Postiz's real instance-wide rate cap.
        return { ...(await this.marketingSync.snapshotAnalytics()) };
      case 'subscription-credit-renewal':
        // Credit system Phase 7, Task 7.3 — the fallback path for every tenant
        // with no real Stripe subscription to fire invoice.payment_succeeded.
        return { ...(await this.subscriptionCreditRenewal.grantDuePeriods()) };
      case 'enterprise-credit-agreement-renewal':
        // Credit system Phase 7, Task 7.4 — Enterprise's own recurring
        // allotment mechanism (blocked from the self-serve Stripe path).
        return { ...(await this.enterpriseCreditAgreement.grantDuePeriods()) };
      case 'credit-reconciliation':
        // Credit system Phase 10, Task 10.3 (§25.3) — for the PREVIOUS UTC day
        // (the day just closed, so every real-time reservation has settled).
        return { ...(await this.creditReconciliation.runDaily(previousDay())) };
      case 'credit-finance-rollup':
        // Credit system Phase 10, Task 10.4 (§24/§27) — same closed-day timing.
        return { ...(await this.creditRollup.runNightly(previousDay())) };
    }
  }
}
