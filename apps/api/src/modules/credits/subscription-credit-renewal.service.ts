import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
import { PLAN_CATALOG } from '../billing/billing.plans';

const RENEWAL_SWEEP_BATCH = 200;

/** One calendar month out — mirrors billing.service.ts's own `addOneMonth`. */
function addOneMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/**
 * Credit system Phase 7, Task 7.3 (§40.4's fallback) — the majority of
 * tenants have no real Stripe subscription to fire `invoice.payment_succeeded`
 * (Task 7.2), so this daily cross-tenant sweep drives the SAME grant for
 * every `provider:'mock'` company whose period has come due. Grants via the
 * IDENTICAL `alloc:{companyId}:{currentPeriodEnd}` idempotency key Task 7.2
 * uses (keyed on the UPCOMING period-end this grant activates for, matching
 * that task's own semantic exactly) — a later mock→Stripe migration for the
 * same company/period can never double-grant.
 */
@Injectable()
export class SubscriptionCreditRenewalService {
  private readonly logger = new Logger(SubscriptionCreditRenewalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
  ) {}

  async grantDuePeriods(asOf: Date = new Date()): Promise<{ granted: number }> {
    const due = await this.prisma.subscription.findMany({
      where: { provider: 'mock', status: 'ACTIVE', currentPeriodEnd: { lte: asOf } },
      take: RENEWAL_SWEEP_BATCH,
    });

    let granted = 0;
    for (const sub of due) {
      try {
        const currentEnd = sub.currentPeriodEnd ?? asOf;
        const newPeriodEnd = addOneMonth(currentEnd);
        await this.prisma.$transaction(async (tx) => {
          // Advance the period FIRST — a genuinely unrecoverable failure in
          // the grant below still leaves the subscription correctly rolled
          // forward (this same guarded WHERE excludes it from the next tick
          // regardless), matching Task 7.2's own "always update the period"
          // behavior.
          const claimed = await tx.subscription.updateMany({
            where: { id: sub.id, currentPeriodEnd: currentEnd },
            data: { currentPeriodEnd: newPeriodEnd },
          });
          if (claimed.count === 0) return; // a concurrent tick already claimed this row

          const included =
            PLAN_CATALOG[sub.plan as keyof typeof PLAN_CATALOG]?.includedCreditsPerMonth;
          if (!included) return; // this plan has no recurring allotment

          const entry = await this.ledger.append(
            {
              companyId: sub.companyId,
              transactionType: 'CREDIT',
              grantKind: 'PLAN_ALLOTMENT',
              amount: included,
              reason: `Monthly plan allotment (${sub.plan})`,
              source: 'SYSTEM',
              idempotencyKey: `alloc:${sub.companyId}:${newPeriodEnd.toISOString()}`,
            },
            tx,
          );
          await tx.creditLot.create({
            data: {
              companyId: sub.companyId,
              originLedgerEntryId: entry.id,
              grantKind: 'PLAN_ALLOTMENT',
              grantedAmount: included,
              remaining: included,
              expiresAt: newPeriodEnd,
            },
          });
        });
        granted += 1;
      } catch (err) {
        this.logger.error(
          `subscription-credit-renewal failed for subscription ${sub.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { granted };
  }
}
