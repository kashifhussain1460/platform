import { z } from 'zod';
import {
  AssistToolRegistry,
  type AssistTool,
  type AssistToolContext,
  params,
} from './assist-tool-registry';

const ctx: AssistToolContext = {
  companyId: 'co_1',
  userId: 'u_1',
  sessionId: 's_1',
};

function makeTool(overrides: Partial<AssistTool<{ n: number }>> = {}) {
  const tool: AssistTool<{ n: number }> = {
    name: 'double',
    description: 'Double a number.',
    schema: z.object({ n: z.number().int().min(0) }),
    parameters: params({ n: { type: 'number' } }, ['n']),
    run: (_c, args) =>
      Promise.resolve({ ok: true, summary: `Doubled ${args.n}`, result: { out: args.n * 2 } }),
    ...overrides,
  };
  return tool as unknown as AssistTool<never>;
}

describe('AssistToolRegistry', () => {
  it('projects tools into provider definitions', () => {
    const registry = new AssistToolRegistry([makeTool()]);
    expect(registry.definitions()).toEqual([
      {
        name: 'double',
        description: 'Double a number.',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      },
    ]);
  });

  it('runs a valid call', async () => {
    const registry = new AssistToolRegistry([makeTool()]);
    const out = await registry.dispatch(ctx, 'double', { n: 4 });
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ out: 8 });
  });

  // The three failure paths all RETURN rather than throw. That is the point:
  // a bad tool call is a correction the model can act on, not a dead turn.
  it('returns a correctable error for bad arguments instead of throwing', async () => {
    const registry = new AssistToolRegistry([makeTool()]);
    const out = await registry.dispatch(ctx, 'double', { n: 'four' });
    expect(out.ok).toBe(false);
    expect(String((out.result as { error: string }).error)).toMatch(/not valid/i);
    // The message must name the offending field so the model can fix it.
    expect(String((out.result as { error: string }).error)).toContain('n');
  });

  it('returns a correctable error for an unknown tool, listing the real ones', async () => {
    const registry = new AssistToolRegistry([makeTool()]);
    const out = await registry.dispatch(ctx, 'triple', {});
    expect(out.ok).toBe(false);
    expect(String((out.result as { error: string }).error)).toContain('double');
  });

  it('contains a throwing tool rather than letting it kill the turn', async () => {
    const registry = new AssistToolRegistry([
      makeTool({
        run: () => {
          throw new Error('database on fire');
        },
      }),
    ]);
    const out = await registry.dispatch(ctx, 'double', { n: 1 });
    expect(out.ok).toBe(false);
    expect(String((out.result as { error: string }).error)).toContain('database on fire');
  });

  it('reports which tools end the turn', () => {
    const registry = new AssistToolRegistry([
      makeTool(),
      makeTool({ name: 'finish', terminal: true }),
    ]);
    expect(registry.isTerminal('finish')).toBe(true);
    expect(registry.isTerminal('double')).toBe(false);
    expect(registry.isTerminal('nope')).toBe(false);
  });
});
