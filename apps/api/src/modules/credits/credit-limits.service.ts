import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DEFAULT_CREDITS_PER_USD } from './credit-rates.defaults';
import { decimalToNumber } from './credits.types';

/** One calendar month out. */
function addOneMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/** Start of the current UTC calendar month — the counter's period boundary. */
function startOfCurrentMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export class EmployeeBudgetExceededError extends Error {
  constructor(public readonly employeeId: string) {
    // §35.5 — VERBATIM-identical to agent-runtime.service.ts's existing
    // dollar-based phrasing. Deliberately not "new copy": a customer who has
    // already learned this exact sentence from the old check should not see
    // a different one just because enforcement is now credit-denominated.
    super(
      `has reached its monthly budget limit — raise the limit or wait for next month to send more messages.`,
    );
    this.name = 'EmployeeBudgetExceededError';
  }
}

export class WorkflowLimitExceededError extends Error {
  constructor(
    public readonly workflowRunId: string,
    public readonly required: number,
  ) {
    super(`This workflow run has reached its configured credit limit.`);
    this.name = 'WorkflowLimitExceededError';
  }
}

/**
 * Kill-critic audit gap fix (2026-08-20, Gap F) — `AiEmployee.maxCreditsPerExecution`
 * has existed in the schema and the Employee Settings UI since Task 9.8, with
 * an explicit "not yet enforced by any runtime check" comment. A customer
 * setting this field got a value that silently did nothing — a phantom
 * control, the exact "silent-success" defect class this codebase's own
 * convention treats as a real bug, not a cosmetic gap.
 */
export class EmployeeExecutionCeilingExceededError extends Error {
  constructor(
    public readonly employeeId: string,
    public readonly cost: number,
    public readonly ceiling: number,
  ) {
    super(
      `would cost ${cost} credits, over its configured per-execution ceiling of ${ceiling} — lower the request's scope or raise the employee's "Max credits / execution" setting.`,
    );
    this.name = 'EmployeeExecutionCeilingExceededError';
  }
}

/** Same gap, for `AiEmployee.maxCreditsPerTask` (one tool call, not a whole turn/run). */
export class EmployeeTaskCeilingExceededError extends Error {
  constructor(
    public readonly employeeId: string,
    public readonly cost: number,
    public readonly ceiling: number,
  ) {
    super(
      `This task would cost ${cost} credits, over this employee's configured per-task ceiling of ${ceiling}.`,
    );
    this.name = 'EmployeeTaskCeilingExceededError';
  }
}

/**
 * Credit system Phase 8 (Enforcement), Tasks 8.1/8.2 (§40.11's Q13 fix) —
 * Layers 2 and 3 of the three-layer hierarchy, using the SAME atomic
 * guarded-`updateMany` mechanism as Layer 1 (`CreditLedgerService`'s
 * `balanceGuard`), never the existing `assertUnderBudget`-shaped
 * SUM-then-compare race `AiEmployee.budgetLimit` has today.
 */
@Injectable()
export class CreditLimitsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Layer 2 — per-employee monthly budget, credit-denominated. `null`
   * `budgetLimit` (today's default) is unlimited — never blocked. The
   * dollar-denominated `AiEmployee.budgetLimit` is converted to a credit
   * ceiling ONCE, at first touch of a calendar-month period
   * (`budgetLimitSnapshot`), so a later limit change never retroactively
   * reinterprets an already-open period's enforcement history.
   */
  async checkAndReserveEmployeeBudget(input: {
    employeeId: string;
    companyId: string;
    cost: number;
    /**
     * Kill-critic audit gap fix (2026-08-20, round 2) — `maxCreditsPerExecution`/
     * `maxCreditsPerTask` existed since Task 9.8 with an explicit "not yet
     * enforced" comment, and the ceiling error classes below had no caller.
     * Every call site now states which ceiling applies to ITS granularity —
     * a whole AI turn/run vs. one tool call.
     */
    costKind: 'EXECUTION' | 'TASK';
  }): Promise<void> {
    const employee = await this.prisma.aiEmployee.findUniqueOrThrow({
      where: { id: input.employeeId },
      select: {
        budgetLimit: true,
        maxCreditsPerExecution: true,
        maxCreditsPerTask: true,
      },
    });

    const ceiling =
      input.costKind === 'EXECUTION'
        ? employee.maxCreditsPerExecution
        : employee.maxCreditsPerTask;
    if (ceiling != null && input.cost > ceiling) {
      if (input.costKind === 'EXECUTION') {
        throw new EmployeeExecutionCeilingExceededError(input.employeeId, input.cost, ceiling);
      }
      throw new EmployeeTaskCeilingExceededError(input.employeeId, input.cost, ceiling);
    }

    if (employee.budgetLimit == null) {
      return; // unlimited
    }
    const periodStart = startOfCurrentMonthUtc();
    const periodEnd = addOneMonth(periodStart);
    const snapshot = employee.budgetLimit * DEFAULT_CREDITS_PER_USD;

    let counter = await this.prisma.employeeCreditPeriodCounter.findUnique({
      where: { employeeId_periodStart: { employeeId: input.employeeId, periodStart } },
    });
    if (!counter) {
      try {
        counter = await this.prisma.employeeCreditPeriodCounter.create({
          data: {
            companyId: input.companyId,
            employeeId: input.employeeId,
            periodStart,
            periodEnd,
            spent: 0,
            budgetLimitSnapshot: snapshot,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Lost a create race — the winner's snapshot is authoritative.
          counter = await this.prisma.employeeCreditPeriodCounter.findUniqueOrThrow({
            where: { employeeId_periodStart: { employeeId: input.employeeId, periodStart } },
          });
        } else {
          throw err;
        }
      }
    }

    const limit = counter.budgetLimitSnapshot ?? snapshot;
    const guarded = await this.prisma.employeeCreditPeriodCounter.updateMany({
      where: {
        employeeId: input.employeeId,
        periodStart,
        spent: { lte: limit - input.cost },
      },
      data: { spent: { increment: input.cost } },
    });
    if (guarded.count === 0) {
      throw new EmployeeBudgetExceededError(input.employeeId);
    }
  }

  /**
   * Layer 3 — per-run credit cap, workflow contexts only. `creditLimit=null`
   * (§20 Option A default) is unlimited — never blocked. Checked LIVE,
   * per-node, so a `LOOP` driving many rapid iterations is hard-stopped
   * exactly at the cap, never over.
   */
  async checkAndReserveWorkflowLimit(input: {
    workflowRunId: string;
    companyId: string;
    cost: number;
  }): Promise<void> {
    const run = await this.prisma.workflowRun.findUniqueOrThrow({
      where: { id: input.workflowRunId },
      select: { creditLimit: true },
    });
    if (run.creditLimit == null) {
      return; // unlimited
    }
    const limit = decimalToNumber(run.creditLimit);
    const guarded = await this.prisma.workflowRun.updateMany({
      where: {
        id: input.workflowRunId,
        companyId: input.companyId,
        totalCreditsCharged: { lte: limit - input.cost },
      },
      data: { totalCreditsCharged: { increment: input.cost } },
    });
    if (guarded.count === 0) {
      throw new WorkflowLimitExceededError(input.workflowRunId, input.cost);
    }
  }
}
