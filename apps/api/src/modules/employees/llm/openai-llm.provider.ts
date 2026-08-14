import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ToolDefinitionDto } from '@vaep/types';
import { SkillCatalog } from '../../skills/catalog';
import type {
  LlmCompletionInput,
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  LlmToolCall,
} from './llm.provider';

/**
 * OpenAI provider (`LLM_PROVIDER=openai`). Requires `OPENAI_API_KEY`; the model
 * comes from `LLM_MODEL` (or `ASSIST_LLM_MODEL` for the builder) and is NEVER a
 * literal in calling code — a deprecation must be a config change.
 *
 * ── Why Chat Completions and not the Responses API ──────────────────────────
 * OpenAI recommends Responses for new agentic work, and it is the better fit on
 * paper. We use Chat Completions deliberately:
 *   1. Vendor portability is the point of this layer. The Chat Completions
 *      request/response shape is the de-facto cross-vendor shape (Anthropic
 *      compat endpoints, Gemini, Mistral, Bedrock all speak it), so the mental
 *      model here transfers when we add a provider.
 *   2. It already gives us everything the conversational builder needs —
 *      `role:'tool'` + `tool_call_id` IS native tool-result threading, which is
 *      the one capability doc 30 §19.3 called for.
 *   3. It is not deprecated (the Assistants API is; Chat Completions is not).
 * If we later need Responses-only features (built-in web search / file search /
 * server-side state), add a SECOND provider rather than mutating this one — the
 * `LlmProvider` seam exists precisely so that is a config flip.
 *
 * Verified against platform docs 2026-08-02: `max_completion_tokens` (NOT the
 * deprecated `max_tokens`), `response_format`, `stream_options.include_usage`.
 */

/** Balanced current-generation default; override with `LLM_MODEL`. */
const DEFAULT_MODEL = 'gpt-5.6-terra';
const DEFAULT_MAX_TOKENS = 4096;

type OpenAiToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

interface OpenAiClient {
  chat: {
    completions: {
      // The SECOND argument is the SDK's RequestOptions — where `signal`
      // belongs. Typing it here is what stops it drifting back into the body.
      create(
        args: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<unknown>;
    };
  };
}

@Injectable()
export class OpenAiLlmProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly logger = new Logger(OpenAiLlmProvider.name);
  private client: OpenAiClient | null = null;

  constructor(private readonly config: ConfigService) {}

  async complete(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): Promise<LlmCompletionResult> {
    const client = await this.getClient();
    const res = (await client.chat.completions.create(
      this.buildRequest(input, tools, false),
      this.requestOptions(input),
    )) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const usage = res.usage
      ? {
          promptTokens: res.usage.prompt_tokens,
          completionTokens: res.usage.completion_tokens,
        }
      : undefined;

    const message = res.choices?.[0]?.message;
    const raw = message?.tool_calls?.[0];
    if (raw?.function?.name) {
      return {
        toolCall: this.toToolCall(
          raw.function.name,
          raw.function.arguments,
          raw.id,
          tools,
        ),
        usage,
      };
    }
    return { content: message?.content ?? '', usage };
  }

  async *completeStream(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): AsyncIterable<LlmStreamChunk> {
    const client = await this.getClient();
    const stream = (await client.chat.completions.create(
      this.buildRequest(input, tools, true),
      // Streaming needs the abort signal MORE than a plain completion does: a
      // stream that is never cancelled holds the connection open for as long as
      // the provider keeps it.
      this.requestOptions(input),
    )) as AsyncIterable<{
      choices?: Array<{
        delta?: { content?: string | null; tool_calls?: OpenAiToolCallDelta[] };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number } | null;
    }>;

    // Tool calls arrive as fragments keyed by `index` — the name lands on the
    // first fragment and the JSON arguments dribble in across many. Accumulate,
    // then emit ONE toolCall chunk at the end so consumers never see a partial.
    const pending = new Map<number, { id?: string; name: string; args: string }>();

    for await (const event of stream) {
      const delta = event.choices?.[0]?.delta;
      if (delta?.content) {
        yield { kind: 'text', text: delta.content };
      }
      for (const part of delta?.tool_calls ?? []) {
        const slot = pending.get(part.index) ?? { name: '', args: '' };
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.name = part.function.name;
        if (part.function?.arguments) slot.args += part.function.arguments;
        pending.set(part.index, slot);
      }
      if (event.usage) {
        yield {
          kind: 'usage',
          usage: {
            promptTokens: event.usage.prompt_tokens,
            completionTokens: event.usage.completion_tokens,
          },
        };
      }
    }

    for (const slot of pending.values()) {
      if (!slot.name) continue;
      yield {
        kind: 'toolCall',
        call: this.toToolCall(slot.name, slot.args, slot.id, tools),
      };
    }
    yield { kind: 'done' };
  }

  /** One request builder for both paths, so they can never drift apart. */
  private buildRequest(
    input: LlmCompletionInput,
    tools: ToolDefinitionDto[] | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model:
        this.config.get<string>('LLM_MODEL')?.trim() || DEFAULT_MODEL,
      temperature: input.temperature ?? 0.2,
      max_completion_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages.map(toOpenAiMessage),
      ],
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
          }
        : {}),
      // Only in plain-text mode: json_object and tool calling are mutually
      // exclusive in practice — a tool call is not a JSON document.
      ...(input.json && !(tools && tools.length > 0)
        ? { response_format: { type: 'json_object' } }
        : {}),
      ...(stream
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
    };
  }

      // NOT in the body. Both SDKs take `signal` in their REQUEST OPTIONS
      // (the second argument); putting it in the payload sends it to the
      // provider as an unknown parameter, and OpenAI answers
      // `400 Unrecognized request argument supplied: signal`.
      //
      // This sat here unexercised until the workflow node timeout started
      // supplying a signal for the first time — the classic shape of a
      // never-called branch: it type-checked, it read correctly, and it had
      // never once run.
  private requestOptions(input: LlmCompletionInput): { signal?: AbortSignal } {
    return input.signal ? { signal: input.signal } : {};
  }

  private toToolCall(
    name: string,
    argsJson: string | undefined,
    callId: string | undefined,
    tools: ToolDefinitionDto[] | undefined,
  ): LlmToolCall {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    } catch {
      // A truncated/garbled argument blob must not crash the turn — the caller
      // validates args and feeds any problem back to the model to self-correct.
      this.logger.warn(`Unparseable tool arguments for "${name}"; using {}`);
      args = {};
    }
    return {
      skillKey: SkillCatalog.resolveSkillKey(name, tools) ?? '',
      tool: name,
      args,
      ...(callId ? { callId } : {}),
    };
  }

  /** Per-request LLM timeout in ms (default 60s), config `LLM_REQUEST_TIMEOUT_MS`. */
  private llmTimeoutMs(): number {
    const raw = Number(this.config.get<string>('LLM_REQUEST_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
  }

  private async getClient(): Promise<OpenAiClient> {
    if (!this.client) {
      const { default: OpenAI } = await import('openai');
      this.client = new OpenAI({
        apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
        // App-level bound so a hung completion cannot stall a run (and, with
        // BullMQ concurrency=1, the whole queue) for the SDK's ~10-min default.
        // Configurable via LLM_REQUEST_TIMEOUT_MS (default 60s).
        timeout: this.llmTimeoutMs(),
        maxRetries: 2,
      }) as unknown as OpenAiClient;
    }
    return this.client;
  }
}

/**
 * Our neutral message → the OpenAI wire shape. A `role:'tool'` turn becomes a
 * real tool message keyed by `tool_call_id`; an assistant turn that requested a
 * tool is replayed with its `tool_calls` so the model sees its own call. This is
 * what makes a multi-step tool loop coherent instead of the old
 * `[[VAEP:TOOL_RESULT]]` text convention.
 */
function toOpenAiMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId ?? '',
      content: m.content,
    };
  }
  if (m.role === 'assistant' && m.toolCall) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: [
        {
          id: m.toolCall.callId ?? '',
          type: 'function',
          function: {
            name: m.toolCall.tool,
            arguments: JSON.stringify(m.toolCall.args ?? {}),
          },
        },
      ],
    };
  }
  return { role: m.role, content: m.content };
}
