import type { NodeType, WorkflowNode } from '@vaep/types';
import {
  SetVariableNodeHandler,
  TransformNodeHandler,
} from './data.handlers';
import {
  JoinNodeHandler,
  LoopNodeHandler,
  NoopNodeHandler,
  ParallelNodeHandler,
  SwitchNodeHandler,
  TerminateNodeHandler,
} from './logic.handlers';
import type { NodeExecContext, NodeResult } from './node-handler';

const ctx = (
  type: NodeType,
  config: Record<string, unknown>,
  context: Record<string, unknown> = {},
): NodeExecContext => ({
  companyId: 'c1',
  workflowId: 'wf1',
  runId: 'r1',
  node: { id: 'n1', type, config } as WorkflowNode,
  context,
  dryRun: false,
});

const sync = (r: Promise<NodeResult> | NodeResult): NodeResult => r as NodeResult;

describe('P2 logic handlers', () => {
  describe('SWITCH', () => {
    const handler = new SwitchNodeHandler();

    it('selects the matching case branch', () => {
      const result = sync(
        handler.execute(
          ctx(
            'SWITCH',
            {
              on: '{{band}}',
              cases: [
                { value: 'strong', branch: 'advance' },
                { value: 'weak', branch: 'reject' },
              ],
            },
            { band: 'weak' },
          ),
        ),
      );
      expect(result.branch).toBe('reject');
    });

    it('coerces to string so 1 and "1" match', () => {
      // An author writing `1` against a context value of '1' must match, or the
      // behaviour is baffling to debug.
      const result = sync(
        handler.execute(
          ctx('SWITCH', { on: '{{score}}', cases: [{ value: 1, branch: 'one' }] }, { score: 1 }),
        ),
      );
      expect(result.branch).toBe('one');
    });

    it('falls back to the default branch', () => {
      const result = sync(
        handler.execute(
          ctx('SWITCH', { on: '{{x}}', cases: [{ value: 'a', branch: 'A' }], default: 'other' }, { x: 'zzz' }),
        ),
      );
      expect(result.branch).toBe('other');
    });

    it('throws when nothing matches and no default is configured', () => {
      // Silently picking an arbitrary edge would run the WRONG downstream steps
      // with no error anywhere.
      expect(() =>
        handler.execute(
          ctx('SWITCH', { on: '{{x}}', cases: [{ value: 'a', branch: 'A' }] }, { x: 'zzz' }),
        ),
      ).toThrow(/no case matched and no default/);
    });
  });

  describe('TERMINATE', () => {
    const handler = new TerminateNodeHandler();

    it('ends the run COMPLETED by default', () => {
      const result = sync(handler.execute(ctx('TERMINATE', {})));
      expect(result.terminate).toEqual({ status: 'COMPLETED', reason: undefined });
    });

    it('can end the run FAILED with a templated reason', () => {
      const result = sync(
        handler.execute(
          ctx('TERMINATE', { status: 'FAILED', reason: 'bad {{why}}' }, { why: 'input' }),
        ),
      );
      expect(result.terminate).toEqual({ status: 'FAILED', reason: 'bad input' });
    });
  });

  it('NOOP does nothing and succeeds', () => {
    expect(sync(new NoopNodeHandler().execute(ctx('NOOP', {}))).output).toEqual({
      noop: true,
    });
  });

  describe('PARALLEL', () => {
    const handler = new ParallelNodeHandler();

    it('returns a fanOut directive with its lanes and join', () => {
      const r = sync(
        handler.execute(ctx('PARALLEL', { lanes: ['l1', 'l2'], joinNodeId: 'j' })),
      );
      expect(r.fanOut).toEqual({ lanes: ['l1', 'l2'], joinNodeId: 'j', mode: 'ALL' });
    });

    it('honours ANY mode', () => {
      const r = sync(
        handler.execute(
          ctx('PARALLEL', { lanes: ['l1', 'l2'], joinNodeId: 'j', mode: 'ANY' }),
        ),
      );
      expect(r.fanOut?.mode).toBe('ANY');
    });

    it('refuses to fan out with no join — lanes would never converge', () => {
      expect(() => handler.execute(ctx('PARALLEL', { lanes: ['l1'] }))).toThrow(
        /no joinNodeId/,
      );
    });

    it('refuses to fan out with no lanes', () => {
      expect(() => handler.execute(ctx('PARALLEL', { joinNodeId: 'j' }))).toThrow(
        /declares no lanes/,
      );
    });
  });

  describe('JOIN', () => {
    it('exposes which lanes arrived', () => {
      const r = sync(
        new JoinNodeHandler().execute(
          ctx('JOIN', {}, { __lanes: { l1: { completed: true }, l2: { completed: true } } }),
        ),
      );
      expect((r.output as { arrived: number }).arrived).toBe(2);
    });
  });

  describe('LOOP', () => {
    const handler = new LoopNodeHandler();

    it('returns an iterate directive over the resolved array', () => {
      const r = sync(
        handler.execute(
          ctx(
            'LOOP',
            { over: 'items', itemVar: 'row', body: 'b', maxIterations: 10 },
            { items: [1, 2, 3] },
          ),
        ),
      );
      expect(r.iterate?.items).toEqual([1, 2, 3]);
      expect(r.iterate?.itemVar).toBe('row');
      expect(r.iterate?.bodyNodeId).toBe('b');
    });

    it('truncates to maxIterations rather than running unbounded', () => {
      const r = sync(
        handler.execute(
          ctx('LOOP', { over: 'items', body: 'b', maxIterations: 2 }, { items: [1, 2, 3, 4] }),
        ),
      );
      expect(r.iterate?.items).toHaveLength(2);
      expect((r.output as { truncated: boolean }).truncated).toBe(true);
    });

    it('rejects a missing or non-positive maxIterations', () => {
      expect(() =>
        handler.execute(ctx('LOOP', { over: 'items', body: 'b' }, { items: [] })),
      ).toThrow(/positive maxIterations/);
    });

    it('rejects a non-array target instead of silently iterating nothing', () => {
      expect(() =>
        handler.execute(
          ctx('LOOP', { over: 'items', body: 'b', maxIterations: 5 }, { items: 'nope' }),
        ),
      ).toThrow(/not an array/);
    });
  });
});

describe('P2 data handlers', () => {
  describe('SET_VARIABLE', () => {
    // Only RUNTIME scope is exercised here, which never touches the database —
    // WORKFLOW/OUTPUT persistence is covered by the e2e suite.
    const prisma = { workflowVariable: { upsert: jest.fn() } };
    const handler = new SetVariableNodeHandler(
      prisma as unknown as ConstructorParameters<typeof SetVariableNodeHandler>[0],
    );

    it('stores a templated value into the run context', async () => {
      const result = await handler.execute(
        ctx('SET_VARIABLE', { name: 'greeting', value: 'hi {{who}}' }, { who: 'bob' }),
      );
      expect(result.contextValue).toBe('hi bob');
      // RUNTIME scope must NOT hit the database — it belongs to one run.
      expect(prisma.workflowVariable.upsert).not.toHaveBeenCalled();
    });

    it('coerces to the declared type', async () => {
      const result = await handler.execute(
        ctx('SET_VARIABLE', { name: 'n', value: '42', type: 'number' }),
      );
      expect(result.contextValue).toBe(42);
    });

    it('PERSISTS a WORKFLOW-scope variable so it outlives the run', async () => {
      await handler.execute(
        ctx('SET_VARIABLE', { name: 'quota', value: '5', type: 'number', scope: 'WORKFLOW' }),
      );
      // Without this write a "workflow variable" would vanish when the run ended.
      expect(prisma.workflowVariable.upsert).toHaveBeenCalledTimes(1);
    });

    it('rejects a real type mismatch instead of writing NaN', async () => {
      // `execute` is async now (WORKFLOW scope persists), so the assertion has
      // to await the rejection — a sync `toThrow` would silently pass.
      await expect(
        handler.execute(
          ctx('SET_VARIABLE', { name: 'n', value: 'around 85', type: 'number' }),
        ),
      ).rejects.toThrow(/expected a number/);
    });

    it.each(['SECRET', 'ENVIRONMENT', 'INPUT', 'GLOBAL'])(
      'refuses to write the read-only %s scope',
      async (scope) => {
        await expect(
          handler.execute(ctx('SET_VARIABLE', { name: 'x', value: 'y', scope })),
        ).rejects.toThrow(/read-only/);
      },
    );

    it('requires a name', async () => {
      await expect(
        handler.execute(ctx('SET_VARIABLE', { value: 'x' })),
      ).rejects.toThrow(/no variable name/);
    });
  });

  describe('TRANSFORM', () => {
    const handler = new TransformNodeHandler();

    it('maps then joins an array', () => {
      const result = sync(
        handler.execute(
          ctx(
            'TRANSFORM',
            {
              input: 'people',
              operations: [
                { op: 'map', field: 'name' },
                { op: 'join', separator: ' & ' },
              ],
            },
            { people: [{ name: 'Ann' }, { name: 'Bo' }] },
          ),
        ),
      );
      expect(result.contextValue).toBe('Ann & Bo');
    });

    it('filters by field equality', () => {
      const result = sync(
        handler.execute(
          ctx(
            'TRANSFORM',
            { input: 'rows', operations: [{ op: 'filter', field: 'ok', equals: true }] },
            { rows: [{ ok: true }, { ok: false }] },
          ),
        ),
      );
      expect(result.contextValue).toEqual([{ ok: true }]);
    });

    it('applies `default` only for null/empty', () => {
      const filled = sync(
        handler.execute(
          ctx('TRANSFORM', { input: 'v', operations: [{ op: 'default', value: 'fallback' }] }, { v: 'set' }),
        ),
      );
      expect(filled.contextValue).toBe('set');

      const empty = sync(
        handler.execute(
          ctx('TRANSFORM', { input: 'missing', operations: [{ op: 'default', value: 'fallback' }] }, {}),
        ),
      );
      expect(empty.contextValue).toBe('fallback');
    });

    it('rejects an operation outside the closed set', () => {
      // The set is closed on purpose — an expression evaluator would be remote
      // code execution inside a multi-tenant runtime.
      expect(() =>
        handler.execute(
          ctx('TRANSFORM', { input: 'v', operations: [{ op: 'eval' }] }, { v: 1 }),
        ),
      ).toThrow(/unsupported operation "eval"/);
    });

    it('refuses to treat a non-array as an array', () => {
      expect(() =>
        handler.execute(
          ctx('TRANSFORM', { input: 'v', operations: [{ op: 'join' }] }, { v: 'nope' }),
        ),
      ).toThrow(/expected an array/);
    });

    it('throws rather than producing NaN from toNumber', () => {
      expect(() =>
        handler.execute(
          ctx('TRANSFORM', { input: 'v', operations: [{ op: 'toNumber' }] }, { v: 'abc' }),
        ),
      ).toThrow(/expected a number/);
    });
  });
});
