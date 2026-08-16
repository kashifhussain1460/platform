import type { WorkflowDefinition } from '@vaep/types';
import {
  collectDefinitionIssues,
  validateDefinitionStructure,
} from './definition-validator';

const def = (
  nodes: WorkflowDefinition['nodes'],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition => ({ nodes, edges });

const codes = (d: WorkflowDefinition) =>
  collectDefinitionIssues(d).map((i) => i.code);

describe('definition validator — P2 rules', () => {
  it('keeps a lone-TRIGGER starter graph valid (backwards compatibility)', () => {
    // STARTER_DEFINITION is exactly this. It must never become invalid.
    expect(codes(def([{ id: 'trigger', type: 'TRIGGER', config: {} }]))).toEqual([]);
  });

  it('reports EVERY problem at once, not just the first', () => {
    const issues = collectDefinitionIssues(
      def(
        [
          { id: 'a', type: 'TRIGGER', config: {} },
          { id: 'a', type: 'NOTIFY', config: {} },
          { id: 'b', type: 'SET_VARIABLE', config: {} },
        ],
        [{ from: 'a', to: 'ghost' }],
      ),
    );
    // A 30-node graph fixed one error per request is unusable.
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'DUPLICATE_NODE_ID',
        'UNKNOWN_EDGE_TARGET',
        'INVALID_CONFIG',
      ]),
    );
  });

  it('accepts a correctly wired PARALLEL + JOIN', () => {
    expect(
      codes(
        def(
          [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'p', type: 'PARALLEL', config: { lanes: ['a', 'b'], joinNodeId: 'j' } },
            { id: 'a', type: 'NOOP', config: {} },
            { id: 'b', type: 'NOOP', config: {} },
            { id: 'j', type: 'JOIN', config: {} },
          ],
          [
            { from: 't', to: 'p' },
            { from: 'a', to: 'j' },
            { from: 'b', to: 'j' },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it('rejects a PARALLEL with no JOIN', () => {
    expect(
      codes(
        def([
          { id: 'p', type: 'PARALLEL', config: { lanes: ['a'] } },
          { id: 'a', type: 'NOOP', config: {} },
        ]),
      ),
    ).toContain('UNJOINED_PARALLEL');
  });

  it('rejects a nested PARALLEL', () => {
    expect(
      codes(
        def([
          { id: 'p', type: 'PARALLEL', config: { lanes: ['p2'], joinNodeId: 'j' } },
          { id: 'p2', type: 'PARALLEL', config: { lanes: ['a'], joinNodeId: 'j' } },
          { id: 'a', type: 'NOOP', config: {} },
          { id: 'j', type: 'JOIN', config: {} },
        ]),
      ),
    ).toContain('NESTED_PARALLEL');
  });

  it('rejects an unbounded LOOP', () => {
    expect(
      codes(
        def([
          { id: 'l', type: 'LOOP', config: { over: 'items', body: 'b' } },
          { id: 'b', type: 'NOOP', config: {} },
        ]),
      ),
    ).toContain('UNBOUNDED_LOOP');
  });

  it('rejects an APPROVAL inside a LOOP body', () => {
    // It would ask a human once per iteration — always a mistake.
    expect(
      codes(
        def(
          [
            { id: 'l', type: 'LOOP', config: { over: 'i', body: 'b', maxIterations: 3 } },
            { id: 'b', type: 'NOOP', config: {} },
            { id: 'ap', type: 'APPROVAL', config: {} },
          ],
          [{ from: 'b', to: 'ap' }],
        ),
      ),
    ).toContain('INCOMPATIBLE_PLACEMENT');
  });

  it('detects a cycle that is not a LOOP body', () => {
    expect(
      codes(
        def(
          [
            { id: 'a', type: 'NOOP', config: {} },
            { id: 'b', type: 'NOOP', config: {} },
          ],
          [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        ),
      ),
    ).toContain('CYCLE_DETECTED');
  });

  it('allows a LOOP body to loop back to its LOOP node', () => {
    expect(
      codes(
        def(
          [
            { id: 'l', type: 'LOOP', config: { over: 'i', body: 'b', maxIterations: 3 } },
            { id: 'b', type: 'NOOP', config: {} },
          ],
          [
            { from: 'l', to: 'b' },
            { from: 'b', to: 'l' },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it('rejects a graph above the node cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      type: 'NOOP' as const,
      config: {},
    }));
    expect(codes(def(many))).toContain('GRAPH_TOO_LARGE');
  });

  it('rejects more than one TRIGGER', () => {
    expect(
      codes(
        def([
          { id: 't1', type: 'TRIGGER', config: {} },
          { id: 't2', type: 'TRIGGER', config: {} },
        ]),
      ),
    ).toContain('SINGLE_TRIGGER_REQUIRED');
  });

  it('rejects an incoming edge into the TRIGGER', () => {
    expect(
      codes(
        def(
          [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'n', type: 'NOOP', config: {} },
          ],
          [{ from: 'n', to: 't' }],
        ),
      ),
    ).toContain('TRIGGER_NOT_ENTRY');
  });

  it('rejects an inline secret in node config', () => {
    // Node config is persisted verbatim into the immutable version JSON, which
    // surfaces in run history and DLQ dumps.
    for (const key of ['apiKey', 'password', 'access_token', 'clientSecret']) {
      expect(
        codes(def([{ id: 'n', type: 'TOOL_ACTION', config: { [key]: 'hunter2' } }])),
      ).toContain('INLINE_SECRET_FORBIDDEN');
    }
  });

  it('does not flag an innocent config key as a secret', () => {
    expect(
      codes(def([{ id: 'n', type: 'TOOL_ACTION', config: { tokenizer: 'x' } }])),
    ).not.toContain('INLINE_SECRET_FORBIDDEN');
  });

  it('rejects a SWITCH branch with no matching edge', () => {
    expect(
      codes(
        def(
          [
            { id: 's', type: 'SWITCH', config: { on: '{{x}}', cases: [{ value: 'a', branch: 'A' }] } },
            { id: 'n', type: 'NOOP', config: {} },
          ],
          [{ from: 's', to: 'n' }],
        ),
      ),
    ).toContain('MISSING_BRANCH_EDGE');
  });

  it('accepts a SWITCH whose branches all have edges', () => {
    expect(
      codes(
        def(
          [
            { id: 's', type: 'SWITCH', config: { on: '{{x}}', cases: [{ value: 'a', branch: 'A' }] } },
            { id: 'n', type: 'NOOP', config: {} },
          ],
          [{ from: 's', to: 'n', branch: 'A' }],
        ),
      ),
    ).toEqual([]);
  });

  it('rejects SET_VARIABLE writing a read-only scope', () => {
    expect(
      codes(
        def([{ id: 'v', type: 'SET_VARIABLE', config: { name: 'x', scope: 'SECRET' } }]),
      ),
    ).toContain('READ_ONLY_SCOPE');
  });

  it('rejects TERMINATE with an outgoing edge', () => {
    expect(
      codes(
        def(
          [
            { id: 't', type: 'TERMINATE', config: {} },
            { id: 'n', type: 'NOOP', config: {} },
          ],
          [{ from: 't', to: 'n' }],
        ),
      ),
    ).toContain('TERMINATE_HAS_OUTGOING_EDGE');
  });

  it('requires employeeId/instruction on AI_EMPLOYEE_STEP', () => {
    // The missing employee has its OWN code so a draft can carry it (the AI
    // Employee may simply not be hired yet) while publish still refuses it.
    // A missing instruction stays a plain config error — nobody but the author
    // can supply that.
    expect(
      codes(def([{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: {} }])),
    ).toEqual(['MISSING_EMPLOYEE', 'INVALID_CONFIG']);
  });

  it('still BLOCKS publish on a missing employee — it is not a warning', () => {
    // The whole reason it is safe for `propose_graph` to save a draft with this
    // gap is that nothing downstream treats it as optional.
    const issues = collectDefinitionIssues(
      def([{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: { instruction: 'do it' } }]),
    );
    expect(issues.map((i) => i.code)).toContain('MISSING_EMPLOYEE');
    expect(() =>
      validateDefinitionStructure(
        def([{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: { instruction: 'do it' } }]),
      ),
    ).toThrow();
  });

  it('requires employeeId and content on MEMORY_WRITE', () => {
    expect(
      codes(def([{ id: 'm', type: 'MEMORY_WRITE', config: {} }])),
    ).toEqual(['INVALID_CONFIG', 'INVALID_CONFIG']);
  });

  it('throwing wrapper keeps a single-problem message readable', () => {
    expect(() =>
      validateDefinitionStructure(
        def([
          { id: 'a', type: 'TRIGGER', config: {} },
          { id: 'a', type: 'NOOP', config: {} },
        ]),
      ),
    ).toThrow(/Duplicate node id "a"/);
  });
});
