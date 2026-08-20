import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type AiEmployee, type Conversation, type Message } from '@prisma/client';
import type {
  EmployeeRole,
  MessageMetadataDto,
  RunResultDto,
  ToolCallDto,
} from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CHAT_TURN_COMPLETION_TOKEN_CEILING,
  CHAT_TURN_PROMPT_TOKEN_CEILING_ESTIMATE,
  CONTEXT_CLOSE,
  CONTEXT_OPEN,
  MAX_ACT_ITERATIONS,
  RETRIEVAL_K,
  ROLE_SCOPE,
  TOOL_RESULT_MARKER,
} from '../employees.constants';
import type { ExecutorContext } from '../../skills/executors/skill-executor';
import type { LlmMessage, LlmUsage } from '../llm/llm.provider';
import { toMessageDto } from '../employees.mapper';
import { UsageService, startOfCurrentMonthUtc } from '../../usage/usage.service';
import { companyEnforcementActive, creditLedgerEnabled } from '../../../common/config/credit-config';
import { CreditCostCalculatorService } from '../../credits/credit-cost-calculator.service';
import { InsufficientCreditsError } from '../../credits/credit-ledger.service';
import {
  CreditLimitsService,
  EmployeeBudgetExceededError,
  WorkflowLimitExceededError,
  EmployeeExecutionCeilingExceededError,
  EmployeeTaskCeilingExceededError,
} from '../../credits/credit-limits.service';
import { CompanyConcurrencyGuardService } from '../../credits/company-concurrency-guard.service';
import {
  CreditReservationService,
  type CreditReservationDto,
} from '../../credits/credit-reservation.service';
import { LlmRouterService } from './llm-router.service';
import { MemoryService, type LoadedMemory } from './memory.service';
import { OUT_OF_SCOPE_MARKER, readScope } from './out-of-scope';
import { PlannerService } from './planner.service';
import { RetrievalService } from './retrieval.service';
import { SensitiveScenarioService } from './sensitive-scenario.service';
import { ToolExecutorService } from './tool-executor.service';
import { ValidationService } from './validation.service';

function clip(text: string, n: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : `${clean.slice(0, n).trimEnd()}…`;
}

/** Minimal shape of a sibling (other) employee, used to build named redirect targets. */
interface OtherEmployee {
  name: string;
  role: EmployeeRole;
  persona: string | null;
}

/**
 * The core agent loop. Orchestrates the single-purpose runtime services:
 *   guard status → persist user turn → PLAN → RETRIEVE (knowledge) → load MEMORY
 *   → ACT (bounded LLM tool-calling loop via the Skills module) → VALIDATE
 *   (grounding/confidence) → persist assistant Message (with
 *   {plan, sources, validation, toolCalls} metadata) → write a SUMMARY memory →
 *   return RunResultDto.
 */
/** Per-turn switches the workflow AI_EMPLOYEE_STEP node uses (chat passes none). */
interface RunTurnOptions {
  forceApprovalForTools?: boolean;
  disableTools?: boolean;
  forceApprovalForExternalActions?: boolean;
  /**
   * Cancels the model calls this turn makes. Supplied by the workflow
   * AI_EMPLOYEE_STEP node, whose per-node timeout would otherwise abandon a
   * hung completion rather than stop it — the request would keep running
   * against the provider's own, longer timeout and keep spending.
   */
  signal?: AbortSignal;
  /**
   * Client-supplied dedup key for the user turn (credit-system prerequisite,
   * kill-critic Q3(a)). A duplicate submission with the same key on the same
   * conversation replays the original RunResultDto instead of re-running the
   * agent loop. Omitted → unchanged behaviour (no dedup).
   */
  idempotencyKey?: string;
  /**
   * Usage-telemetry attribution (Phase 3, Task 3.1). Overrides the default
   * `source:'chat'` — the workflow AI_EMPLOYEE_STEP delegation path passes
   * `'workflow_employee_step'` plus its run/step ids, closing the confirmed
   * mislabel that made workflow-driven employee spend indistinguishable from
   * ordinary chat.
   */
  source?: string;
  workflowRunId?: string;
  workflowStepRunId?: string;
}

@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly router: LlmRouterService,
    private readonly planner: PlannerService,
    private readonly retrieval: RetrievalService,
    private readonly memory: MemoryService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly validation: ValidationService,
    private readonly sensitiveScenario: SensitiveScenarioService,
    private readonly usage: UsageService,
    private readonly costCalculator: CreditCostCalculatorService,
    private readonly reservations: CreditReservationService,
    private readonly creditLimits: CreditLimitsService,
    private readonly concurrencyGuard: CompanyConcurrencyGuardService,
  ) {}

  async run(
    employee: AiEmployee,
    conversation: Conversation,
    userText: string,
    options?: RunTurnOptions,
  ): Promise<RunResultDto> {
    // Guard: only ACTIVE employees accept new work.
    if (employee.status !== 'ACTIVE') {
      throw new ConflictException(
        `Employee is ${employee.status.toLowerCase()} and cannot accept messages`,
      );
    }

    const { companyId } = employee;

    // Gap fix (Task 10.5) — the per-company in-flight execution cap was
    // built and tested but never actually wired into any call site. Checked
    // BEFORE the user turn is persisted, so a rejected turn leaves no
    // half-started row behind. Independent of the credit-enforcement flag
    // hierarchy (§26's abuse-prevention framing: always-on, generous
    // default, invisible unless a threshold is crossed).
    if (!(await this.concurrencyGuard.tryAcquire(companyId))) {
      throw new ConflictException(
        'Too many requests are already in flight for this company — please wait for one to finish and try again.',
      );
    }
    try {
      return await this.runWithinConcurrencyLimit(employee, conversation, userText, options);
    } finally {
      await this.concurrencyGuard.release(companyId);
    }
  }

  private async runWithinConcurrencyLimit(
    employee: AiEmployee,
    conversation: Conversation,
    userText: string,
    options?: RunTurnOptions,
  ): Promise<RunResultDto> {
    const { companyId } = employee;

    // Budget enforcement (founder-market-readiness-audit.md §4/§8, tightened
    // in the §edge-case recheck): checked again before EACH completion below,
    // not just once here. A single check at the top of run() went stale for
    // the whole bounded ACT loop (up to MAX_ACT_ITERATIONS real LLM calls) --
    // a concurrent request against the same employee could push it over
    // budget mid-loop and this request would never notice. Re-checking per
    // iteration can't close the very first instant two requests both start
    // at once (the DB has no cost to see from either yet — genuinely
    // unknowable before an LLM call returns), but it stops a request from
    // compounding MORE cost once a competitor's spend has landed, which is
    // where the real exposure was.
    await this.assertUnderBudget(employee);

    // Persist the user turn first so it is part of the loaded memory/history.
    // idempotencyKey is optional (Postgres treats multiple NULLs in a unique
    // index as distinct, so an omitted key never collides). A genuine
    // duplicate submission hits the conversationId+idempotencyKey unique
    // constraint and is replayed instead of re-running the agent loop.
    let userTurn: Message;
    try {
      userTurn = await this.prisma.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          role: 'USER',
          content: userText,
          idempotencyKey: options?.idempotencyKey ?? null,
        },
      });
    } catch (error) {
      if (
        options?.idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.replayDuplicateTurn(conversation.id, options.idempotencyKey);
      }
      throw error;
    }

    // EVERYTHING below can throw — a model timeout, a provider 429, a tool
    // failure — and the user turn above is already committed by then. Without
    // this guard a failed run left the question sitting in the thread with no
    // reply; the customer asks again and the conversation shows what looks
    // like a duplicate message. Observed in the wild: two identical USER rows
    // 4s apart with a single ASSISTANT row after them.
    const toolCalls: ToolCallDto[] = [];
    try {
      return await this.completeTurn(
        employee,
        conversation,
        userText,
        toolCalls,
        userTurn.id,
        options,
      );
    } catch (err) {
      await this.settleFailedTurn(
        companyId,
        conversation.id,
        userTurn.id,
        toolCalls,
        err,
      );
      throw err;
    }
  }

  /**
   * Undo or annotate a turn whose run failed after the user message was
   * committed.
   *
   * With NO tool call executed, nothing outside this conversation happened, so
   * the partial write is simply removed — the caller's error is the whole
   * story and the thread stays clean.
   *
   * Once a tool HAS run, deleting would erase the only record of a real
   * side effect (an email that went out, a ticket that was created), so the
   * turn is kept and an assistant note records that the reply never arrived.
   */
  private async settleFailedTurn(
    companyId: string,
    conversationId: string,
    userMessageId: string,
    toolCalls: ToolCallDto[],
    err: unknown,
  ): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      if (toolCalls.length === 0) {
        await this.prisma.message.delete({ where: { id: userMessageId } });
        this.logger.warn(
          `Turn failed before any tool ran; rolled back the user message (${reason})`,
        );
        return;
      }
      const metadata: MessageMetadataDto = {
        plan: [],
        sources: [],
        validation: {
          grounded: false,
          confidence: 0,
          needsApproval: false,
          notes: 'The run failed before an answer was produced.',
        },
        toolCalls,
      };
      await this.prisma.message.create({
        data: {
          companyId,
          conversationId,
          role: 'ASSISTANT',
          content:
            'I could not finish this answer. Some actions had already been ' +
            'taken — check the tool activity below before asking again.',
          metadata: metadata as unknown as Prisma.InputJsonObject,
        },
      });
      this.logger.warn(
        `Turn failed after ${toolCalls.length} tool call(s); kept the turn and recorded the failure (${reason})`,
      );
    } catch (cleanupErr) {
      // Never let cleanup mask the original failure the caller is about to see.
      this.logger.error(
        `Failed to settle a failed turn: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
  }

  /** The turn itself: PLAN → RETRIEVE → MEMORY → ACT → VALIDATE → persist. */
  private async completeTurn(
    employee: AiEmployee,
    conversation: Conversation,
    userText: string,
    toolCalls: ToolCallDto[],
    userTurnId: string,
    options?: RunTurnOptions,
  ): Promise<RunResultDto> {
    const { companyId } = employee;

    // PLAN → RETRIEVE (knowledge) → load MEMORY.
    const plan = await this.planner.plan(
      employee.role,
      employee.name,
      userText,
      options?.signal,
    );
    const sources = await this.retrieval.retrieve(
      companyId,
      userText,
      employee.knowledgeAccess,
      RETRIEVAL_K,
      employee.role,
    );
    const memory = await this.memory.load(
      companyId,
      conversation.id,
      employee.id,
    );
    const otherEmployees = await this.prisma.aiEmployee.findMany({
      where: { companyId, status: 'ACTIVE', id: { not: employee.id } },
      select: { name: true, role: true, persona: true },
    });

    // ACT: resolve the employee's tools, then run a BOUNDED tool-calling loop.
    // Each iteration drafts with the LLM; if it returns a tool call we execute
    // it via the Skills module, append the result to the working messages, and
    // loop; when it returns text we finalize. With no tools available this is a
    // single grounded completion (unchanged from before skills existed).
    // `disableTools` (set by the workflow AI_EMPLOYEE_STEP, doc 27 §0.3 / doc 28)
    // makes the reasoning step "recommends only": it is offered NO tools, so it
    // cannot take a person-facing/irreversible action AND cannot pause the run on
    // a tool-approval it has no way to resume. Side effects belong in explicit,
    // author-gated TOOL_ACTION nodes.
    const tools = options?.disableTools
      ? []
      : await this.toolExecutor.listTools(employee);
    this.logger.debug(
      `run: employee=${employee.id} tools=${tools.length} sources=${sources.length}`,
    );

    const system = this.buildSystemPrompt(
      employee,
      plan,
      sources,
      memory,
      otherEmployees,
    );
    const ctx: ExecutorContext = {
      companyId,
      employeeId: employee.id,
      conversationId: conversation.id,
    };
    let working = this.buildMessages(memory, userText);
    let answer = '';
    let awaitingApproval = false;

    // Credit system Phase 3, Tasks 3.3/3.4 — shadow-mode reservation covering
    // the WHOLE turn (which may make several real completions across the ACT
    // loop below).
    //
    // Keying (§40.8): a workflow-triggered turn (AI_EMPLOYEE_STEP, which
    // delegates here) supplies `options.workflowStepRunId` — key off THAT,
    // never the message id, because the handler creates a brand-new
    // Conversation/Message on every retry attempt of the same
    // `WorkflowStepRun`; keying off the message would double-reserve on
    // every retry instead of resuming the one reservation already open for
    // that step. An ordinary chat turn has no `WorkflowStepRun` at all, so it
    // keys off the just-persisted USER message's own id instead — never the
    // caller's optional `options.idempotencyKey`, since a genuine client
    // retry of THAT key already short-circuited via `replayDuplicateTurn`
    // before reaching here, so every call that gets this far is a truly new
    // turn and `userTurnId` is always present and unique. With the flag off
    // this whole block is skipped; nothing about the turn changes.
    let reservation: CreditReservationDto | null = null;
    let reservationRateId: string | null = null;
    let estimatedCredits: number | null = null;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    if (creditLedgerEnabled()) {
      // Phase 8 (Enforcement), Task 8.3 — resolved once per turn. With
      // enforcement inactive for this company (the global flag off, or this
      // company not on the allowlist), every check below is skipped entirely
      // and this stays byte-identical to the Phase 3 shadow path.
      const companyRow = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { creditEnforcementEnabledAt: true },
      });
      const enforcementActive = companyRow ? companyEnforcementActive(companyRow) : false;

      try {
        const priced = await this.costCalculator.priceLlmCall({
          provider: this.router.providerName,
          model: process.env.LLM_MODEL ?? 'default',
          promptTokens: CHAT_TURN_PROMPT_TOKEN_CEILING_ESTIMATE,
          completionTokens: CHAT_TURN_COMPLETION_TOKEN_CEILING,
        });
        reservationRateId = priced.modelCostRateId;
        estimatedCredits = priced.credits;

        // Layer 2 — per-employee monthly credit budget. Checked BEFORE any
        // reservation is attempted (§45's mandated check order): a company
        // with plenty of balance must still not let one employee blow past
        // its own cap. Verbatim-reuses agent-runtime's own pre-existing
        // dollar-based phrasing (§35.5) — only the failureClass
        // distinguishes it now.
        if (enforcementActive) {
          try {
            await this.creditLimits.checkAndReserveEmployeeBudget({
              employeeId: employee.id,
              companyId,
              cost: priced.credits,
              costKind: 'EXECUTION',
            });
          } catch (err) {
            if (
              err instanceof EmployeeBudgetExceededError ||
              err instanceof EmployeeExecutionCeilingExceededError ||
              err instanceof EmployeeTaskCeilingExceededError
            ) {
              throw new ConflictException(`${employee.name} ${err.message}`);
            }
            throw err;
          }

          // Layer 3 — this run's own configured credit cap. This turn is
          // reachable from a workflow context too (AI_EMPLOYEE_STEP
          // delegates its whole turn to this method with a real
          // `workflowRunId`), so Layer 3 must be checked here as well, not
          // only in ai-step.handler.ts/skills.service.ts — a workflow that
          // set a `creditLimit` must not be able to blow past it just by
          // using AI_EMPLOYEE_STEP nodes instead of AI_STEP/TOOL_ACTION ones.
          // No-op for an ordinary chat turn, which has no `workflowRunId`.
          if (options?.workflowRunId) {
            try {
              await this.creditLimits.checkAndReserveWorkflowLimit({
                workflowRunId: options.workflowRunId,
                companyId,
                cost: priced.credits,
              });
            } catch (err) {
              if (err instanceof WorkflowLimitExceededError) {
                throw new ConflictException(err.message);
              }
              throw err;
            }
          }
        }

        const { reservation: res } = await this.reservations.reserve({
          companyId,
          employeeId: employee.id,
          workflowRunId: options?.workflowRunId ?? null,
          workflowStepRunId: options?.workflowStepRunId ?? null,
          conversationId: conversation.id,
          messageIdempotencyKey: options?.workflowStepRunId ? null : userTurnId,
          resourceType: 'LLM_CALL',
          estimatedCredits: priced.credits,
          modelCostRateId: priced.modelCostRateId,
          reason: `Chat turn for ${employee.name}`,
        });
        reservation = res;
      } catch (err) {
        // Phase 8 — Layer 1: with enforcement active, a genuine insufficient-
        // balance rejection is NOT swallowed; it is the whole point of this
        // phase. Distinct copy from Layer 2's (§45's "must not look
        // identical" requirement).
        if (enforcementActive && err instanceof InsufficientCreditsError) {
          throw new ConflictException(
            'This company has run out of credits. An owner or admin needs to add more credits before this can continue.',
          );
        }
        // A ConflictException already means a HIGHER layer (Layer 2, above)
        // deliberately rejected this turn — propagate it as-is, never treat
        // it as a "hiccup" to swallow.
        if (err instanceof ConflictException) {
          throw err;
        }
        // Shadow mode (or any other credit-service hiccup): never break a
        // real chat turn (mirrors UsageService.record's own "never throws"
        // contract).
        this.logger.warn(
          `credit reservation failed (shadow mode, ignored): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    try {
      for (let i = 0; i < MAX_ACT_ITERATIONS; i += 1) {
        if (i > 0) {
          // Re-check before every iteration after the first (the first was
          // already checked above): a concurrent request against the same
          // employee may have pushed it over budget since this loop started.
          await this.assertUnderBudget(employee);
        }
        const draft = await this.router
          .forTask('act')
          .complete(
            {
              system,
              messages: working,
              temperature: 0.2,
              ...(options?.signal ? { signal: options.signal } : {}),
            },
            tools,
          );
        await this.recordUsage(companyId, employee.id, draft.usage, options);
        if (draft.usage) {
          totalPromptTokens += draft.usage.promptTokens;
          totalCompletionTokens += draft.usage.completionTokens;
        }

        if (draft.toolCall && tools.length > 0) {
          const call = await this.toolExecutor.call(
            ctx,
            employee,
            draft.toolCall.skillKey,
            draft.toolCall.tool,
            draft.toolCall.args,
            options?.forceApprovalForTools ?? false,
            options?.forceApprovalForExternalActions ?? false,
          );
          toolCalls.push(call);
          if (call.pendingApproval) {
            // High-risk action paused for human review — do NOT retry the tool.
            // Feed the pending status back so the LLM finalizes gracefully and
            // stop the act loop (the action executes later on approval).
            awaitingApproval = true;
          }
          // Feed the tool result back so the next iteration can use it.
          working = [
            ...working,
            {
              role: 'assistant',
              content: `${TOOL_RESULT_MARKER} ${JSON.stringify({
                skillKey: call.skillKey,
                tool: call.tool,
                ok: call.ok,
                pendingApproval: call.pendingApproval ?? false,
                result: call.result,
              })}`,
            },
          ];
          continue;
        }

        answer = (draft.content ?? '').trim();
        break;
      }

      // Safety net: loop exhausted while still requesting tools — force a final
      // answer with NO tools so a turn always produces a response.
      if (!answer) {
        await this.assertUnderBudget(employee);
        const draft = await this.router
          .forTask('act')
          .complete({
            system,
            messages: working,
            temperature: 0.2,
            ...(options?.signal ? { signal: options.signal } : {}),
          });
        await this.recordUsage(companyId, employee.id, draft.usage, options);
        if (draft.usage) {
          totalPromptTokens += draft.usage.promptTokens;
          totalCompletionTokens += draft.usage.completionTokens;
        }
        answer = (draft.content ?? '').trim();
      }

      // Did the employee DECLINE this as someone else's job? Strip the marker
      // before anything is stored or shown — the customer should read a plain
      // apology, not a protocol token — but keep the verdict, because a workflow
      // step must fail rather than record a refusal as finished work.
      const scope = readScope(answer);
      answer = scope.answer;

      // A high-risk action was routed to the Approval Center — make it explicit in
      // the assistant turn so the user knows nothing was performed yet.
      if (awaitingApproval) {
        const note =
          'A high-risk action is awaiting human approval before it will be performed.';
        answer = answer ? `${answer}\n\n${note}` : note;
      }

      // VALIDATE grounding + confidence, then S-06: if the CUSTOMER's incoming
      // message tripped a sensitive-scenario detector (refund demand, legal
      // threat, account deletion, identity verification, disclosed PII,
      // security incident, high-risk sentiment, or an explicit human request),
      // force needsApproval regardless of how confident/grounded the draft
      // answer itself is — a maximally confident reply to "I want a refund and
      // I'll sue you" is still not safe to send unreviewed. Feeds the SAME
      // signal S-01 already threads through the workflow approval gate
      // (tool-approval-policy.ts), so this does not introduce a second policy
      // mechanism.
      const sensitiveScenario = this.sensitiveScenario.detect(userText);
      const baseValidation = this.validation.validate(employee.role, answer, sources);
      const validation = sensitiveScenario
        ? {
            ...baseValidation,
            needsApproval: true,
            sensitiveScenario,
            notes: baseValidation.notes
              ? `${baseValidation.notes} Sensitive scenario detected (${sensitiveScenario.category}) — human approval required.`
              : `Sensitive scenario detected (${sensitiveScenario.category}) — human approval required.`,
          }
        : baseValidation;

      // Persist the assistant turn with structured runtime metadata.
      const metadata: MessageMetadataDto = {
        plan,
        sources,
        validation,
        toolCalls,
      };
      const assistant = await this.prisma.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          role: 'ASSISTANT',
          content: answer,
          metadata: metadata as unknown as Prisma.InputJsonObject,
        },
      });

      // Write a rolling SUMMARY memory (recalled later by recency).
      await this.memory.appendSummary(
        companyId,
        employee.id,
        `User asked: "${clip(userText, 160)}". Answered ${
          validation.grounded ? 'with grounded knowledge' : 'without strong grounding'
        } (confidence ${validation.confidence}).`,
      );

      const creditsCharged = reservation
        ? await this.settleTurnReservation(
            reservation,
            companyId,
            totalPromptTokens,
            totalCompletionTokens,
            reservationRateId,
          )
        : null;

      return {
        message: toMessageDto(assistant),
        plan,
        sources,
        validation,
        toolCalls,
        outOfScope: scope.outOfScope,
        estimatedCredits,
        creditsCharged,
      };
    } catch (err) {
      if (reservation) {
        await this.releaseTurnReservation(reservation, companyId);
      }
      throw err;
    }
  }

  /**
   * Settle the turn's reservation from real usage — shadow mode: never
   * throws. Returns the settled credits (Task 9.7's chat inline indicator),
   * or null when the ledger hiccuped (never blocks the chat response itself).
   */
  private async settleTurnReservation(
    reservation: CreditReservationDto,
    companyId: string,
    promptTokens: number,
    completionTokens: number,
    fallbackRateId: string | null,
  ): Promise<number | null> {
    try {
      const actual = await this.costCalculator.priceLlmCall({
        provider: this.router.providerName,
        model: process.env.LLM_MODEL ?? 'default',
        promptTokens,
        completionTokens,
      });
      await this.reservations.settle({
        reservationId: reservation.id,
        companyId,
        actualCredits: actual.credits,
        modelCostRateId: actual.modelCostRateId ?? fallbackRateId,
      });
      return actual.credits;
    } catch (err) {
      this.logger.warn(
        `credit settle failed (shadow mode, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Release the turn's reservation on a pre-response failure — shadow mode: never throws. */
  private async releaseTurnReservation(
    reservation: CreditReservationDto,
    companyId: string,
  ): Promise<void> {
    try {
      await this.reservations.release({
        reservationId: reservation.id,
        companyId,
        reason: 'Chat turn failed before producing a response',
      });
    } catch (err) {
      this.logger.warn(
        `credit release failed (shadow mode, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Reconstruct the RunResultDto for a duplicate submission instead of
   * re-running the agent loop (credit-system prerequisite, kill-critic
   * Q3(a)) — the assistant reply's own persisted metadata already carries
   * {plan, sources, validation, toolCalls}, so the original result is
   * recoverable exactly, except `outOfScope` (stripped from `content` before
   * persisting, so it is not recoverable from stored state — omitted here
   * since it is optional on RunResultDto).
   *
   * No reservation/lease system exists yet (that lands with CreditReservation
   * in a later phase), so a duplicate whose assistant reply has not been
   * persisted yet — a genuine concurrent in-flight duplicate — surfaces as a
   * 409 rather than inventing a wait/poll mechanism ahead of schedule.
   */
  private async replayDuplicateTurn(
    conversationId: string,
    idempotencyKey: string,
  ): Promise<RunResultDto> {
    const existingUserTurn = await this.prisma.message.findUnique({
      where: { conversationId_idempotencyKey: { conversationId, idempotencyKey } },
    });
    if (!existingUserTurn) {
      // A P2002 on this constraint guarantees a matching row exists; getting
      // here would mean it was deleted between the failed create and this
      // read. Surface plainly rather than silently retrying.
      throw new ConflictException(
        'A duplicate request could not be resolved; please retry.',
      );
    }
    const assistantReply = await this.prisma.message.findFirst({
      where: {
        conversationId,
        role: 'ASSISTANT',
        createdAt: { gt: existingUserTurn.createdAt },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!assistantReply) {
      throw new ConflictException(
        'A request with this idempotency key is already being processed.',
      );
    }
    const metadata =
      (assistantReply.metadata as unknown as MessageMetadataDto | null) ?? {};
    return {
      message: toMessageDto(assistantReply),
      plan: metadata.plan ?? [],
      sources: metadata.sources ?? [],
      validation:
        metadata.validation ?? { grounded: false, confidence: 0, needsApproval: false },
      toolCalls: metadata.toolCalls ?? [],
      // Not recoverable from persisted state (same reasoning as `outOfScope`
      // above) — both figures live in the ledger, not on the message.
      estimatedCredits: null,
      creditsCharged: null,
    };
  }

  /** System prompt: persona + role + plan + retrieved knowledge (delimited) + memory. */
  private buildSystemPrompt(
    employee: AiEmployee,
    plan: string[],
    sources: RunResultDto['sources'],
    memory: LoadedMemory,
    otherEmployees: OtherEmployee[],
  ): string {
    const lines: string[] = [
      `You are ${employee.name}, a ${employee.role} AI employee working for this company.`,
      `ROLE BOUNDARY (must follow): your job is ONLY ${ROLE_SCOPE[employee.role]}. ` +
        "That is the full extent of your job — nothing else, even if you " +
        'technically know how to do it or the user insists.',
      "If the user's request belongs to a different role (e.g. recruiting/CV " +
        'screening is RECRUITER work, bookkeeping/expenses is ACCOUNTANT work, ' +
        'people-ops policy is HR work, customer issues are SUPPORT work — or ' +
        'any role listed below) you MUST refuse to perform it, even partially. ' +
        `Begin that reply with the exact marker ${OUT_OF_SCOPE_MARKER} and then ` +
        'give ONLY a short, polite decline explaining this is outside ' +
        'your role and naming the correct AI employee/role for it — do not ' +
        'produce the requested output, an estimate, or a "however, in ' +
        'general..." answer. The marker is how the platform tells a refusal ' +
        'from an answer; without it a workflow step records your refusal as ' +
        'completed work. Use it ONLY when you are declining.',
    ];
    // Named, per-company redirect targets — generalizes the refusal above
    // beyond the 4 hardcoded example categories (RECRUITER/ACCOUNTANT/HR/
    // SUPPORT), which previously left CUSTOM-role employees (Marketing/
    // Procurement/Operations/Legal, or any future custom persona) with no
    // explicit "redirect to X" mapping — only general reasoning to fall back
    // on. A CUSTOM role's scope line is its persona, so use that as the
    // one-line description instead of the generic ROLE_SCOPE.CUSTOM filler.
    if (otherEmployees.length > 0) {
      lines.push(
        '',
        'Other AI employees at this company — redirect off-role requests to the right one:',
      );
      otherEmployees.forEach((e) => {
        const scope =
          e.role === 'CUSTOM' && e.persona
            ? clip(e.persona, 140)
            : ROLE_SCOPE[e.role];
        lines.push(`- ${e.name} (${e.role}): ${scope}`);
      });
    }
    if (employee.persona) {
      lines.push(`Persona and guidelines: ${employee.persona}`);
    }
    lines.push('', 'Plan you are following:');
    plan.forEach((step, i) => lines.push(`${i + 1}. ${step}`));

    if (memory.memories.length > 0) {
      lines.push('', 'What you remember from earlier:');
      memory.memories.forEach((m) => lines.push(`- ${m.content}`));
    }

    lines.push('', 'Relevant company knowledge (cite by number):', CONTEXT_OPEN);
    if (sources.length > 0) {
      sources.forEach((s, i) => lines.push(`[${i + 1}] ${s.content}`));
    } else {
      lines.push('(no relevant company knowledge was found)');
    }
    lines.push(
      CONTEXT_CLOSE,
      '',
      'Answer the user grounded in the company knowledge above, citing sources by ' +
        'their [number]. If the knowledge does not cover the question, say so plainly.',
    );
    return lines.join('\n');
  }

  /** Map persisted turns to the LLM message shape (USER/ASSISTANT only). */
  private buildMessages(memory: LoadedMemory, userText: string): LlmMessage[] {
    const mapped: LlmMessage[] = memory.messages
      .filter((m) => m.role === 'USER' || m.role === 'ASSISTANT')
      .map((m) => ({
        role: m.role === 'USER' ? 'user' : 'assistant',
        content: m.content,
      }));
    return mapped.length > 0 ? mapped : [{ role: 'user', content: userText }];
  }

  /** Throw if this employee has a budget limit and has already reached it. */
  private async assertUnderBudget(employee: AiEmployee): Promise<void> {
    if (employee.budgetLimit == null) {
      return;
    }
    const spent = await this.usage.totalCostForEmployee(
      employee.companyId,
      employee.id,
      startOfCurrentMonthUtc(),
    );
    if (spent >= employee.budgetLimit) {
      throw new ConflictException(
        `${employee.name} has reached its monthly budget limit — ` +
          'raise the limit or wait for next month to send more messages.',
      );
    }
  }

  /** Best-effort (UsageService.record never throws); awaited so the write
   * lands before the turn finishes, not a detached fire-and-forget. */
  private async recordUsage(
    companyId: string,
    employeeId: string,
    usage: LlmUsage | undefined,
    options?: RunTurnOptions,
  ): Promise<void> {
    if (!usage) {
      return;
    }
    await this.usage.record({
      companyId,
      employeeId,
      source: options?.source ?? 'chat',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      workflowRunId: options?.workflowRunId,
      workflowStepRunId: options?.workflowStepRunId,
    });
  }
}
