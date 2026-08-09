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

function def(
  type: NodeType,
  category: NodeCategory,
  opts: Partial<Pick<NodeDefinitionDto, 'inputs' | 'outputs' | 'dynamicOutputs' | 'hasSideEffects' | 'canPauseForApproval'>> = {},
): NodeDefinitionDto {
  return {
    type,
    category,
    label: type,
    description: `${type} node`,
    inputs: opts.inputs ?? 1,
    outputs: opts.outputs ?? ([{ label: 'Out' }] as NodeOutputHandle[]),
    dynamicOutputs: opts.dynamicOutputs,
    configSchema: [],
    hasSideEffects: opts.hasSideEffects ?? false,
    canPauseForApproval: opts.canPauseForApproval ?? false,
  };
}

const defs = new Map<NodeType, NodeDefinitionDto>([
  ['TRIGGER', def('TRIGGER', 'TRIGGER', { inputs: 0 })],
  ['AI_EMPLOYEE_STEP', def('AI_EMPLOYEE_STEP', 'AI_EMPLOYEE')],
  ['TOOL_ACTION', def('TOOL_ACTION', 'SKILL', { hasSideEffects: true, canPauseForApproval: true })],
  [
    'CONDITION',
    def('CONDITION', 'LOGIC', {
      outputs: [
        { branch: 'true', label: 'True' },
        { branch: 'false', label: 'False' },
      ],
    }),
  ],
  ['TERMINATE', def('TERMINATE', 'LOGIC', { outputs: [] })],
]);

const employees = new Map<string, AiEmployeeDto>([
  ['e-emma', { id: 'e-emma', name: 'Emma Stone', role: 'HR' } as unknown as AiEmployeeDto],
]);

const wrap = (nodes: WorkflowDefinition['nodes'], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition => ({
  nodes,
  edges,
});

describe('definitionToFlow', () => {
  it('maps every node and gives each a world position', () => {
    const { nodes } = definitionToFlow(
      wrap([
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-emma' } },
      ]),
      defs,
      employees,
    );
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.type).toBe('workflowNode');
      expect(typeof n.position.x).toBe('number');
      expect(typeof n.position.y).toBe('number');
    }
  });

  it('renders an AI Employee node as the resolved person (signature card)', () => {
    const { nodes } = definitionToFlow(
      wrap([{ id: 'a', type: 'AI_EMPLOYEE_STEP', name: '', config: { employeeId: 'e-emma', instruction: 'Screen the CV' } }]),
      defs,
      employees,
    );
    const data = nodes[0].data;
    expect(data.category).toBe('AI_EMPLOYEE');
    expect(data.employee).toEqual({ name: 'Emma Stone', role: 'HR', unresolved: false });
    expect(data.title).toBe('Emma Stone');
    expect(data.subtitle).toBe('Screen the CV');
    expect(data.hasTarget).toBe(true);
  });

  it('treats a {{param}} placeholder as Unassigned and a missing id as Removed', () => {
    const { nodes } = definitionToFlow(
      wrap([
        { id: 'p', type: 'AI_EMPLOYEE_STEP', config: { employeeId: '{{param.hr}}' } },
        { id: 'g', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-gone' } },
      ]),
      defs,
      employees,
    );
    expect(nodes[0].data.employee).toEqual({ name: 'Unassigned', role: '', unresolved: false });
    expect(nodes[1].data.employee).toEqual({ name: 'Removed employee', role: '', unresolved: true });
  });

  it('gives a TRIGGER no input handle', () => {
    const { nodes } = definitionToFlow(wrap([{ id: 't', type: 'TRIGGER', config: {} }]), defs, employees);
    expect(nodes[0].data.hasTarget).toBe(false);
  });

  it('surfaces CONDITION True/False as two labelled source handles', () => {
    const { nodes } = definitionToFlow(
      wrap([{ id: 'c', type: 'CONDITION', config: { left: '{{x}}', op: 'eq', right: '1' } }]),
      defs,
      employees,
    );
    const handles = nodes[0].data.sourceHandles;
    expect(handles.map((h) => h.id).sort()).toEqual(['false', 'true']);
    expect(handles.find((h) => h.id === 'true')?.label).toBe('True');
    expect(nodes[0].data.subtitle).toBe('{{x}} eq 1');
  });

  it('gives a no-output node (TERMINATE) no source handle', () => {
    const { nodes } = definitionToFlow(wrap([{ id: 'end', type: 'TERMINATE', config: {} }]), defs, employees);
    expect(nodes[0].data.sourceHandles).toEqual([]);
  });

  it('maps edges with the branch as sourceHandle and the registry label', () => {
    const { edges } = definitionToFlow(
      wrap(
        [
          { id: 'c', type: 'CONDITION', config: {} },
          { id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-emma' } },
          { id: 'b', type: 'TOOL_ACTION', config: {} },
        ],
        [
          { from: 'c', to: 'a', branch: 'true' },
          { from: 'c', to: 'b', branch: 'false' },
        ],
      ),
      defs,
      employees,
    );
    expect(edges).toHaveLength(2);
    const yes = edges.find((e) => e.target === 'a');
    expect(yes?.sourceHandle).toBe('true');
    expect(yes?.label).toBe('True');
    const no = edges.find((e) => e.target === 'b');
    expect(no?.sourceHandle).toBe('false');
    expect(no?.label).toBe('False');
  });

  it('builds a "Use <skill> to <tool>" subtitle for tool actions', () => {
    const { nodes } = definitionToFlow(
      wrap([{ id: 'x', type: 'TOOL_ACTION', config: { skillKey: 'gmail', tool: 'send_email' } }]),
      defs,
      employees,
    );
    expect(nodes[0].data.subtitle).toBe('Use gmail to send email');
    expect(nodes[0].data.pausesForApproval).toBe(true);
  });

  it('assigns a short badge code, skill-aware for tool nodes', () => {
    const { nodes } = definitionToFlow(
      wrap([
        { id: 'c', type: 'CONDITION', config: {} },
        { id: 't', type: 'TOOL_ACTION', config: { skillKey: 'gmail' } },
        { id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-emma' } },
      ]),
      defs,
      employees,
    );
    const codeById = Object.fromEntries(nodes.map((n) => [n.id, n.data.code]));
    expect(codeById.c).toBe('IF');
    expect(codeById.t).toBe('MSG');
    expect(codeById.a).toBe('AI');
  });
});
