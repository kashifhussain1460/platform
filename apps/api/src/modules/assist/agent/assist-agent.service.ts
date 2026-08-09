import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AssistStreamEvent,
  AssistTestResult,
  AssistUnresolvedNodeDto,
  WorkflowDefinition,
  WorkflowSkillRequirementDto,
} from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SkillRequirementsService } from '../../skills/skill-requirements.service';
import {
  LLM_PROVIDER_TOKEN,
  type LlmMessage,
  type LlmProvider,
  type LlmToolCall,
  streamOrComplete,
} from '../../employees/llm/llm.provider';
import { UsageService } from '../../usage/usage.service';
import { WorkflowsService } from '../../workflows/workflows.service';
import {
  ASSIST_CONTEXT_MESSAGES,
  ASSIST_MAX_ITERATIONS,
  ASSIST_SESSION_TOKEN_BUDGET,
  ASSIST_USAGE_SOURCE,
} from '../assist.constants';
import { buildAssistSystemPrompt } from './assist-prompt';
import { makeReadTools } from './assist-read-tools';
import {
  AssistToolRegistry,
  type AssistToolContext,
} from './assist-tool-registry';
import { makeTestTools } from './assist-test-tool';
import { makeWriteTools } from './assist-write-tools';

/**
 * Where the agent reports progress as it works. Streaming callers pass one;
 * non-streaming callers pass nothing and the loop is otherwise identical — ONE
 * loop, two deliveries, so the two paths cannot drift.
 */
export type AssistEventSink = (event: AssistStreamEvent) => void;

/** What one turn produced, for the caller to persist / stream. */
export interface AssistTurnResult {
  /** The assistant's final text for the user. */
  reply: string;
  /** One entry per tool call, for the collapsible "thinking" trace. */
  toolTrace: { name: string; summary: string; ok: boolean }[];
  /** Draft version after the turn (unchanged if the agent didn't write). */
  graphVersion: number;
  graphChanged: boolean;
  unresolved: AssistUnresolvedNodeDto[];
  /** Dry-run results from this turn, so a reload shows what the user saw. */
  tests: AssistTestResult[];
  /**
   * Connection-requiring skills the current draft references (doc 30 §12) —
   * empty unless the draft uses at least one oauth/api_key skill. Drives the
   * in-chat Skill card; persisted as a CONNECTION message so a reload shows it.
   */
  connectionRequirements: WorkflowSkillRequirementDto[];
  /** True when the agent called `finish`. */
  finished: boolean;
  usage: { promptTokens: number; completionTokens: number };
  /** Set when the turn stopped for a reason worth telling the user about. */
  stoppedBecause?: 'iterations' | 'budget';
}

/**
 * The assist agent (doc 30 §6). A bounded tool-calling loop over a server-held
 * draft graph.
 *
 * A2 is deliberately NON-STREAMING — it uses `complete()`. Wave A3 swaps in
 * `completeStream` behind the same shape, which is why the loop keeps its
 * side-effects (persistence, metering) separate from how the text is delivered.
 *
 * What bounds a runaway turn:
 *  - `ASSIST_MAX_ITERATIONS` tool calls, then the model is forced to answer with
 *    tools switched OFF (mirrors the safety net in `AgentRuntimeService`).
 *  - A per-session token budget checked BEFORE each completion, so an expensive
 *    session degrades into an honest stop rather than an unbounded bill.
 */
@Injectable()
export class AssistAgentService {
  private readonly logger = new Logger(AssistAgentService.name);
  private readonly tools: AssistToolRegistry;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LlmProvider,
    private readonly usage: UsageService,
    private readonly workflows: WorkflowsService,
    private readonly skillRequirements: SkillRequirementsService,
  ) {
    this.tools = new AssistToolRegistry([
      ...makeReadTools(prisma),
      ...makeWriteTools(prisma),
      ...makeTestTools(prisma, workflows),
    ]);
  }

  /**
   * Run one turn: the user has said something, the agent works until it either
   * answers or hands control back.
   */
  async runTurn(
    companyId: string,
    userId: string,
    sessionId: string,
    sink?: AssistEventSink,
  ): Promise<AssistTurnResult> {
    const emit: AssistEventSink = (event) => sink?.(event);
    const session = await this.prisma.assistSession.findFirstOrThrow({
      where: { id: sessionId, companyId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: ASSIST_CONTEXT_MESSAGES,
        },
      },
    });

    const spent = session.promptTokens + session.completionTokens;
    if (spent >= ASSIST_SESSION_TOKEN_BUDGET) {
      await this.prisma.assistSession.update({
        where: { id: sessionId },
        data: { status: 'EXHAUSTED' },
      });
      return {
        reply:
          "This conversation has gone on long enough that I've used up its budget. Your workflow so far is saved — start a fresh chat and we can carry on from it.",
        toolTrace: [],
        graphVersion: session.draftVersion,
        graphChanged: false,
        unresolved: [],
        tests: [],
        connectionRequirements: [],
        finished: false,
        usage: { promptTokens: 0, completionTokens: 0 },
        stoppedBecause: 'budget',
      };
    }

    const system = await this.buildPrompt(companyId, session.targetWorkflowId);
    const ctx: AssistToolContext = { companyId, userId, sessionId };
    const toolDefs = this.tools.definitions();

    // Working transcript for THIS turn — the persisted history plus whatever the
    // agent says and learns as it goes.
    let working: LlmMessage[] = session.messages.map(toLlmMessage);

    const toolTrace: AssistTurnResult['toolTrace'] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let reply = '';
    let finished = false;
    let graphChanged = false;
    let unresolved: AssistUnresolvedNodeDto[] = [];
    const tests: AssistTestResult[] = [];
    // Skills the agent explicitly asked the user to connect this turn (via
    // request_connection) — surfaced as the in-chat card even with no graph yet.
    const requestedConnectionSkills = new Set<string>();
    let stoppedBecause: AssistTurnResult['stoppedBecause'];

    for (let i = 0; i < ASSIST_MAX_ITERATIONS; i += 1) {
      emit({
        type: 'thinking',
        label: i === 0 ? 'Working out what you need' : 'Thinking about the next step',
      });

      // Streamed when the provider supports it, one-shot when it doesn't —
      // `streamOrComplete` owns that degrade so this loop never branches on it.
      let text = '';
      let call: LlmToolCall | undefined;
      for await (const chunk of streamOrComplete(
        this.llm,
        { system, messages: working, temperature: 0.2, maxTokens: 4096 },
        toolDefs,
      )) {
        if (chunk.kind === 'text') {
          text += chunk.text;
          // Forwarded immediately: this is the only part the user sees appear
          // progressively, and it is why the feature feels alive.
          emit({ type: 'token', text: chunk.text });
        } else if (chunk.kind === 'toolCall') {
          call = chunk.call;
        } else if (chunk.kind === 'usage') {
          promptTokens += chunk.usage.promptTokens;
          completionTokens += chunk.usage.completionTokens;
        }
      }

      if (!call) {
        reply = text.trim();
        break;
      }

      const outcome = await this.tools.dispatch(ctx, call.tool, call.args ?? {});
      toolTrace.push({ name: call.tool, summary: outcome.summary, ok: outcome.ok });
      emit({
        type: 'tool',
        tool: { name: call.tool, summary: outcome.summary, ok: outcome.ok },
      });

      if (
        (call.tool === 'propose_graph' || call.tool === 'patch_graph') &&
        outcome.ok
      ) {
        graphChanged = true;
      }
      // A test result is a first-class thing the user should SEE, not just a
      // sentence the model paraphrases — forward it as its own frame.
      const test = readTestResult(outcome.result);
      if (test) {
        tests.push(test);
        emit({ type: 'test', result: test });
      }
      const fromResult = readUnresolved(outcome.result);
      if (fromResult) unresolved = fromResult;
      const requested = readRequestedConnectionSkills(outcome.result);
      if (requested) for (const key of requested) requestedConnectionSkills.add(key);

      // Native tool-result threading: the model sees its own call and the answer
      // to it, keyed by callId — not a text blob it has to re-parse.
      working = [
        ...working,
        { role: 'assistant', content: text, toolCall: call },
        {
          role: 'tool',
          content: JSON.stringify(outcome.result),
          toolCallId: call.callId ?? '',
          toolName: call.tool,
        },
      ];

      if (this.tools.isTerminal(call.tool)) {
        finished = call.tool === 'finish';
        // A terminal tool ends the turn. `finish` carries its own user-facing
        // summary, so use it rather than burning another completion.
        const summary = readSummaryForUser(outcome.result);
        if (summary) {
          reply = summary;
          // This text never went through the model's output stream — it came
          // back inside a tool result — so nothing has emitted it yet. Without
          // this the user watches tools tick by and then sees NOTHING until the
          // session refetches. Caught by the SSE e2e: zero `token` frames.
          emit({ type: 'token', text: summary });
        }
        break;
      }
    }

    // Loop exhausted while still asking for tools — force a final answer with no
    // tools so a turn ALWAYS produces something for the user.
    if (!reply) {
      stoppedBecause = 'iterations';
      emit({ type: 'thinking', label: 'Wrapping up' });
      let forced = '';
      // Streamed too, so the user sees the wrap-up appear rather than staring at
      // a spinner after a long tool run.
      for await (const chunk of streamOrComplete(this.llm, {
        system,
        messages: [
          ...working,
          {
            role: 'user',
            content:
              'Stop using tools now and tell me in plain words where you got to and what you need from me.',
          },
        ],
        temperature: 0.2,
        maxTokens: 1024,
      })) {
        if (chunk.kind === 'text') {
          forced += chunk.text;
          emit({ type: 'token', text: chunk.text });
        } else if (chunk.kind === 'usage') {
          promptTokens += chunk.usage.promptTokens;
          completionTokens += chunk.usage.completionTokens;
        }
      }
      reply =
        forced.trim() ||
        "I got partway through and then got stuck. Could you tell me a bit more about what you're trying to automate?";
    }

    const updated = await this.prisma.assistSession.update({
      where: { id: sessionId },
      data: {
        promptTokens: { increment: promptTokens },
        completionTokens: { increment: completionTokens },
      },
      select: { draftVersion: true, draftDefinition: true },
    });

    // `graph` goes out AFTER the last mutation and BEFORE `done` (doc 30 §10), so
    // the canvas is never behind the text describing it.
    if (graphChanged && updated.draftDefinition) {
      emit({
        type: 'graph',
        definition: updated.draftDefinition as unknown as WorkflowDefinition,
        version: updated.draftVersion,
        unresolved,
      });
    }

    // Surface the in-chat Skill card (doc 30 §12). Two intentional triggers, so
    // it never spams a card on an unrelated follow-up turn:
    //   1. the agent explicitly asked via `request_connection` (works with NO
    //      graph yet — this is "ask for the connection first"), and/or
    //   2. a graph change introduced TOOL_ACTION steps.
    // Detection is server-side (deterministic, reuses the capability resolver) so
    // "the card the user sees" can't drift from "what would actually run".
    let connectionRequirements: WorkflowSkillRequirementDto[] = [];
    const draft = updated.draftDefinition as unknown as WorkflowDefinition | null;
    const skillKeysToCheck = new Set<string>(requestedConnectionSkills);
    if (draft?.nodes?.length) {
      for (const node of draft.nodes) {
        if (
          node.type === 'TOOL_ACTION' &&
          !node.disabled &&
          typeof node.config.skillKey === 'string' &&
          node.config.skillKey
        ) {
          skillKeysToCheck.add(node.config.skillKey);
        }
      }
    }
    if (
      (graphChanged || requestedConnectionSkills.size > 0) &&
      skillKeysToCheck.size > 0
    ) {
      const { requirements } = await this.skillRequirements.forSkillKeys(
        companyId,
        [...skillKeysToCheck],
        { canManageConnection: true },
      );
      // Only skills that actually need connecting belong on the card — a
      // `none`-connection skill (http/scheduling/…) is never a connection ask.
      connectionRequirements = requirements.filter((r) => r.requiresConnection);
      if (connectionRequirements.length > 0) {
        const missing = connectionRequirements.filter((r) => r.status !== 'READY').length;
        emit({
          type: 'connection',
          requirements: connectionRequirements,
          reason:
            missing > 0
              ? `This workflow needs ${missing} skill ${missing === 1 ? 'connection' : 'connections'} before it can run.`
              : 'All the skills this workflow needs are connected.',
        });
      }
    }

    // Metered under its own source so assist spend is separable from chat spend.
    await this.usage.record({
      companyId,
      source: ASSIST_USAGE_SOURCE,
      promptTokens,
      completionTokens,
    });

    this.logger.log(
      `assist.turn session=${sessionId} iterations=${toolTrace.length} tools=[${toolTrace
        .map((t) => t.name)
        .join(',')}] prompt=${promptTokens} completion=${completionTokens}`,
    );

    return {
      reply,
      toolTrace,
      graphVersion: updated.draftVersion,
      graphChanged,
      unresolved,
      tests,
      connectionRequirements,
      finished,
      usage: { promptTokens, completionTokens },
      ...(stoppedBecause ? { stoppedBecause } : {}),
    };
  }

  private async buildPrompt(
    companyId: string,
    targetWorkflowId: string | null,
  ): Promise<string> {
    const [company, employeeCount, skillCount, target] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({
        where: { id: companyId },
        select: { name: true, industry: true, size: true },
      }),
      this.prisma.aiEmployee.count({ where: { companyId, status: 'ACTIVE' } }),
      this.prisma.installedSkill.count({ where: { companyId } }),
      targetWorkflowId
        ? this.prisma.workflow.findFirst({
            where: { id: targetWorkflowId, companyId },
            select: { name: true },
          })
        : Promise.resolve(null),
    ]);

    return buildAssistSystemPrompt({
      companyName: company.name,
      industry: company.industry,
      size: company.size,
      employeeCount,
      skillCount,
      editingWorkflowName: target?.name ?? null,
    });
  }
}

/** Persisted message → the LLM's neutral shape. */
function toLlmMessage(row: { role: string; content: string }): LlmMessage {
  // Only USER/ASSISTANT turns are conversation; QUESTION/ANSWER/TEST/CONNECTION
  // rows are UI artefacts whose content is already plain text, so they read as
  // assistant context. SYSTEM rows are seeded facts, likewise.
  const role: LlmMessage['role'] = row.role === 'USER' ? 'user' : 'assistant';
  return { role, content: row.content };
}

function readUnresolved(result: unknown): AssistUnresolvedNodeDto[] | null {
  const value = (result as { unresolved?: unknown } | null)?.unresolved;
  return Array.isArray(value) ? (value as AssistUnresolvedNodeDto[]) : null;
}

/** Skill keys the `request_connection` tool asked the user to connect. */
function readRequestedConnectionSkills(result: unknown): string[] | null {
  const value = (result as { requestedConnectionSkills?: unknown } | null)
    ?.requestedConnectionSkills;
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : null;
}

function readTestResult(result: unknown): AssistTestResult | null {
  const value = (result as { test?: unknown } | null)?.test;
  return value && typeof value === 'object' ? (value as AssistTestResult) : null;
}

function readSummaryForUser(result: unknown): string | null {
  const value = (result as { summaryForUser?: unknown } | null)?.summaryForUser;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
