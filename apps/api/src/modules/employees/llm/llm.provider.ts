import type { ToolDefinitionDto } from '@vaep/types';

/**
 * Swappable chat-completion backend (mirrors the knowledge EmbeddingProvider and
 * auth AuthProvider patterns). The active implementation is chosen by the
 * `LLM_PROVIDER` env var and provided as a singleton under the
 * LLM_PROVIDER_TOKEN DI token. The default (`mock`) is deterministic, offline
 * and zero-dependency so the whole runtime is runnable with no API key.
 *
 * THIS interface is the vendor-switching seam. Each implementation is free to
 * use whatever native API its vendor currently recommends — OpenAI's Responses
 * API, Anthropic's Messages API — and the differences stop here. Switching is a
 * config change, never a code change above this file.
 *
 * Everything added for the conversational builder (doc 30 §19) is OPTIONAL and
 * additive, so the existing callers (`AgentRuntimeService`, the `AI_STEP`
 * handler, `WorkflowGeneratorService`) keep working untouched.
 */

/** A tool the model chose to invoke (resolved back to its owning skill). */
export interface LlmToolCall {
  skillKey: string;
  tool: string;
  args: Record<string, unknown>;
  /**
   * Provider-issued correlation id for this call (OpenAI `call_id`, Anthropic
   * `tool_use.id`). Required to thread the RESULT back natively; absent on
   * providers/paths that don't support it, in which case the caller falls back
   * to the legacy text-marker convention.
   */
  callId?: string;
}

/**
 * A single chat turn. The system prompt is passed separately (see input).
 *
 * `role: 'tool'` carries a tool RESULT back to the model — the native
 * replacement for stuffing a `[[VAEP:TOOL_RESULT]]` blob into an assistant
 * message, which loses the call correlation and degrades multi-step loops.
 */
export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** On an assistant turn that REQUESTED a tool (so the model sees its own call). */
  toolCall?: LlmToolCall;
  /** On a `role:'tool'` turn: which call this result answers. */
  toolCallId?: string;
  /** On a `role:'tool'` turn: the tool's name, which some providers require. */
  toolName?: string;
}

/** Input to a completion: a system prompt, the turns, and optional knobs. */
export interface LlmCompletionInput {
  system: string;
  messages: LlmMessage[];
  temperature?: number;
  /**
   * Output cap. Providers previously hardcoded this (Anthropic at 1024), which
   * silently truncates a large structured answer such as a workflow graph.
   */
  maxTokens?: number;
  /** Abort an in-flight completion (a cancelled turn, a closed stream). */
  signal?: AbortSignal;
  /**
   * Ask for strict JSON where the provider supports it. The caller must STILL
   * validate — this reduces malformed output, it does not guarantee it.
   */
  json?: boolean;
}

/** Token counts for one completion, when the backend reports them. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Output of a completion: EITHER a final text `content` OR a `toolCall` the
 * runtime should execute before continuing the loop. `usage` is optional
 * because a provider that can't report it (or a hand-rolled test double)
 * simply omits it -- callers must treat it as best-effort, not guaranteed.
 */
export interface LlmCompletionResult {
  content?: string;
  toolCall?: LlmToolCall;
  usage?: LlmUsage;
}

/**
 * One piece of a streamed completion. Deliberately a small, provider-neutral
 * union: every vendor's event zoo is normalised into these four shapes so the
 * consumer never has to branch on which provider is active.
 */
export type LlmStreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; call: LlmToolCall }
  | { kind: 'usage'; usage: LlmUsage }
  | { kind: 'done' };

export interface LlmProvider {
  /** Stable id of the backend (e.g. `mock`, `anthropic`, `openai`). */
  readonly name: string;
  /**
   * Complete a turn. When `tools` is non-empty the model MAY return a `toolCall`
   * instead of `content`; when it is empty/undefined the provider behaves as a
   * plain chat completion (returns `content`).
   */
  complete(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): Promise<LlmCompletionResult>;
  /**
   * Stream a turn. OPTIONAL: a provider without it degrades honestly — callers
   * use {@link streamOrComplete}, which falls back to `complete()` and emits the
   * whole answer as one chunk. Never assume this exists.
   */
  completeStream?(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): AsyncIterable<LlmStreamChunk>;
}

/** DI token for the active LlmProvider implementation. */
export const LLM_PROVIDER_TOKEN = Symbol('LLM_PROVIDER_TOKEN');

/**
 * Stream when the provider can, otherwise fall back to one `complete()` call
 * emitted as a single chunk. Written once, here, so the degrade path behaves
 * identically everywhere instead of each caller re-inventing it.
 */
export async function* streamOrComplete(
  provider: LlmProvider,
  input: LlmCompletionInput,
  tools?: ToolDefinitionDto[],
): AsyncIterable<LlmStreamChunk> {
  if (provider.completeStream) {
    yield* provider.completeStream(input, tools);
    return;
  }
  const result = await provider.complete(input, tools);
  if (result.toolCall) {
    yield { kind: 'toolCall', call: result.toolCall };
  } else if (result.content) {
    yield { kind: 'text', text: result.content };
  }
  if (result.usage) yield { kind: 'usage', usage: result.usage };
  yield { kind: 'done' };
}
