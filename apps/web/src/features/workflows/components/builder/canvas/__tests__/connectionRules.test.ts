import { describe, expect, it } from 'vitest';
import type { NodeDefinitionDto, NodeType } from '@vaep/types';
import { type ConnectionContext, validateConnection } from '../connectionRules';

function def(type: NodeType, inputs: number, outputCount: number): NodeDefinitionDto {
  return {
    type,
    category: 'UTILITY',
    label: type,
    description: '',
    inputs,
    outputs: Array.from({ length: outputCount }, (_, i) => ({ label: `Out ${i}` })),
    configSchema: [],
    hasSideEffects: false,
    canPauseForApproval: false,
  };
}

const defsByType = new Map<NodeType, NodeDefinitionDto>([
  ['TRIGGER', def('TRIGGER', 0, 1)],
  ['AI_EMPLOYEE_STEP', def('AI_EMPLOYEE_STEP', 1, 1)],
  ['TOOL_ACTION', def('TOOL_ACTION', 1, 1)],
  ['TERMINATE', def('TERMINATE', 1, 0)],
  ['LOOP', def('LOOP', 1, 2)],
]);

const types: Record<string, NodeType> = {
  t: 'TRIGGER',
  a: 'AI_EMPLOYEE_STEP',
  b: 'TOOL_ACTION',
  end: 'TERMINATE',
  lp: 'LOOP',
};

function ctx(edges: ConnectionContext['edges'] = []): ConnectionContext {
  return {
    nodeType: (id) => types[id],
    defsByType,
    edges,
  };
}

describe('validateConnection', () => {
  it('allows a normal forward connection', () => {
    expect(validateConnection({ source: 't', target: 'a' }, ctx())).toEqual({ ok: true });
  });

  it('rejects a missing endpoint', () => {
    expect(validateConnection({ source: 'a', target: null }, ctx()).ok).toBe(false);
  });

  it('rejects a self-loop', () => {
    const v = validateConnection({ source: 'a', target: 'a' }, ctx());
    expect(v.ok).toBe(false);
  });

  it('rejects connecting into a TRIGGER (no input)', () => {
    const v = validateConnection({ source: 'a', target: 't' }, ctx());
    expect(v).toEqual({ ok: false, reason: "A trigger has no input — it's where things start." });
  });

  it('rejects connecting out of a TERMINATE (no output)', () => {
    const v = validateConnection({ source: 'end', target: 'a' }, ctx());
    expect(v).toEqual({ ok: false, reason: 'Stop has no next step.' });
  });

  it('rejects a duplicate edge (same from/to/branch)', () => {
    const existing = [{ from: 'a', to: 'b' }];
    const v = validateConnection({ source: 'a', target: 'b' }, ctx(existing));
    expect(v).toEqual({ ok: false, reason: 'These steps are already connected.' });
  });

  it('allows a second edge on a different branch', () => {
    const existing = [{ from: 'a', to: 'b', branch: 'true' }];
    expect(validateConnection({ source: 'a', target: 'b', sourceHandle: 'false' }, ctx(existing))).toEqual({
      ok: true,
    });
  });

  it('rejects an edge that would create a cycle into a non-Loop node', () => {
    const existing = [{ from: 'a', to: 'b' }];
    const v = validateConnection({ source: 'b', target: 'a' }, ctx(existing));
    expect(v.ok).toBe(false);
  });

  it('allows a back-edge whose target is a LOOP node', () => {
    // lp → a → b already exists; b → lp closes the loop, and lp is a Loop node.
    const existing = [
      { from: 'lp', to: 'a' },
      { from: 'a', to: 'b' },
    ];
    expect(validateConnection({ source: 'b', target: 'lp' }, ctx(existing))).toEqual({ ok: true });
  });
});
