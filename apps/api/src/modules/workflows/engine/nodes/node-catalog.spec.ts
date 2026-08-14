import { NODE_TYPES, type NodeType } from '@vaep/types';
import { NODE_CATALOG, listNodeDefinitions } from './node-catalog';

/**
 * Boot-completeness guard for the node-metadata catalog, mirroring
 * `workflow-templates.catalog.spec.ts`. The `Record<NodeType, …>` type already
 * makes a missing entry a compile error; this asserts the runtime invariants a
 * type cannot: no drift against `NODE_TYPES`, keys match their `type`, handle
 * topology, and that the validator-mandated fields are marked required. Fast,
 * no DB, no Nest bootstrap.
 */
describe('workflow node catalog', () => {
  const defs = listNodeDefinitions();

  it('has exactly one definition per registered NodeType and no extras (no drift)', () => {
    const catalogTypes = Object.keys(NODE_CATALOG).sort();
    const registeredTypes = [...NODE_TYPES].sort();
    expect(catalogTypes).toEqual(registeredTypes);
    expect(defs).toHaveLength(NODE_TYPES.length);
  });

  it("every entry's type matches its catalog key", () => {
    for (const type of NODE_TYPES) {
      expect(NODE_CATALOG[type].type).toBe(type);
    }
  });

  it('TRIGGER is the only node with no input; every other node has exactly one', () => {
    for (const def of defs) {
      expect(def.inputs).toBe(def.type === 'TRIGGER' ? 0 : 1);
    }
  });

  it('has a non-empty label and description for every node', () => {
    for (const def of defs) {
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });

  it('gives every config field a unique key and a label', () => {
    for (const def of defs) {
      const keys = def.configSchema.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const field of def.configSchema) {
        expect(field.key).toBeTruthy();
        expect(field.label).toBeTruthy();
      }
    }
  });

  it('marks the validator/handler-mandated fields as required', () => {
    const requiredByType: Partial<Record<NodeType, string[]>> = {
      AI_EMPLOYEE_STEP: ['employeeId', 'instruction'],
      MEMORY_READ: ['employeeId'],
      MEMORY_WRITE: ['employeeId', 'content'],
      SET_VARIABLE: ['name'],
      LOOP: ['over', 'body', 'maxIterations'],
      PARALLEL: ['lanes', 'joinNodeId'],
      SWITCH: ['on', 'cases'],
      CONDITION: ['left', 'op', 'right'],
      TOOL_ACTION: ['skillKey', 'tool'],
      RETRIEVE: ['query'],
    };
    for (const [type, fields] of Object.entries(requiredByType)) {
      const schema = NODE_CATALOG[type as NodeType].configSchema;
      for (const key of fields ?? []) {
        const field = schema.find((f) => f.key === key);
        expect(field).toBeDefined();
        expect(field?.required).toBe(true);
      }
    }
  });

  it('flags side effects for exactly the effectful node types', () => {
    const effectful = defs
      .filter((d) => d.hasSideEffects)
      .map((d) => d.type)
      .sort();
    // NOTIFY joined this list when the §30 contract was fixed: it now sends real
    // email, and email cannot be unsent. The assertion is exhaustive on purpose —
    // a node that quietly gains a side effect without appearing here would be
    // executed by dry runs, which must be provably harmless.
    expect(effectful).toEqual([
      'AI_EMPLOYEE_STEP',
      'MEMORY_WRITE',
      'NOTIFY',
      'TOOL_ACTION',
    ]);
  });

  it('allows an approval pause for exactly the gate-capable node types', () => {
    const pausable = defs
      .filter((d) => d.canPauseForApproval)
      .map((d) => d.type)
      .sort();
    expect(pausable).toEqual(['AI_EMPLOYEE_STEP', 'APPROVAL', 'TOOL_ACTION']);
  });

  it('models branch/dynamic outputs: CONDITION true/false, TERMINATE none, SWITCH/PARALLEL/LOOP dynamic', () => {
    expect(NODE_CATALOG.CONDITION.outputs.map((o) => o.branch)).toEqual([
      'true',
      'false',
    ]);
    expect(NODE_CATALOG.TERMINATE.outputs).toHaveLength(0);
    expect(NODE_CATALOG.SWITCH.dynamicOutputs).toBe('switch');
    expect(NODE_CATALOG.PARALLEL.dynamicOutputs).toBe('parallel');
    expect(NODE_CATALOG.LOOP.dynamicOutputs).toBe('loop');
  });
});
