import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
import { decimalToNumber } from './credits.types';

const AGREEMENT_SWEEP_BATCH = 200;

/** `start` advanced by `months` calendar months. */
function addMonths(start: Date, months: number): Date {
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/**
 * Credit system Phase 7, Task 7.4 (§28.2.11) — Enterprise's recurring
 * allotment as its OWN mechanism, since Enterprise is blocked from the
 * self-serve Stripe path (Task 7.2/7.3) it would otherwise ride. The admin
 * CRUD half (creating/editing an agreement) is `PlatformAdminGuard`-gated
 * and deferred to Phase 10, Task 10.1 — this sweep has no dependency on
 * that and can ship independently; it simply finds nothing to do until at
 * least one `EnterpriseCreditAgreement` row exists (created directly via
 * Prisma/seed until Phase 10's controller lands).
 */
@Injectable()
export class EnterpriseCreditAgreementService {
  private readonly logger = new Logger(EnterpriseCreditAgreementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
  ) {}

  async grantDuePeriods(asOf: Date = new Date()): Promise<{ granted: number }> {
    const candidates = await this.prisma.enterpriseCreditAgreement.findMany({
      where: {
        active: true,
        startsAt: { lte: asOf },
        OR: [{ endsAt: null }, { endsAt: { gt: asOf } }],
      },
      take: AGREEMENT_SWEEP_BATCH,
    });

    let granted = 0;
    for (const agreement of candidates) {
      const periodStart = agreement.lastGrantedPeriodStart ?? agreement.startsAt;
      const due = agreement.lastGrantedPeriodStart == null
        ? true
        : addMonths(periodStart, agreement.periodMonths) <= asOf;
      if (!due) continue;

      const thisPeriodStart = agreement.lastGrantedPeriodStart == null
        ? agreement.startsAt
        : addMonths(periodStart, agreement.periodMonths);

      try {
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.enterpriseCreditAgreement.updateMany({
            where: { companyId: agreement.companyId, lastGrantedPeriodStart: agreement.lastGrantedPeriodStart },
            data: { lastGrantedPeriodStart: thisPeriodStart },
          });
          if (claimed.count === 0) return; // a concurrent tick already claimed this row

          const amount = decimalToNumber(agreement.includedCreditsPerPeriod);
          const entry = await this.ledger.append(
            {
              companyId: agreement.companyId,
              transactionType: 'CREDIT',
              grantKind: 'ENTERPRISE_ALLOTMENT',
              amount,
              reason: `Enterprise credit agreement allotment (${agreement.dealReference})`,
              source: 'SYSTEM',
              idempotencyKey: `ent-alloc:${agreement.companyId}:${thisPeriodStart.toISOString()}`,
            },
            tx,
          );
          await tx.creditLot.create({
            data: {
              companyId: agreement.companyId,
              originLedgerEntryId: entry.id,
              grantKind: 'ENTERPRISE_ALLOTMENT',
              grantedAmount: amount,
              remaining: amount,
              expiresAt: addMonths(thisPeriodStart, agreement.periodMonths),
            },
          });
        });
        granted += 1;
      } catch (err) {
        this.logger.error(
          `enterprise-credit-agreement grant failed for company ${agreement.companyId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { granted };
  }
}
