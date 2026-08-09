import { describe, expect, it } from 'vitest';
import type { AiEmployeeDto, WorkflowDefinition } from '@vaep/types';
import { deriveEmployees, hasUnassignedEmployeeStep } from '../deriveEmployees';

// Minimal employee stand-ins — deriveEmployees only reads id/name/role.
const emp = (id: string, name: string, role: string): AiEmployeeDto =>
  ({ id, name, role }) as unknown as AiEmployeeDto;

const roster = new Map<string, AiEmployeeDto>([
  ['e-emma', emp('e-emma', 'Emma Stone', 'HR')],
  ['e-marco', emp('e-marco', 'Marco Diaz', 'MARKETING')],
]);

const def = (nodes: WorkflowDefinition['nodes']): WorkflowDefinition => ({
  nodes,
  edges: [],
});

describe('deriveEmployees', () => {
  it('resolves an AI_EMPLOYEE_STEP employeeId to the hired person', () => {
    const result = deriveEmployees(
      def([{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-emma' } }]),
      roster,
    );
    expect(result).toEqual([
      { employeeId: 'e-emma', name: 'Emma Stone', role: 'HR', unresolved: false },
    ]);
  });

  it('dedups a person used across several nodes, keeping first-seen order', () => {
    const result = deriveEmployees(
      def([
        { id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-marco' } },
        { id: 'b', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-emma' } },
        { id: 'c', type: 'AI_STEP', config: { employeeId: 'e-marco' } },
      ]),
      roster,
    );
    expect(result.map((r) => r.name)).toEqual(['Marco Diaz', 'Emma Stone']);
  });

  it('ignores un-substituted {{param}} placeholders and empty ids', () => {
    const result = deriveEmployees(
      def([
        { id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: '{{param.hrEmployee}}' } },
        { id: 'b', type: 'AI_EMPLOYEE_STEP', config: { employeeId: '' } },
        { id: 'c', type: 'AI_EMPLOYEE_STEP', config: {} },
      ]),
      roster,
    );
    expect(result).toEqual([]);
  });

  it('flags an id that no longer resolves as unresolved (removed employee)', () => {
    const result = deriveEmployees(
      def([{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-gone' } }]),
      roster,
    );
    expect(result).toEqual([
      { employeeId: 'e-gone', name: 'Removed employee', role: '', unresolved: true },
    ]);
  });

  it('contributes nobody for purely mechanical workflows', () => {
    const result = deriveEmployees(
      def([
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'x', type: 'TOOL_ACTION', config: { skillKey: 'gmail' } },
      ]),
      roster,
    );
    expect(result).toEqual([]);
  });

  it('tolerates a null/empty definition', () => {
    expect(deriveEmployees(null, roster)).toEqual([]);
    expect(deriveEmployees(def([]), roster)).toEqual([]);
  });
});

describe('hasUnassignedEmployeeStep', () => {
  it('is true when an AI_EMPLOYEE_STEP has no bound person yet', () => {
    expect(
      hasUnassignedEmployeeStep(
        def([{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: '{{param.x}}' } }]),
      ),
    ).toBe(true);
    expect(
      hasUnassignedEmployeeStep(
        def([{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: {} }]),
      ),
    ).toBe(true);
  });

  it('is false once every AI_EMPLOYEE_STEP is bound', () => {
    expect(
      hasUnassignedEmployeeStep(
        def([{ id: 'a', type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'e-emma' } }]),
      ),
    ).toBe(false);
  });

  it('is false when there are no AI_EMPLOYEE_STEP nodes at all', () => {
    expect(
      hasUnassignedEmployeeStep(def([{ id: 't', type: 'TRIGGER', config: {} }])),
    ).toBe(false);
  });
});
