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
  /**
   * Model override for THIS call. Falls back to `LLM_MODEL`, then the
   * provider's own current default.
   *
   * ## Why this exists
   *
   * `AiEmployee.model` is a column the product has always offered, mapped to
   * the DTO and rendered on the employee's Overview tab. The 2026-09-02 audit
   * found it triple-disconnected: this interface had no `model` field, so every
   * caller's value was dropped on the floor; both providers read only
   * `LLM_MODEL`; and the Settings panel had no control to set it. "Choose the
   * model for this employee" was a stated capability with nothing behind it.
   *
   * It also fixes a quieter billing bug. `AiStepNodeHandler` and
   * `AgentRuntimeService` priced their spend with
   * `process.env.LLM_MODEL ?? 'default'` while the provider actually called
   * `config.get('LLM_MODEL') || DEFAULT_MODEL` — so with `LLM_MODEL` unset, a
   * call to `gpt-5.6-terra` was billed against a generic `default` rate. Now
   * one resolved value is used for both the request and the price.
   *
   * Deliberately a plain string with no validation here: a model id is vendor
   * data that changes faster than this codebase ships, and the provider is the
   * only thing that can meaningfully reject one (`CLAUDE.md`: never hardcode a
   * model in calling code — a deprecation must be a config change).
   */
  model?: string;
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
  /**
   * Which model this provider WOULD use for a request carrying `requested`.
   *
   * Exists so a caller can price a call against the model that will actually
   * serve it. OPTIONAL for the same reason `completeStream` is: a hand-rolled
   * test double should not have to implement it. Callers use
   * {@link modelForCall}.
   */
  resolveModel?(requested?: string): string;
}

/** DI token for the active LlmProvider implementation. */
export const LLM_PROVIDER_TOKEN = Symbol('LLM_PROVIDER_TOKEN');

/**
 * The model a call will actually use — ask the provider, fall back to the same
 * precedence it would apply.
 *
 * Written once, here, because the alternative was two divergent answers: the
 * providers resolved `LLM_MODEL || DEFAULT_MODEL` while the credit pricers
 * resolved `process.env.LLM_MODEL ?? 'default'`. With `LLM_MODEL` unset the
 * vendor got `gpt-5.6-terra` and the ledger got a generic `default` rate. Every
 * spend site now prices what it sends.
 *
 * The `'default'` tail is not a model id — it is the key of the catch-all rate
 * row in `credit-rates.defaults.ts`, and it is only reachable via a provider
 * that cannot answer (i.e. a test double), never in production.
 */
export function modelForCall(
  provider: LlmProvider,
  requested?: string,
): string {
  if (provider.resolveModel) return provider.resolveModel(requested);
  return (
    requested?.trim() || process.env.LLM_MODEL?.trim() || 'default'
  );
}

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
