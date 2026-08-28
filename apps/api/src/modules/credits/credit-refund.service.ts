import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
import { decimalToNumber } from './credits.types';

export interface RefundInput {
  companyId: string;
  /** Must resolve to a settled `DEBIT` row (§40.7's decision) — never a RESERVATION/RELEASE/CREDIT. */
  originalLedgerEntryId: string;
  /** Requested amount; capped at `min(requested, remaining un-refunded balance of that debit)`. */
  amount: number;
  /** Stripe's `re_...` id, or a synthetic `admin:{key}` for a manual refund — the IDEM key. */
  externalRefundId: string;
  reason: string;
  /** `ADMIN:{userId}` | `SYSTEM` | `WEBHOOK`. */
  initiatedBy: string;
}

/**
 * Credit system Phase 6, Task 6.4 (§40.7 — the plan's own later, kill-critic-
 * corrected decision, confirmed over an earlier, superseded §18 draft that
 * described capping against the purchase's `CreditLot` instead). A refund
 * ALWAYS targets a settled `DEBIT` ledger row — never a `CREDIT`/`RESERVATION`
 * — capped at `min(requested, remaining unrefunded balance of that debit)`,
 * never pushed negative (Option A: no debt/collections mechanism exists in
 * this codebase).
 */
@Injectable()
export class CreditRefundService {
  private readonly logger = new Logger(CreditRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
  ) {}

  /**
   * The general-purpose refund primitive. Rejects (throws) rather than
   * silently clamping when the target isn't a settled DEBIT — a refund
   * against the wrong row shape is a bug or a support-tool misuse, not
   * something to paper over (kill-critic Q10's exact finding).
   */
  async refund(input: RefundInput): Promise<{ refundId: string; amount: number } | { duplicate: true; refundId: string }> {
    const target = await this.prisma.creditLedger.findUnique({
      where: { id: input.originalLedgerEntryId },
    });
    if (!target || target.companyId !== input.companyId || target.transactionType !== 'DEBIT') {
      throw new BadRequestException(
        'Refund target must be a settled DEBIT ledger row belonging to this company',
      );
    }
    const debitAmount = Math.abs(decimalToNumber(target.amount));
    const alreadyRefunded = await this.prisma.creditRefund.aggregate({
      where: { originalLedgerEntryId: input.originalLedgerEntryId, status: 'COMPLETED' },
      _sum: { amount: true },
    });
    const remaining = debitAmount - decimalToNumber(alreadyRefunded._sum.amount ?? new Prisma.Decimal(0));
    const capped = Math.max(0, Math.min(Math.abs(input.amount), remaining));

    try {
      return await this.prisma.$transaction(async (tx) => {
        const entry = await this.ledger.append(
          {
            companyId: input.companyId,
            transactionType: 'REFUND',
            amount: capped,
            reason: input.reason,
            source: input.initiatedBy.startsWith('ADMIN:') ? 'ADMIN' : 'SYSTEM',
            idempotencyKey: `refund:${input.externalRefundId}`,
            reversesLedgerEntryId: input.originalLedgerEntryId,
          },
          tx,
        );
        const row = await tx.creditRefund.create({
          data: {
            companyId: input.companyId,
            originalLedgerEntryId: input.originalLedgerEntryId,
            externalRefundId: input.externalRefundId,
            amount: capped,
            resultingLedgerEntryId: entry.id,
            reason: input.reason,
            initiatedBy: input.initiatedBy,
            status: 'COMPLETED',
          },
        });
        return { refundId: row.id, amount: capped };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.creditRefund.findUniqueOrThrow({
          where: { companyId_externalRefundId: { companyId: input.companyId, externalRefundId: input.externalRefundId } },
        });
        return { duplicate: true, refundId: existing.id };
      }
      throw err;
    }
  }

  /**
   * Task 6.4's webhook entry point. A Stripe `charge.refunded` event
   * identifies a refunded PAYMENT (a CHARGE) — it does not, and cannot,
   * identify which spend-side `DEBIT` row(s) that money should claw back
   * from; a card payment and a credit spend are different ledger legs
   * entirely. Per the confirmed decision: this is a KNOWN, STATED gap, not
   * silently "handled" — every such event is logged for manual/admin
   * follow-up (via the general `refund()` primitive above, once a human
   * has identified the correct DEBIT to target) rather than guessed at.
   */
  async refundFromStripeEvent(input: {
    companyId: string | null;
    chargeId: string;
    externalRefundId: string;
    amountCents: number;
  }): Promise<void> {
    this.logger.warn(
      `charge.refunded received (charge=${input.chargeId}, refund=${input.externalRefundId}, ` +
        `amount=${input.amountCents / 100} ${input.companyId ? `company=${input.companyId}` : '(unresolved company)'}) — ` +
        'no automatic credit refund was created: a Stripe charge refund cannot be mapped to a specific ' +
        'spend-side DEBIT row automatically. Route this to manual/admin review (POST ' +
        '/internal/platform-admin/companies/:companyId/credits/adjustments, Task 10.2) if a credit-side ' +
        'correction is actually owed.',
    );
  }
}
