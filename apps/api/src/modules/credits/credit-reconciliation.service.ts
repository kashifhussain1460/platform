import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { METRIC, MetricsRegistry } from '../../common/observability/metrics.registry';
import { decimalToNumber } from './credits.types';

/**
 * // FOUNDER-PENDING: §25.3 Option B — tolerance = greater of a flat-dollar
 * floor or a percentage of the invoice, RECOMMENDED over zero-tolerance
 * (Option A, too noisy at scale) or a statistical trailing-window model
 * (Option C, needs 30 days of history this pre-launch platform doesn't have).
 */
const COST_LEG_TOLERANCE_FLAT_USD = 5;
const COST_LEG_TOLERANCE_PCT = 0.02;

interface DiscrepancyDraft {
  leg: 'REVENUE' | 'COST' | 'INTERNAL_CONSISTENCY';
  severity: 'HIGH' | 'LOW';
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Credit system Phase 10, Task 10.3 (§25.3) — the daily three-leg
 * reconciliation job. Platform-wide, not tenant-scoped (this compares
 * aggregates ACROSS every company against Stripe/provider totals).
 *
 * Only the internal-consistency leg is fully automated. The revenue leg
 * (Stripe Reporting/Balance-Transactions API) is NOT implemented — no such
 * integration exists in this codebase (`StripeBillingProvider` only reacts
 * to webhooks, it never queries Stripe for a period total), and building one
 * is out of scope for this task per the plan's own Ground Truth finding. The
 * cost leg runs only for a day on which a manually-recorded `ProviderInvoice`
 * period closes — there is no automated OpenAI/Anthropic invoice ingestion.
 */
@Injectable()
export class CreditReconciliationService {
  private readonly logger = new Logger(CreditReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsRegistry,
  ) {}

  async runDaily(dateUtc: Date): Promise<{ runId: string; discrepancyCount: number }> {
    const dayStart = new Date(
      Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate()),
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const run = await this.prisma.reconciliationRun.create({ data: { dateUtc: dayStart } });
    const discrepancies: DiscrepancyDraft[] = [];

    try {
      discrepancies.push(...(await this.internalConsistencyLeg(dayStart, dayEnd)));
      discrepancies.push(...(await this.costLeg(dayStart, dayEnd)));
      // Revenue leg deliberately absent — see class doc.

      if (discrepancies.length > 0) {
        await this.prisma.reconciliationDiscrepancy.createMany({
          data: discrepancies.map((d) => ({
            runId: run.id,
            leg: d.leg,
            severity: d.severity,
            message: d.message,
            metadata: (d.metadata ?? null) as never,
          })),
        });
        for (const d of discrepancies) {
          this.metrics.counter(
            METRIC.creditReconciliationDiscrepancyTotal,
            'Credit reconciliation discrepancies found',
            { leg: d.leg, severity: d.severity },
          );
        }
      }

      await this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', finishedAt: new Date() },
      });
    } catch (err) {
      await this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', finishedAt: new Date() },
      });
      this.logger.error(
        `reconciliation run ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    return { runId: run.id, discrepancyCount: discrepancies.length };
  }

  /**
   * §25.3 leg 3 — fully automated. Every real spend in this codebase goes
   * through reserve→settle, so a DEBIT row's `reservationId` IS its trace to
   * a specific reservation (which in turn traces to a `WorkflowStepRun`/
   * conversation/tool call). A DEBIT with no `reservationId` was never
   * created by any real spend path — a structural anomaly, not a rounding
   * gap, so there is no tolerance here: any count > 0 is a discrepancy.
   */
  private async internalConsistencyLeg(
    dayStart: Date,
    dayEnd: Date,
  ): Promise<DiscrepancyDraft[]> {
    const orphanedDebits = await this.prisma.creditLedger.findMany({
      where: {
        transactionType: 'DEBIT',
        reservationId: null,
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      select: { id: true, companyId: true, amount: true },
    });
    return orphanedDebits.map((row) => ({
      leg: 'INTERNAL_CONSISTENCY',
      severity: 'HIGH',
      message: `Ledger entry ${row.id} (company ${row.companyId}) is a DEBIT with no reservationId — untraceable to any reserve→settle spend path`,
      metadata: { ledgerEntryId: row.id, companyId: row.companyId, amount: decimalToNumber(row.amount) },
    }));
  }

  /**
   * §25.3 leg 2 — runs ONLY for a day on which a manually-recorded
   * `ProviderInvoice` period closes. Silent (no discrepancy row) when no
   * invoice closes today — that is "not yet reconciled", not a gap.
   */
  private async costLeg(dayStart: Date, dayEnd: Date): Promise<DiscrepancyDraft[]> {
    const closingInvoices = await this.prisma.providerInvoice.findMany({
      where: { periodEnd: { gte: dayStart, lt: dayEnd } },
    });
    if (closingInvoices.length === 0) return [];

    const out: DiscrepancyDraft[] = [];
    for (const invoice of closingInvoices) {
      const { _sum } = await this.prisma.usageEvent.aggregate({
        where: { createdAt: { gte: invoice.periodStart, lt: invoice.periodEnd } },
        _sum: { estimatedCostUsd: true },
      });
      const estimated = _sum.estimatedCostUsd ?? 0;
      const actual = decimalToNumber(invoice.amountUsd);
      const tolerance = Math.max(COST_LEG_TOLERANCE_FLAT_USD, actual * COST_LEG_TOLERANCE_PCT);
      const delta = Math.abs(estimated - actual);
      if (delta > tolerance) {
        out.push({
          leg: 'COST',
          severity: 'HIGH',
          message: `${invoice.provider} invoice for ${invoice.periodStart.toISOString().slice(0, 10)}–${invoice.periodEnd.toISOString().slice(0, 10)}: ledger-estimated $${estimated.toFixed(2)} vs invoiced $${actual.toFixed(2)} (delta $${delta.toFixed(2)}, tolerance $${tolerance.toFixed(2)})`,
          metadata: { providerInvoiceId: invoice.id, estimated, actual, delta, tolerance },
        });
      }
    }
    return out;
  }

  /**
   * Credit system Phase 12, Task 12.3 (§36.3) — the canary promotion gate.
   *
   * There is no separate "shadow decision log" once a company's real
   * enforcement is on (Layer 1/2/3 either throw or don't — there is nothing
   * left running in parallel to diff against). The comparisons this method
   * performs are the ones that ARE verifiable given that:
   *
   * - Layer 1 (INSUFFICIENT_CREDITS): reconstruct the company's real ledger
   *   balance at the moment of the block and confirm it really was at or
   *   below zero.
   * - Layer 3 (WORKFLOW_LIMIT_EXCEEDED): `checkAndReserveWorkflowLimit`
   *   returns immediately (never throws) when `WorkflowRun.creditLimit` is
   *   null (credit-limits.service.ts) — so a run recorded as blocked for
   *   this reason with a null `creditLimit` is impossible under the real
   *   code path and is itself a discrepancy.
   *
   * Layer 2 (EMPLOYEE_BUDGET_EXCEEDED) is NOT checked here: unlike the
   * ledger (append-only, so "the balance at time T" is always
   * reconstructable) and `WorkflowRun` (both the charged total and the
   * limit live on the same row), `EmployeeCreditPeriodCounter` is a single
   * mutable row with no history — there is no way to recover "what `spent`
   * was at the moment of a specific historical block" from it. Verifying
   * Layer 2 this way would need its own append-only trail, which does not
   * exist; flagged here rather than silently pretending full coverage.
   */
  async canaryComparisonReport(
    companyId: string,
    since: Date,
  ): Promise<{
    companyId: string;
    windowSince: string;
    blockedRunsChecked: number;
    discrepancies: { runId: string; reason: string }[];
  }> {
    const blockedRuns = await this.prisma.workflowRun.findMany({
      where: {
        companyId,
        failureClass: { in: ['INSUFFICIENT_CREDITS', 'WORKFLOW_LIMIT_EXCEEDED'] },
        createdAt: { gte: since },
      },
      select: {
        id: true,
        createdAt: true,
        finishedAt: true,
        failureClass: true,
        creditLimit: true,
      },
    });

    const discrepancies: { runId: string; reason: string }[] = [];
    for (const run of blockedRuns) {
      if (run.failureClass === 'INSUFFICIENT_CREDITS') {
        const asOf = run.finishedAt ?? run.createdAt;
        const priorEntry = await this.prisma.creditLedger.findFirst({
          where: { companyId, createdAt: { lte: asOf } },
          orderBy: { createdAt: 'desc' },
          select: { balanceAfter: true },
        });
        const balanceAtBlock = priorEntry ? decimalToNumber(priorEntry.balanceAfter) : 0;
        if (balanceAtBlock > 0) {
          discrepancies.push({
            runId: run.id,
            reason: `blocked as INSUFFICIENT_CREDITS but the ledger balance at block time was ${balanceAtBlock} (>0) — a real enforcement decision that disagrees with what the balance actually was`,
          });
        }
      } else if (run.failureClass === 'WORKFLOW_LIMIT_EXCEEDED') {
        if (run.creditLimit == null) {
          discrepancies.push({
            runId: run.id,
            reason:
              'blocked as WORKFLOW_LIMIT_EXCEEDED but this run has no creditLimit set — ' +
              'checkAndReserveWorkflowLimit never throws for an unlimited run, so this block could not have come from the real code path',
          });
        }
      }
    }

    return {
      companyId,
      windowSince: since.toISOString(),
      blockedRunsChecked: blockedRuns.length,
      discrepancies,
    };
  }
}
