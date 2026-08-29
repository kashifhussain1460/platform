import { ConfigService } from '@nestjs/config';
import { OpenAiLlmProvider } from './openai-llm.provider';

/**
 * Production outage 2026-08-29: every AI Assist workflow generation failed with
 *
 *   400 Function tools with reasoning_effort are not supported for
 *   gpt-5.6-terra in /v1/chat/completions.
 *
 * A reasoning model applies a non-none `reasoning_effort` by default and
 * refuses it next to function tools. Sending `reasoning_effort: 'none'` fixes
 * that model — and BREAKS the others: gpt-4.1-mini and gpt-4o-mini both answer
 * `400 Unrecognized request argument supplied: reasoning_effort`. All four
 * responses were verified against the live API before this was written.
 *
 * So the parameter cannot be sent unconditionally, and a hardcoded list of
 * "reasoning models" is what this file's own rule forbids. The provider learns
 * from the API instead; these tests pin that it learns the RIGHT thing and
 * remembers it.
 */
describe('OpenAiLlmProvider — reasoning_effort/tools compatibility', () => {
  const TOOLS = [
    { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } },
  ] as never;

  const reply = {
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  /** Builds a provider whose HTTP client is a scripted fake. */
  function build(model: string, behaviour: (args: Record<string, unknown>) => unknown) {
    const calls: Array<Record<string, unknown>> = [];
    const create = jest.fn(async (args: Record<string, unknown>) => {
      calls.push(args);
      return behaviour(args);
    });
    const config = { get: (k: string) => (k === 'LLM_MODEL' ? model : undefined) };
    const provider = new OpenAiLlmProvider(config as unknown as ConfigService);
    // Bypass the lazy SDK import; the seam under test is request shaping.
    (provider as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };
    (provider as unknown as { getClient: () => unknown }).getClient = async () =>
      (provider as unknown as { client: unknown }).client;
    return { provider, calls };
  }

  const REASONING_MODEL_ERROR = new Error(
    '400 Function tools with reasoning_effort are not supported for gpt-5.6-terra ' +
      "in /v1/chat/completions. To use function tools, use /v1/responses or set " +
      "reasoning_effort to 'none'.",
  );

  const input = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('retries with reasoning_effort:none when the model demands it', async () => {
    let first = true;
    const { provider, calls } = build('gpt-5.6-terra', () => {
      if (first) {
        first = false;
        throw REASONING_MODEL_ERROR;
      }
      return reply;
    });

    const res = await provider.complete(input, TOOLS);

    expect(res.content).toBe('hi');
    expect(calls).toHaveLength(2);
    expect(calls[0].reasoning_effort).toBeUndefined();
    expect(calls[1].reasoning_effort).toBe('none');
  });

  it('remembers, so the rejected request happens once per process', async () => {
    let first = true;
    const { provider, calls } = build('gpt-5.6-terra', () => {
      if (first) {
        first = false;
        throw REASONING_MODEL_ERROR;
      }
      return reply;
    });

    await provider.complete(input, TOOLS);
    await provider.complete(input, TOOLS);
    await provider.complete(input, TOOLS);

    // 2 for the first call (probe + retry), then 1 each — not 2 each.
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).every((c) => c.reasoning_effort === 'none')).toBe(true);
  });

  it('NEVER sends the parameter to a model that accepts tools without it', async () => {
    // The regression that would break gpt-4.1-mini / gpt-4o-mini, which reject
    // `reasoning_effort` outright.
    const { provider, calls } = build('gpt-4.1-mini', () => reply);

    await provider.complete(input, TOOLS);
    await provider.complete(input, TOOLS);

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => !('reasoning_effort' in c))).toBe(true);
  });

  it('leaves tool-free requests completely alone', async () => {
    // The conflict only exists when tools are present, so the plain chat path
    // must not pay a probe or change shape.
    const { provider, calls } = build('gpt-5.6-terra', () => reply);

    await provider.complete(input);

    expect(calls).toHaveLength(1);
    expect(calls[0].reasoning_effort).toBeUndefined();
    expect(calls[0].tools).toBeUndefined();
  });

  it('propagates an unrelated 400 instead of blaming reasoning_effort', async () => {
    const other = new Error('400 Unrecognized request argument supplied: signal');
    const { provider, calls } = build('gpt-5.6-terra', () => {
      throw other;
    });

    await expect(provider.complete(input, TOOLS)).rejects.toThrow(/signal/);
    expect(calls).toHaveLength(1); // no pointless retry
  });
});
