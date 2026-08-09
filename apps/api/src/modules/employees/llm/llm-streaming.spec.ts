import type { ToolDefinitionDto } from '@vaep/types';
import { MockLlmProvider } from './mock-llm.provider';
import {
  type LlmCompletionInput,
  type LlmCompletionResult,
  type LlmProvider,
  type LlmStreamChunk,
  streamOrComplete,
} from './llm.provider';

async function drain(it: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const textOf = (chunks: LlmStreamChunk[]): string =>
  chunks.filter((c) => c.kind === 'text').map((c) => (c as { text: string }).text).join('');

describe('LLM streaming contract', () => {
  const input: LlmCompletionInput = {
    system: 'You are a test.',
    messages: [{ role: 'user', content: 'Tell me about the refund policy please.' }],
  };

  describe('MockLlmProvider.completeStream', () => {
    const provider = new MockLlmProvider();

    it('streams the same text the non-streaming call returns', async () => {
      const chunks = await drain(provider.completeStream(input));
      const direct = await provider.complete(input);
      expect(textOf(chunks)).toBe(direct.content);
    });

    it('emits more than one text chunk, then usage, then exactly one done', async () => {
      const chunks = await drain(provider.completeStream(input));
      expect(chunks.filter((c) => c.kind === 'text').length).toBeGreaterThan(1);
      expect(chunks.filter((c) => c.kind === 'usage')).toHaveLength(1);
      expect(chunks.filter((c) => c.kind === 'done')).toHaveLength(1);
      // `done` is always last — consumers rely on it to close the stream.
      expect(chunks[chunks.length - 1].kind).toBe('done');
    });

    it('emits a single toolCall chunk (never partial) when the model calls a tool', async () => {
      const tools: ToolDefinitionDto[] = [
        {
          name: 'send_message',
          description: 'Send a message to a Slack channel.',
          parameters: {
            type: 'object',
            properties: { channel: { type: 'string' }, text: { type: 'string' } },
            required: ['channel', 'text'],
          },
          skillKey: 'slack',
        },
      ];
      const chunks = await drain(
        provider.completeStream(
          { system: 'act', messages: [{ role: 'user', content: 'send a slack message' }] },
          tools,
        ),
      );
      const calls = chunks.filter((c) => c.kind === 'toolCall');
      expect(calls).toHaveLength(1);
      expect((calls[0] as { call: { skillKey: string } }).call.skillKey).toBe('slack');
    });
  });

  describe('streamOrComplete fallback', () => {
    // A provider WITHOUT completeStream — the honest degrade path every consumer
    // gets for free rather than each one re-inventing it.
    const legacy: LlmProvider = {
      name: 'legacy',
      complete: (): Promise<LlmCompletionResult> =>
        Promise.resolve({
          content: 'one shot answer',
          usage: { promptTokens: 3, completionTokens: 4 },
        }),
    };

    it('emits the whole answer as one chunk and still terminates with done', async () => {
      const chunks = await drain(streamOrComplete(legacy, input));
      expect(textOf(chunks)).toBe('one shot answer');
      expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(1);
      expect(chunks[chunks.length - 1].kind).toBe('done');
    });

    it('prefers completeStream when the provider has it', async () => {
      const chunks = await drain(streamOrComplete(new MockLlmProvider(), input));
      expect(chunks.filter((c) => c.kind === 'text').length).toBeGreaterThan(1);
    });

    it('passes a tool call straight through from a non-streaming provider', async () => {
      const toolOnly: LlmProvider = {
        name: 'legacy-tool',
        complete: (): Promise<LlmCompletionResult> =>
          Promise.resolve({
            toolCall: { skillKey: 'slack', tool: 'send_message', args: { channel: '#x' } },
          }),
      };
      const chunks = await drain(streamOrComplete(toolOnly, input));
      expect(chunks.filter((c) => c.kind === 'toolCall')).toHaveLength(1);
      expect(chunks.filter((c) => c.kind === 'text')).toHaveLength(0);
    });
  });
});
