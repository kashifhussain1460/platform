import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeType } from '@vaep/types';
import { NodeRegistry, UnknownNodeTypeError } from './node-registry.service';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './nodes/node-handler';
import { NODE_HANDLER_PROVIDERS } from './nodes';

const stub = (type: NodeType, output: unknown = {}): NodeHandler => ({
  type,
  execute: (_ctx: NodeExecContext): NodeResult => ({ output }),
});

describe('NodeRegistry (P1-03)', () => {
  it('registers every handler it is given and lists them sorted', () => {
    const registry = new NodeRegistry([stub('WAIT'), stub('CONDITION')]);
    registry.onModuleInit();

    expect(registry.list()).toEqual(['CONDITION', 'WAIT']);
    expect(registry.has('WAIT')).toBe(true);
    expect(registry.has('AI_STEP')).toBe(false);
  });

  it('dispatches to the handler registered for a type', async () => {
    const registry = new NodeRegistry([stub('NOTIFY', { message: 'hi' })]);
    registry.onModuleInit();

    const result = await registry.get('NOTIFY').execute({
      companyId: 'c1',
      workflowId: 'wf1',
      runId: 'r1',
      node: { id: 'n1', type: 'NOTIFY', config: {} },
      context: {},
      dryRun: false,
    });
    expect(result.output).toEqual({ message: 'hi' });
  });

  it('throws a TYPED error for an unregistered type, not a generic crash', () => {
    const registry = new NodeRegistry([stub('WAIT')]);
    registry.onModuleInit();

    // Typed so the engine can classify it as a non-retryable VALIDATION_ERROR
    // rather than retrying an unknown node forever.
    expect(() => registry.get('AI_STEP')).toThrow(UnknownNodeTypeError);
    expect(() => registry.get('AI_STEP')).toThrow('Unknown node type: AI_STEP');
  });

  it('rejects a duplicate registration instead of silently shadowing', () => {
    const registry = new NodeRegistry([stub('WAIT'), stub('WAIT')]);
    // Two handlers claiming one type is a wiring bug; the second must not win
    // silently, because which one runs would then depend on provider order.
    expect(() => registry.onModuleInit()).toThrow(
      'Duplicate node handler registered for "WAIT"',
    );
  });

  it('ships a handler for every node type except AI_EMPLOYEE_STEP', () => {
    // 19 declared types (doc 00 §0.7.1) minus AI_EMPLOYEE_STEP, which is
    // provided by EmployeesModule and registers itself — WorkflowsModule cannot
    // import EmployeesModule without closing the
    // Approvals→Workflows→Employees→Approvals cycle.
    expect(NODE_HANDLER_PROVIDERS).toHaveLength(18);

    const covered = new Set(NODE_HANDLER_PROVIDERS.map((h) => h.name));
    expect(covered.size).toBe(NODE_HANDLER_PROVIDERS.length);
  });

  /**
   * The architectural invariant of doc 26 §9: the engine resolves handlers and
   * must never branch on the node type. If someone reintroduces a
   * `switch (node.type)` the registry becomes decorative and "add a node
   * without touching the engine" silently stops being true — so assert it.
   */
  it('WorkflowEngine contains no switch on node.type', () => {
    const source = readFileSync(
      join(__dirname, 'workflow-engine.service.ts'),
      'utf-8',
    );
    // Comments are stripped first: the engine legitimately DOCUMENTS the
    // `switch (node.type)` it replaced, and matching that prose would make this
    // test fail on an explanation rather than on real code.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/switch\s*\(\s*node\.type\s*\)/);
    expect(code).not.toMatch(/switch\s*\(\s*current\.type\s*\)/);
    // No type branching on the DISPATCH path — that is the registry's job.
    expect(code).not.toMatch(/if\s*\(\s*node\.type\s*===/);
  });

  /**
   * Two type checks legitimately remain, both in the RUN LOOP rather than the
   * dispatch path, because a handler cannot pause a run — it can only return a
   * result:
   *
   *   • `current.type === 'APPROVAL'`    → pause before dispatching
   *   • `current.type === 'TOOL_ACTION'` → the G25 approval gate
   *
   * Doc 26 §4 anticipates this with `NodeContract.pausesRun` / `hasSideEffect`,
   * so the follow-up is to key both off handler CAPABILITIES instead of the
   * type. Pinned at exactly two so a third cannot be added quietly, and so this
   * known deviation is visible rather than implied.
   */
  it('has exactly the two documented run-loop type checks, no more', () => {
    const source = readFileSync(
      join(__dirname, 'workflow-engine.service.ts'),
      'utf-8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const checks = code.match(/current\.type\s*===\s*'[A-Z_]+'/g) ?? [];
    expect(checks.sort()).toEqual([
      "current.type === 'APPROVAL'",
      "current.type === 'TOOL_ACTION'",
    ]);
  });
});
