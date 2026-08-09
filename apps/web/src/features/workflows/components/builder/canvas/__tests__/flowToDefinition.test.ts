import { describe, expect, it } from 'vitest';
import type {
  AiEmployeeDto,
  NodeCategory,
  NodeDefinitionDto,
  NodeOutputHandle,
  NodeType,
  WorkflowDefinition,
} from '@vaep/types';
import { definitionToFlow } from '../definitionToFlow';
import { flowToDefinition } from '../flowToDefinition';

function def(type: NodeType, category: NodeCategory, outputs?: NodeOutputHandle[], inputs = 1): NodeDefinitionDto {
  return {
    type,
    category,
    label: type,
    description: '',
    inputs,
    outputs: outputs ?? [{ label: 'Out' }],
    configSchema: [],
    hasSideEffects: false,
    canPauseForApproval: false,
  };
}

const defs = new Map<NodeType, NodeDefinitionDto>([
  ['TRIGGER', def('TRIGGER', 'TRIGGER', [{ label: 'Out' }], 0)],
  ['AI_EMPLOYEE_STEP', def('AI_EMPLOYEE_STEP', 'AI_EMPLOYEE')],
  ['CONDITION', def('CONDITION', 'LOGIC', [{ branch: 'true', label: 'True' }, { branch: 'false', label: 'False' }])],
  ['TOOL_ACTION', def('TOOL_ACTION', 'SKILL')],
]);
const employees = new Map<string, AiEmployeeDto>([
  ['e1', { id: 'e1', name: 'Emma', role: 'HR' } as unknown as AiEmployeeDto],
]);

describe('flowToDefinition round-trip', () => {
  it('preserves node identity/config/name and edge branches through a canvas round-trip', () => {
    const source: WorkflowDefinition = {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'a', type: 'AI_EMPLOYEE_STEP', name: 'Screen', config: { employeeId: 'e1' } },
        { id: 'c', type: 'CONDITION', config: { left: '{{x}}', op: 'eq', right: '1' } },
        { id: 'z', type: 'TOOL_ACTION', config: { skillKey: 'gmail' } },
      ],
      edges: [
        { from: 't', to: 'a' },
        { from: 'a', to: 'c' },
        { from: 'c', to: 'z', branch: 'true' },
      ],
    };

    const flow = definitionToFlow(source, defs, employees);
    const round = flowToDefinition(flow.nodes, flow.edges);

    // Structure (ignoring the dagre-added positions) round-trips exactly.
    expect(round.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, config: n.config }))).toEqual(
      source.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, config: n.config })),
    );
    expect(round.edges).toEqual(source.edges);
    // Every node came back with a concrete position.
    for (const n of round.nodes) {
      expect(Number.isFinite(n.position?.x)).toBe(true);
      expect(Number.isFinite(n.position?.y)).toBe(true);
    }
  });

  it('honors and round-trips an explicit persisted position (no dagre override)', () => {
    const source: WorkflowDefinition = {
      nodes: [{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e1' }, position: { x: 123, y: 456 } }],
      edges: [],
    };
    const flow = definitionToFlow(source, defs, employees);
    expect(flow.nodes[0].position).toEqual({ x: 123, y: 456 });

    const round = flowToDefinition(flow.nodes, flow.edges);
    expect(round.nodes[0].position).toEqual({ x: 123, y: 456 });
  });

  it('round-trips a disabled node, and never writes disabled:false', () => {
    const source: WorkflowDefinition = {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e1' }, disabled: true },
        { id: 'z', type: 'TOOL_ACTION', config: {} },
      ],
      edges: [
        { from: 't', to: 'a' },
        { from: 'a', to: 'z' },
      ],
    };
    const flow = definitionToFlow(source, defs, employees);
    const round = flowToDefinition(flow.nodes, flow.edges);

    expect(round.nodes.find((n) => n.id === 'a')?.disabled).toBe(true);
    // An enabled node stays clean — `disabled` is absent, not `false`, so an
    // untouched graph doesn't gain noise on every save.
    expect(round.nodes.find((n) => n.id === 'z')).not.toHaveProperty('disabled');
    expect(round.nodes.find((n) => n.id === 't')).not.toHaveProperty('disabled');
  });

  it('drops the synthetic default handle from edges (no spurious branch)', () => {
    const source: WorkflowDefinition = {
      nodes: [
        { id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e1' } },
        { id: 'z', type: 'TOOL_ACTION', config: {} },
      ],
      edges: [{ from: 'a', to: 'z' }],
    };
    const flow = definitionToFlow(source, defs, employees);
    const round = flowToDefinition(flow.nodes, flow.edges);
    expect(round.edges).toEqual([{ from: 'a', to: 'z' }]);
    expect(round.edges[0]).not.toHaveProperty('branch');
  });
});
