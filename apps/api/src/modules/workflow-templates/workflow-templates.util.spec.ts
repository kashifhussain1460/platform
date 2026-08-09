import type { WorkflowTemplateManifest } from '@vaep/types';
import {
  collectParamRefs,
  dummyValueForType,
  resolveInstallParameters,
  substituteParams,
  validateManifest,
} from './workflow-templates.util';

/** Unit tests for workflow-template param handling + validation (P3-02). Pure — no infra. */
describe('workflow-templates.util', () => {
  const validSkills = new Set(['slack']);

  const validManifest = (): WorkflowTemplateManifest => ({
    key: 't.example',
    version: 1,
    name: 'Example',
    description: 'x',
    category: 'HR',
    parameters: [
      { key: 'chan', label: 'Channel', type: 'string', required: true, binds: 'channel' },
    ],
    requires: { skills: ['slack'], employeeRoles: ['HR'] },
    definition: {
      nodes: [
        { id: 'trigger', type: 'TRIGGER', name: 'Start', config: {} },
        {
          id: 'send',
          type: 'TOOL_ACTION',
          name: 'Send',
          config: {
            skillKey: 'slack',
            tool: 'send_message',
            args: { channel: '{{param.chan}}', text: 'hi {{trigger.name}}' },
          },
        },
      ],
      edges: [{ from: 'trigger', to: 'send' }],
    },
  });

  it('collectParamRefs finds {{param.x}} keys and ignores runtime refs', () => {
    const refs = collectParamRefs(validManifest().definition);
    expect([...refs]).toEqual(['chan']); // {{trigger.name}} is NOT a param ref
  });

  it('substituteParams: whole-value preserves type; embedded interpolates; runtime refs untouched', () => {
    const out = substituteParams(
      { id: '{{param.count}}', msg: 'n={{param.count}}', rt: '{{trigger.x}}' },
      { count: 3 },
    ) as Record<string, unknown>;
    expect(out.id).toBe(3); // whole-value → raw number
    expect(out.msg).toBe('n=3'); // embedded → string
    expect(out.rt).toBe('{{trigger.x}}'); // runtime ref preserved
  });

  it('validateManifest accepts a well-formed manifest', () => {
    expect(() => validateManifest(validManifest(), validSkills)).not.toThrow();
  });

  it('validateManifest rejects a DB_QUERY node (third-party guard)', () => {
    const m = validManifest();
    m.definition.nodes[1].type = 'DB_QUERY' as never;
    expect(() => validateManifest(m, validSkills)).toThrow();
  });

  it('validateManifest rejects an undeclared param reference', () => {
    const m = validManifest();
    m.parameters = []; // {{param.chan}} now undeclared
    expect(() => validateManifest(m, validSkills)).toThrow(/undeclared parameter "chan"/);
  });

  it('validateManifest rejects a declared-but-unused param', () => {
    const m = validManifest();
    m.parameters.push({ key: 'unused', label: 'U', type: 'string', required: false });
    expect(() => validateManifest(m, validSkills)).toThrow(/"unused" is never used/);
  });

  it('validateManifest rejects an unknown required skill', () => {
    const m = validManifest();
    m.requires.skills = ['nope'];
    expect(() => validateManifest(m, validSkills)).toThrow(/unknown skill "nope"/);
  });

  it('resolveInstallParameters: missing required → throws; default applied; type-checked', () => {
    const params = validManifest().parameters;
    expect(() => resolveInstallParameters(params, {})).toThrow(/Missing required parameter "chan"/);
    expect(resolveInstallParameters(params, { chan: '#general' })).toEqual({ chan: '#general' });
    expect(() => resolveInstallParameters(params, { chan: 42 })).toThrow(/must be of type string/);

    const withDefault = [
      { key: 'k', label: 'K', type: 'string' as const, required: false, default: 'd' },
    ];
    expect(resolveInstallParameters(withDefault, {})).toEqual({ k: 'd' });
  });

  it('dummyValueForType maps each VariableType', () => {
    expect(dummyValueForType('number')).toBe(1);
    expect(dummyValueForType('boolean')).toBe(true);
    expect(dummyValueForType('array')).toEqual([]);
    expect(typeof dummyValueForType('string')).toBe('string');
  });
});
