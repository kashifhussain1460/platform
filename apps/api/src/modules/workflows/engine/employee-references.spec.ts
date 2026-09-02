import {
  actingEmployeeIdForGraph,
  employeeIdsInGraph,
  nodesOf,
} from './employee-references';

/**
 * The rule that turns `WorkflowRun.actingEmployeeId` from a dead column into
 * the platform's primary link. Pinned here because attribution is written ONCE,
 * at run creation, and a run's history must not change afterwards — so a change
 * to this rule silently rewrites what the product claims happened.
 */
describe('employee-references', () => {
  const node = (type: string, config?: Record<string, unknown>) => ({ type, config });

  describe('nodesOf', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not a graph'],
      ['an object with no nodes', { edges: [] }],
      ['nodes that is not an array', { nodes: { a: 1 } }],
    ])('returns [] for %s rather than throwing', (_label, input) => {
      expect(nodesOf(input)).toEqual([]);
    });

    it('drops non-object entries instead of failing the whole graph', () => {
      expect(nodesOf({ nodes: [null, 'x', 7, { type: 'TRIGGER' }] })).toEqual([
        { type: 'TRIGGER' },
      ]);
    });
  });

  describe('employeeIdsInGraph', () => {
    it('reads employeeId from any node type that carries one', () => {
      const nodes = [
        node('TRIGGER', {}),
        node('AI_EMPLOYEE_STEP', { employeeId: 'emma' }),
        node('TOOL_ACTION', { employeeId: 'mia' }),
        node('MEMORY_WRITE', { employeeId: 'nova' }),
      ];
      expect(employeeIdsInGraph(nodes)).toEqual(['emma', 'mia', 'nova']);
    });

    it('de-duplicates while preserving first-appearance order', () => {
      const nodes = [
        node('AI_EMPLOYEE_STEP', { employeeId: 'mia' }),
        node('TOOL_ACTION', { employeeId: 'emma' }),
        node('MEMORY_WRITE', { employeeId: 'mia' }),
      ];
      expect(employeeIdsInGraph(nodes)).toEqual(['mia', 'emma']);
    });

    it('trims whitespace around an id', () => {
      expect(employeeIdsInGraph([node('AI_EMPLOYEE_STEP', { employeeId: '  emma  ' })])).toEqual([
        'emma',
      ]);
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['a non-string', 42],
      ['null', null],
    ])('ignores %s', (_label, employeeId) => {
      expect(employeeIdsInGraph([node('AI_EMPLOYEE_STEP', { employeeId })])).toEqual([]);
    });

    /**
     * THE constraint-safety case. A templated employeeId resolves at execution
     * time from run context, so it is not an id — and storing the literal
     * `{{trigger.employeeId}}` would violate the foreign key that makes this
     * column meaningful.
     */
    it('ignores a {{template}} placeholder, which is not an id', () => {
      const nodes = [
        node('AI_EMPLOYEE_STEP', { employeeId: '{{trigger.employeeId}}' }),
        node('TOOL_ACTION', { employeeId: 'emma' }),
      ];
      expect(employeeIdsInGraph(nodes)).toEqual(['emma']);
    });

    it('handles a node with no config at all', () => {
      expect(employeeIdsInGraph([{ type: 'TRIGGER' }])).toEqual([]);
    });
  });

  describe('actingEmployeeIdForGraph', () => {
    it('attributes a single-employee graph to that employee', () => {
      const nodes = [node('TRIGGER', {}), node('AI_EMPLOYEE_STEP', { employeeId: 'emma' })];
      expect(actingEmployeeIdForGraph(nodes)).toBe('emma');
    });

    /**
     * The rule, stated as a test: first in DEFINITION order. Not "null because
     * it is ambiguous" — that would leave the runs most worth attributing as
     * the only ones with no attribution.
     */
    it('attributes a multi-employee graph to the one that acts first', () => {
      const nodes = [
        node('TRIGGER', {}),
        node('AI_EMPLOYEE_STEP', { employeeId: 'emma' }),
        node('AI_EMPLOYEE_STEP', { employeeId: 'mia' }),
      ];
      expect(actingEmployeeIdForGraph(nodes)).toBe('emma');
    });

    it('is null for a pure integration graph — a true statement, not missing data', () => {
      const nodes = [
        node('TRIGGER', {}),
        node('HTTP_REQUEST', { url: 'https://example.test' }),
        node('CONDITION', { expression: 'x' }),
        node('NOTIFY', { message: 'done' }),
      ];
      expect(actingEmployeeIdForGraph(nodes)).toBeNull();
    });

    it('is null for an empty graph', () => {
      expect(actingEmployeeIdForGraph([])).toBeNull();
    });

    it('composes with nodesOf on an untrusted definition', () => {
      const definition = {
        nodes: [{ type: 'AI_EMPLOYEE_STEP', config: { employeeId: 'nova' } }],
      };
      expect(actingEmployeeIdForGraph(nodesOf(definition))).toBe('nova');
      expect(actingEmployeeIdForGraph(nodesOf(null))).toBeNull();
    });
  });
});
