import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type AiEmployee, type Conversation } from '@prisma/client';
import type {
  EmployeeRole,
  MessageMetadataDto,
  RunResultDto,
  ToolCallDto,
} from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
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
import { LlmRouterService } from './llm-router.service';
import { MemoryService, type LoadedMemory } from './memory.service';
import { OUT_OF_SCOPE_MARKER, readScope } from './out-of-scope';
import { PlannerService } from './planner.service';
import { RetrievalService } from './retrieval.service';
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
    private readonly usage: UsageService,
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
    const userTurn = await this.prisma.message.create({
      data: {
        companyId,
        conversationId: conversation.id,
        role: 'USER',
        content: userText,
      },
    });

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
      await this.recordUsage(companyId, employee.id, draft.usage);

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
      await this.recordUsage(companyId, employee.id, draft.usage);
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

    // VALIDATE grounding + confidence.
    const validation = this.validation.validate(employee.role, answer, sources);

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

    return {
      message: toMessageDto(assistant),
      plan,
      sources,
      validation,
      toolCalls,
      outOfScope: scope.outOfScope,
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
  ): Promise<void> {
    if (!usage) {
      return;
    }
    await this.usage.record({
      companyId,
      employeeId,
      source: 'chat',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
  }
}
