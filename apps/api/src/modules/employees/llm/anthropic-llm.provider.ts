import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ToolDefinitionDto } from '@vaep/types';
import { SkillCatalog } from '../../skills/catalog';
import type {
  LlmCompletionInput,
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from './llm.provider';

/**
 * Anthropic provider (`LLM_PROVIDER=anthropic`). Requires `ANTHROPIC_API_KEY`;
 * model from `LLM_MODEL`, defaulting to the current balanced model.
 *
 * Kept deliberately at feature parity with the OpenAI provider — same streaming
 * contract, same native tool-result threading, same configurable output cap — so
 * switching between them really is only `LLM_PROVIDER=`. If one provider grows a
 * capability the other lacks, the gap belongs in `LlmProvider` as an optional
 * method (like `completeStream`), never as a caller-visible special case.
 *
 * Verified against platform docs 2026-08-02: Messages API, `tool_use` /
 * `tool_result` content blocks keyed by `tool_use.id`, `messages.stream()`.
 */

/** Best speed/intelligence balance in the current family; override with `LLM_MODEL`. */
const DEFAULT_MODEL = 'claude-sonnet-5';
/** Was hardcoded at 1024 — too small for a structured answer like a graph. */
const DEFAULT_MAX_TOKENS = 4096;

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
};

interface AnthropicClient {
  messages: {
    // Second argument = RequestOptions (`signal`), not payload.
    create(
      args: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{
      content: ContentBlock[];
      usage?: { input_tokens: number; output_tokens: number };
    }>;
    stream(
      args: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<AnthropicStreamEvent> & {
      finalMessage(): Promise<{
        content: ContentBlock[];
        usage?: { input_tokens: number; output_tokens: number };
      }>;
    };
  };
}

type AnthropicStreamEvent = {
  type: string;
  delta?: { type?: string; text?: string };
};

@Injectable()
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: AnthropicClient | null = null;

  constructor(private readonly config: ConfigService) {}

  async complete(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): Promise<LlmCompletionResult> {
    const client = await this.getClient();
    const res = await client.messages.create(
      this.buildRequest(input, tools),
      this.requestOptions(input),
    );

    const usage = res.usage
      ? {
          promptTokens: res.usage.input_tokens,
          completionTokens: res.usage.output_tokens,
        }
      : undefined;

    // Prefer a tool call when the model requested one.
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    if (toolUse?.name) {
      return {
        toolCall: {
          skillKey: SkillCatalog.resolveSkillKey(toolUse.name, tools) ?? '',
          tool: toolUse.name,
          args: toolUse.input ?? {},
          ...(toolUse.id ? { callId: toolUse.id } : {}),
        },
        usage,
      };
    }

    return { content: textOf(res.content), usage };
  }

  async *completeStream(
    input: LlmCompletionInput,
    tools?: ToolDefinitionDto[],
  ): AsyncIterable<LlmStreamChunk> {
    const client = await this.getClient();
    const stream = client.messages.stream(
      this.buildRequest(input, tools),
      this.requestOptions(input),
    );

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        event.delta.text
      ) {
        yield { kind: 'text', text: event.delta.text };
      }
    }

    // Tool-call arguments stream as partial JSON; rather than reassemble them by
    // hand, take the SDK's assembled final message — it is the same data,
    // already validated, and avoids a second fragile accumulator.
    const final = await stream.finalMessage();
    const toolUse = final.content.find((b) => b.type === 'tool_use');
    if (toolUse?.name) {
      yield {
        kind: 'toolCall',
        call: {
          skillKey: SkillCatalog.resolveSkillKey(toolUse.name, tools) ?? '',
          tool: toolUse.name,
          args: toolUse.input ?? {},
          ...(toolUse.id ? { callId: toolUse.id } : {}),
        },
      };
    }
    if (final.usage) {
      yield {
        kind: 'usage',
        usage: {
          promptTokens: final.usage.input_tokens,
          completionTokens: final.usage.output_tokens,
        },
      };
    }
    yield { kind: 'done' };
  }

  /** One request builder for both paths, so they can never drift apart. */
  private buildRequest(
    input: LlmCompletionInput,
    tools: ToolDefinitionDto[] | undefined,
  ): Record<string, unknown> {
    return {
      model: this.config.get<string>('LLM_MODEL')?.trim() || DEFAULT_MODEL,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: input.temperature ?? 0.2,
      system: input.system,
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      messages: toAnthropicMessages(input.messages),
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

  /** Per-request LLM timeout in ms (default 60s), config `LLM_REQUEST_TIMEOUT_MS`. */
  private llmTimeoutMs(): number {
    const raw = Number(this.config.get<string>('LLM_REQUEST_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
  }

  private async getClient(): Promise<AnthropicClient> {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({
        apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY'),
        // App-level bound so a hung completion cannot stall a run/queue for the
        // SDK's long default. Configurable via LLM_REQUEST_TIMEOUT_MS (default 60s).
        timeout: this.llmTimeoutMs(),
        maxRetries: 2,
      }) as unknown as AnthropicClient;
    }
    return this.client;
  }
}

function textOf(blocks: ContentBlock[]): string {
  return blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
}

/**
 * Our neutral messages → Anthropic's shape. Anthropic has no `tool` role: a tool
 * RESULT is a `tool_result` content block inside a USER message, keyed by the
 * originating `tool_use.id`. Consecutive tool results merge into one user
 * message, which is what the API expects for parallel calls.
 */
function toAnthropicMessages(
  messages: LlmMessage[],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'assistant' && m.toolCall) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      blocks.push({
        type: 'tool_use',
        id: m.toolCall.callId ?? '',
        name: m.toolCall.tool,
        input: m.toolCall.args ?? {},
      });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({ role: m.role, content: m.content });
  }

  return out;
}
