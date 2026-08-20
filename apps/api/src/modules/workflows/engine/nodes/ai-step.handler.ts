import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  LLM_PROVIDER_TOKEN,
  type LlmProvider,
} from '../../../employees/llm/llm.provider';
import {
  UsageService,
  startOfCurrentMonthUtc,
} from '../../../usage/usage.service';
import { companyEnforcementActive, creditLedgerEnabled } from '../../../../common/config/credit-config';
import { CreditCostCalculatorService } from '../../../credits/credit-cost-calculator.service';
import { InsufficientCreditsError } from '../../../credits/credit-ledger.service';
import {
  CreditLimitsService,
  EmployeeBudgetExceededError,
  WorkflowLimitExceededError,
} from '../../../credits/credit-limits.service';
import { CreditReservationService } from '../../../credits/credit-reservation.service';
import { CompanyConcurrencyGuardService } from '../../../credits/company-concurrency-guard.service';
import { resolveTemplate } from '../template';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

/**
 * Pessimistic upper bound for a single AI_STEP completion's RESERVATION
 * (§28.2.5) — mirrors both real `LlmProvider`s' own `DEFAULT_MAX_TOKENS`
 * (4096). AI_STEP makes exactly ONE completion (no ACT loop), unlike chat's
 * `CHAT_TURN_*` ceilings.
 */
const AI_STEP_PROMPT_TOKEN_CEILING_ESTIMATE = 4_000;
const AI_STEP_COMPLETION_TOKEN_CEILING = 4_096;

/**
 * AI_STEP: LLM completion of a templated prompt → context[outputKey].
 *
 * Ported verbatim from WorkflowEngine.execAiStep (P1-03), including the monthly
 * budget check — an AI_STEP scoped to an employee must respect that employee's
 * `budgetLimit` exactly as the chat runtime does, or a workflow becomes a way
 * to spend past a limit the customer set.
 */
@Injectable()
export class AiStepNodeHandler implements NodeHandler {
  readonly type = 'AI_STEP' as const;
  private readonly logger = new Logger(AiStepNodeHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
    private readonly usage: UsageService,
    private readonly costCalculator: CreditCostCalculatorService,
    private readonly reservations: CreditReservationService,
    private readonly creditLimits: CreditLimitsService,
    private readonly concurrencyGuard: CompanyConcurrencyGuardService,
  ) {}

  async execute(ctx: NodeExecContext): Promise<NodeResult> {
    // Gap fix (Task 10.5) — same per-company in-flight cap as chat
    // (agent-runtime.service.ts), wired here too since AI_STEP is a second
    // independent entry point that was never covered.
    if (!(await this.concurrencyGuard.tryAcquire(ctx.companyId))) {
      throw new Error(
        'Too many requests are already in flight for this company — please wait for one to finish and try again.',
      );
    }
    try {
      return await this.executeWithinConcurrencyLimit(ctx);
    } finally {
      await this.concurrencyGuard.release(ctx.companyId);
    }
  }

  private async executeWithinConcurrencyLimit({
    companyId,
    runId,
    stepRunId,
    node,
    context,
    signal,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const prompt = resolveTemplate(cfg.prompt, context);
    const employeeId =
      typeof cfg.employeeId === 'string' ? cfg.employeeId.trim() : '';

    let persona = '';
    let name = 'the workflow assistant';
    if (employeeId) {
      const employee = await this.prisma.aiEmployee.findFirst({
        where: { id: employeeId, companyId },
      });
      if (employee) {
        persona = employee.persona ?? '';
        name = employee.name;
        // Same monthly budget enforcement as chat (agent-runtime.service.ts).
        if (employee.budgetLimit != null) {
          const spent = await this.usage.totalCostForEmployee(
            companyId,
            employeeId,
            startOfCurrentMonthUtc(),
          );
          if (spent >= employee.budgetLimit) {
            throw new Error(
              `${employee.name} has reached its monthly budget limit`,
            );
          }
        }
      }
    }

    const systemLines = [
      `You are ${name}, executing a step in an automated workflow.`,
    ];
    if (persona) {
      systemLines.push(`Persona and guidelines: ${persona}`);
    }
    systemLines.push(
      'Follow the instruction below and respond with a concise, useful result.',
    );

    // Credit system Phase 3, Task 3.4 — shadow-mode reservation for this
    // node's one completion, keyed off `stepRunId` (§40.8: the durable engine
    // opens a NEW WorkflowStepRun per LOOP iteration while reusing the same
    // static nodeId, so keying on nodeId would collide iteration 2 with
    // iteration 1's already-settled reservation). `stepRunId` is optional on
    // NodeExecContext only for hand-built unit-test contexts — both real
    // engines always supply it.
    let reservationId: string | null = null;
    let reservationRateId: string | null = null;
    if (creditLedgerEnabled() && stepRunId) {
      const companyRow = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { creditEnforcementEnabledAt: true },
      });
      const enforcementActive = companyRow ? companyEnforcementActive(companyRow) : false;

      try {
        const priced = await this.costCalculator.priceLlmCall({
          provider: this.llm.name,
          model: process.env.LLM_MODEL ?? 'default',
          promptTokens: AI_STEP_PROMPT_TOKEN_CEILING_ESTIMATE,
          completionTokens: AI_STEP_COMPLETION_TOKEN_CEILING,
        });
        reservationRateId = priced.modelCostRateId;

        // Phase 8, Task 8.3 — Layers 2 (employee, only when scoped to one)
        // and 3 (this run's own configured cap), in that order, BEFORE any
        // reservation is attempted. Both propagate as plain typed Errors —
        // RetryPolicyService classifies them by `instanceof`, never by
        // message text (Layer 2's text is deliberately identical to the
        // pre-existing dollar-based check's).
        if (enforcementActive) {
          if (employeeId) {
            await this.creditLimits.checkAndReserveEmployeeBudget({
              employeeId,
              companyId,
              cost: priced.credits,
              costKind: 'EXECUTION',
            });
          }
          await this.creditLimits.checkAndReserveWorkflowLimit({
            workflowRunId: runId,
            companyId,
            cost: priced.credits,
          });
        }

        const { reservation } = await this.reservations.reserve({
          companyId,
          employeeId: employeeId || null,
          workflowRunId: runId,
          workflowStepRunId: stepRunId,
          resourceType: 'LLM_CALL',
          estimatedCredits: priced.credits,
          modelCostRateId: priced.modelCostRateId,
          reason: `AI_STEP node "${node.id}"`,
        });
        reservationId = reservation.id;
      } catch (err) {
        // Phase 8 — a real enforcement rejection propagates as-is (it is the
        // whole point of this phase); only an actual credit-SERVICE hiccup
        // is swallowed (shadow mode's existing "never break a real workflow
        // step" contract).
        if (
          err instanceof EmployeeBudgetExceededError ||
          err instanceof WorkflowLimitExceededError
        ) {
          throw err;
        }
        if (enforcementActive && err instanceof InsufficientCreditsError) {
          // Same company-balance message as the chat path (§45: the three
          // layers must not look identical to each other, but Layer 1 itself
          // must read the same regardless of which surface hit it) — not
          // InsufficientCreditsError's own "needs N more" wording, which is
          // an internal ledger detail, not a customer-facing message.
          //
          // Mutates `.message` on the SAME instance rather than wrapping it
          // in a new Error: this is a workflow node, so the thrown error
          // reaches RetryPolicyService.classify (unlike chat's
          // ConflictException wrap, which never goes through the workflow
          // retry path) — a new Error would lose the `instanceof
          // InsufficientCreditsError` check there and let a non-retryable
          // Layer 1 failure fall through to the generic, retryable
          // NODE_ERROR class.
          err.message =
            'This company has run out of credits. An owner or admin needs to add more credits before this can continue.';
          throw err;
        }
        this.logger.warn(
          `credit reservation failed (shadow mode, ignored): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Reuse the shared LlmProvider singleton (no tools → plain completion).
    // `signal` is the node's timeout: when the step's budget expires the model
    // request is cancelled, rather than left running to spend tokens on an
    // answer this step has already stopped waiting for.
    let result;
    try {
      result = await this.llm.complete({
        system: systemLines.join('\n'),
        messages: [{ role: 'user', content: prompt || 'Proceed.' }],
        temperature: 0.2,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (reservationId) {
        await this.releaseReservation(reservationId, companyId);
      }
      throw err;
    }
    if (result.usage) {
      await this.usage.record({
        companyId,
        employeeId: employeeId || null,
        source: 'workflow_ai_step',
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        workflowRunId: runId,
        workflowStepRunId: stepRunId,
      });
    }
    if (reservationId) {
      await this.settleReservation(
        reservationId,
        companyId,
        result.usage?.promptTokens ?? 0,
        result.usage?.completionTokens ?? 0,
        reservationRateId,
      );
    }
    const text = (result.content ?? '').trim();
    return { output: { prompt, text }, contextValue: text };
  }

  /** Settle from real usage — shadow mode: never throws. */
  private async settleReservation(
    reservationId: string,
    companyId: string,
    promptTokens: number,
    completionTokens: number,
    fallbackRateId: string | null,
  ): Promise<void> {
    try {
      const actual = await this.costCalculator.priceLlmCall({
        provider: this.llm.name,
        model: process.env.LLM_MODEL ?? 'default',
        promptTokens,
        completionTokens,
      });
      await this.reservations.settle({
        reservationId,
        companyId,
        actualCredits: actual.credits,
        modelCostRateId: actual.modelCostRateId ?? fallbackRateId,
      });
    } catch (err) {
      this.logger.warn(
        `credit settle failed (shadow mode, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Release on a pre-response failure — shadow mode: never throws. */
  private async releaseReservation(
    reservationId: string,
    companyId: string,
  ): Promise<void> {
    try {
      await this.reservations.release({
        reservationId,
        companyId,
        reason: 'AI_STEP failed before producing a response',
      });
    } catch (err) {
      this.logger.warn(
        `credit release failed (shadow mode, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
