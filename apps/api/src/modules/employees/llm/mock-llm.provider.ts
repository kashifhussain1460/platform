import { Injectable } from '@nestjs/common';
import type { ToolDefinitionDto } from '@vaep/types';
import {
  CONTEXT_CLOSE,
  CONTEXT_OPEN,
  PLAN_PROMPT_MARKER,
  TOOL_RESULT_MARKER,
} from '../employees.constants';
import { SkillCatalog } from '../../skills/catalog';
import { ASSIST_AGENT_MARKER } from '../../assist/agent/assist-prompt';
import { completeAssistTurn } from './mock-assist-script';
import {
  EMPLOYEES_CLOSE,
  EMPLOYEES_OPEN,
  INSTALLED_SKILLS_CLOSE,
  INSTALLED_SKILLS_OPEN,
  WORKFLOW_GENERATOR_MARKER,
} from '../../workflows/workflows.constants';
import type {
  LlmCompletionInput,
  LlmCompletionResult,
  LlmProvider,
  LlmStreamChunk,
} from './llm.provider';

/** Split text into ~`size`-char pieces, breaking on whitespace where possible. */
function chunkText(text: string, size: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = window.lastIndexOf(' ');
    const at = cut > size / 2 ? cut + 1 : size;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) out.push(rest);
  return out;
}

/** Truncate to `n` chars with an ellipsis, collapsing surrounding whitespace. */
function clip(text: string, n: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : `${clean.slice(0, n).trimEnd()}…`;
}

/** Return the text between the first `open` and the next `close`, or ''. */
function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  if (start === -1) {
    return '';
  }
  const from = start + open.length;
  const end = text.indexOf(close, from);
  return text.slice(from, end === -1 ? undefined : end);
}

/** Identifying tokens for a tool: its name parts + owning skill key. */
function toolTokens(tool: ToolDefinitionDto): string[] {
  const nameParts = tool.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // `tool` here IS the exact, already-scoped entry (tagged by
  // SkillsService.getToolsForEmployee) — prefer its own skillKey over the
  // ambiguous global catalog search (docs/test-cases WF-E3).
  const skillKey = tool.skillKey ?? SkillCatalog.skillKeyForTool(tool.name);
  return skillKey ? [...nameParts, skillKey.toLowerCase()] : nameParts;
}

interface GroundingSkill {
  skillKey: string;
  tools: string[];
}
interface GroundingEmployee {
  id: string;
  name: string;
  role: string;
}

/**
 * Deterministic workflow-generation mode (docs/specs/2026-07-13-ai-workflow-
 * generator-design.md). Derives everything from what the system prompt
 * embeds: asks one clarifying question on the first turn if nothing is
 * installed yet; otherwise drafts a 4-node workflow (TRIGGER → AI_STEP →
 * TOOL_ACTION → NOTIFY), grounded in the FIRST installed skill/employee it was
 * given, or a deliberately-nonexistent skillKey/tool when nothing real is
 * available even after the follow-up — exercising WorkflowGeneratorService's
 * validation/fallback path deterministically and offline.
 */
function completeWorkflowGeneration(input: LlmCompletionInput): LlmCompletionResult {
  const { system, messages } = input;
  const userTurns = messages.filter((m) => m.role === 'user').length;

  const skillsRaw = between(system, INSTALLED_SKILLS_OPEN, INSTALLED_SKILLS_CLOSE);
  const employeesRaw = between(system, EMPLOYEES_OPEN, EMPLOYEES_CLOSE);
  const skills: GroundingSkill[] = skillsRaw ? JSON.parse(skillsRaw) : [];
  const employees: GroundingEmployee[] = employeesRaw ? JSON.parse(employeesRaw) : [];

  if (skills.length === 0 && userTurns <= 1) {
    return {
      content: JSON.stringify({
        type: 'question',
        message: 'Which tool or integration should this workflow use (e.g. Slack, email)?',
      }),
    };
  }

  const trigger = { id: 'trigger', type: 'TRIGGER', config: {} };
  const aiStep = {
    id: 'ai_step',
    type: 'AI_STEP',
    config: {
      prompt: 'Summarize the request: {{trigger.payload}}',
      ...(employees[0] ? { employeeId: employees[0].id } : {}),
    },
  };
  const toolAction = skills[0]
    ? {
        id: 'tool_action',
        type: 'TOOL_ACTION',
        config: { skillKey: skills[0].skillKey, tool: skills[0].tools[0], args: {} },
      }
    : {
        id: 'tool_action',
        type: 'TOOL_ACTION',
        config: { skillKey: 'imaginary_skill', tool: 'imaginary_tool', args: {} },
      };
  const notify = { id: 'notify', type: 'NOTIFY', config: { message: 'Workflow finished.' } };

  return {
    content: JSON.stringify({
      type: 'draft',
      definition: {
        nodes: [trigger, aiStep, toolAction, notify],
        edges: [
          { from: 'trigger', to: 'ai_step' },
          { from: 'ai_step', to: 'tool_action' },
          { from: 'tool_action', to: 'notify' },
        ],
      },
    }),
  };
}

/** Pick the tool best matching the user text (token overlap); fallback: first. */
function selectTool(
  tools: ToolDefinitionDto[],
  userText: string,
): ToolDefinitionDto {
  const haystack = userText.toLowerCase();
  let best = tools[0];
  let bestScore = -1;
  for (const tool of tools) {
    const score = toolTokens(tool).reduce(
      (n, t) => (haystack.includes(t) ? n + 1 : n),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = tool;
    }
  }
  return best;
}

const RE_CHANNEL = /#[a-z0-9_-]+/i;
const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const RE_URL = /https?:\/\/[^\s]+/i;
const RE_REPO = /\b[\w.-]+\/[\w.-]+\b/;
const RE_NUMBER = /\d[\d,]*(?:\.\d+)?/;

/** Deterministically derive one required-parameter value from the user text. */
function deriveArg(
  name: string,
  schema: { type: string; enum?: string[] },
  userText: string,
): unknown {
  if (schema.enum && schema.enum.length > 0) {
    const hit = schema.enum.find((v) =>
      userText.toLowerCase().includes(v.toLowerCase()),
    );
    return hit ?? schema.enum[0];
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const m = userText.match(RE_NUMBER);
    return m ? Number(m[0].replace(/,/g, '')) : 1000;
  }
  if (/channel/i.test(name)) {
    return userText.match(RE_CHANNEL)?.[0] ?? '#general';
  }
  if (/^to$|email|recipient/i.test(name)) {
    // yopmail.com, not example.com (RFC 2606 reserved, bounces): a real,
    // checkable inbox means anything downstream that actually sends to this
    // fallback can be verified rather than silently swallowed by a dead domain.
    return userText.match(RE_EMAIL)?.[0] ?? 'user@yopmail.com';
  }
  if (/url/i.test(name)) {
    return userText.match(RE_URL)?.[0] ?? 'https://example.com';
  }
  if (/currency/i.test(name)) {
    return 'usd';
  }
  if (/repo/i.test(name)) {
    return userText.match(RE_REPO)?.[0] ?? 'octo/hello-world';
  }
  if (/method/i.test(name)) {
    return 'GET';
  }
  if (/subject|title/i.test(name)) {
    return clip(userText, 80);
  }
  return clip(userText, 500);
}

/** Build the full args object for a tool's required params. */
function deriveArgs(
  tool: ToolDefinitionDto,
  userText: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of tool.parameters.required) {
    const schema = tool.parameters.properties[name];
    if (schema) {
      args[name] = deriveArg(name, schema, userText);
    }
  }
  return args;
}

/**
 * DEFAULT provider: fully offline, zero-dependency and DETERMINISTIC so tests
 * can assert on the output. It derives everything from the input:
 *  - PLAN prompts (containing PLAN_PROMPT_MARKER) → a numbered step plan.
 *  - ACT prompts with NO tools → a grounded answer quoting the retrieved
 *    knowledge block (unchanged from before skills existed).
 *  - ACT prompts WITH tools → on the first iteration return a `toolCall`
 *    selecting the best-matching tool with args derived from the message; once a
 *    tool RESULT is present in the messages, return a final answer that
 *    references BOTH the tool result and the retrieved knowledge.
 */
/** Rough, deterministic offline stand-in for a real token count (~4 chars/token). */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

@Injectable()
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';

  async complete(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): Promise<LlmCompletionResult> {
    const result = await this.completeInner(input, tools);
    // Deterministic, offline usage estimate so metering can be exercised in
    // tests without a real provider — not meant to be an accurate count.
    const promptText =
      input.system + input.messages.map((m) => m.content).join(' ');
    const completionText =
      result.content ?? JSON.stringify(result.toolCall ?? {});
    return {
      ...result,
      usage: {
        promptTokens: estimateTokens(promptText),
        completionTokens: estimateTokens(completionText),
      },
    };
  }

  /**
   * Streaming for the offline provider: run the same deterministic completion,
   * then hand the text back in small pieces. Real providers stream because the
   * model is slow; this exists so streaming CONSUMERS (the SSE endpoint, the
   * assist agent loop) are fully testable with no network and no API key —
   * which is what keeps CI offline.
   */
  async *completeStream(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): AsyncIterable<LlmStreamChunk> {
    const result = await this.complete(input, tools);

    if (result.toolCall) {
      yield { kind: 'toolCall', call: result.toolCall };
    } else {
      // ~24-char pieces on word boundaries — enough chunks to exercise a
      // consumer's accumulation without making tests slow.
      for (const piece of chunkText(result.content ?? '', 24)) {
        yield { kind: 'text', text: piece };
      }
    }
    if (result.usage) yield { kind: 'usage', usage: result.usage };
    yield { kind: 'done' };
  }

  private async completeInner(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): Promise<LlmCompletionResult> {
    const { system, messages } = input;

    if (system.includes(ASSIST_AGENT_MARKER)) {
      // The conversational builder: a multi-step tool loop, scripted so it can
      // be exercised offline (see mock-assist-script.ts).
      return completeAssistTurn(input, tools);
    }

    if (system.includes(WORKFLOW_GENERATOR_MARKER)) {
      return completeWorkflowGeneration(input);
    }

    const userText =
      [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // PLAN mode — deterministic numbered plan.
    if (system.includes(PLAN_PROMPT_MARKER)) {
      const steps = [
        `Interpret the request: ${clip(userText, 120)}`,
        'Retrieve relevant company knowledge',
        'Draft a grounded answer that cites the retrieved knowledge',
        'Validate confidence and flag for human approval if needed',
      ];
      return {
        content: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      };
    }

    const hasTools = Array.isArray(tools) && tools.length > 0;
    const toolResult = messages.find((m) =>
      m.content.includes(TOOL_RESULT_MARKER),
    );

    // ACT mode, tools available, none run yet → choose a tool to call.
    if (hasTools && !toolResult) {
      const tool = selectTool(tools, userText);
      return {
        toolCall: {
          skillKey: tool.skillKey ?? SkillCatalog.skillKeyForTool(tool.name) ?? '',
          tool: tool.name,
          args: deriveArgs(tool, userText),
        },
      };
    }

    const context = between(system, CONTEXT_OPEN, CONTEXT_CLOSE).trim();

    // ACT mode, a tool already ran → final answer referencing result + knowledge.
    if (toolResult) {
      const info = parseToolResult(toolResult.content);
      const action = info
        ? `I completed the requested action using the ${info.skillKey} skill (${info.tool}) — ` +
          `${info.ok ? 'the sandbox call succeeded' : 'it did not succeed'}.`
        : 'I completed the requested action.';
      const grounding = context
        ? ` Based on the company knowledge base: ${clip(context, 500)}`
        : '';
      return { content: `${action}${grounding}` };
    }

    // ACT mode, no tools — original grounded behaviour (unchanged).
    if (!context) {
      return {
        content:
          `I don't have any company knowledge to answer "${clip(userText, 200)}" ` +
          'yet. Please add relevant documents to my knowledge base.',
      };
    }
    return {
      content:
        `Based on the company knowledge base, here is what I found regarding ` +
        `"${clip(userText, 200)}":\n\n${clip(context, 600)}`,
    };
  }
}

/** Parse the JSON payload the runtime appends after TOOL_RESULT_MARKER. */
function parseToolResult(
  content: string,
): { skillKey: string; tool: string; ok: boolean } | null {
  const at = content.indexOf(TOOL_RESULT_MARKER);
  if (at === -1) {
    return null;
  }
  try {
    const json = content.slice(at + TOOL_RESULT_MARKER.length).trim();
    const parsed = JSON.parse(json) as {
      skillKey?: string;
      tool?: string;
      ok?: boolean;
    };
    return {
      skillKey: parsed.skillKey ?? 'unknown',
      tool: parsed.tool ?? 'unknown',
      ok: Boolean(parsed.ok),
    };
  } catch {
    return null;
  }
}
