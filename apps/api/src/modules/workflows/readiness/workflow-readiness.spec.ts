import type {
  WorkflowDefinition,
  WorkflowSkillRequirementDto,
} from '@vaep/types';
import { evaluateReadiness, type ReadinessInput } from './workflow-readiness';

const TRIGGER = { id: 't', type: 'TRIGGER' as const, name: 'Start', config: {} };

function definition(
  nodes: WorkflowDefinition['nodes'],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition {
  return { nodes, edges };
}

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    workflowId: 'w1',
    name: 'Weekly lead qualification',
    definition: definition(
      [
        TRIGGER,
        {
          id: 'ai',
          type: 'AI_EMPLOYEE_STEP',
          name: 'Qualify the lead',
          config: { employeeId: 'e1', instruction: 'Score this lead' },
        },
      ],
      [{ from: 't', to: 'ai' }],
    ),
    triggerType: 'MANUAL',
    triggerConfig: null,
    skillRequirements: [],
    warnings: [],
    ...overrides,
  };
}

function skillRequirement(
  overrides: Partial<WorkflowSkillRequirementDto> = {},
): WorkflowSkillRequirementDto {
  return {
    skillKey: 'gmail',
    displayName: 'Gmail',
    provider: 'google',
    capabilities: [],
    compatibleSkillKeys: [],
    requiresConnection: true,
    required: true,
    status: 'NOT_CONNECTED',
    connectionStatus: null,
    connectionType: null,
    installedSkillId: null,
    credentialsSet: false,
    nodeIds: ['send'],
    canManageConnection: true,
    ...overrides,
  };
}

describe('evaluateReadiness', () => {
  it('is ready for a complete manual workflow', () => {
    const result = evaluateReadiness(input());

    expect(result.ready).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.summary.stepCount).toBe(1);
    expect(result.summary.employeeIds).toEqual(['e1']);
    expect(result.summary.triggerSummary).toBe('Manual — someone starts it');
  });

  it('blocks when a required skill has no connection', () => {
    const result = evaluateReadiness(
      input({ skillRequirements: [skillRequirement()] }),
    );

    expect(result.ready).toBe(false);
    const issue = result.issues.find((i) => i.code === 'SKILL_NOT_CONNECTED');
    expect(issue?.severity).toBe('BLOCKER');
    expect(issue?.fix).toEqual({ kind: 'CONNECT_SKILL', target: 'gmail' });
    expect(result.checks.find((c) => c.key === 'SKILLS')?.status).toBe('FAIL');
  });

  it('tells a member without admin rights to ask an admin', () => {
    const result = evaluateReadiness(
      input({
        skillRequirements: [skillRequirement({ canManageConnection: false })],
      }),
    );

    expect(
      result.issues.find((i) => i.code === 'SKILL_NOT_CONNECTED')?.message,
    ).toContain('Ask an owner or admin');
  });

  it('does not block on a connected skill or on one that needs no connection', () => {
    const result = evaluateReadiness(
      input({
        skillRequirements: [
          skillRequirement({ status: 'READY' }),
          skillRequirement({
            skillKey: 'http',
            displayName: 'HTTP',
            requiresConnection: false,
          }),
        ],
      }),
    );

    expect(result.ready).toBe(true);
  });

  it('blocks a SCHEDULE trigger with neither cron nor interval', () => {
    const result = evaluateReadiness(
      input({ triggerType: 'SCHEDULE', triggerConfig: {} }),
    );

    expect(result.ready).toBe(false);
    const issue = result.issues.find((i) => i.code === 'TRIGGER_INCOMPLETE');
    expect(issue?.fix).toEqual({ kind: 'OPEN_TRIGGER' });
    expect(result.checks.find((c) => c.key === 'SCHEDULE')?.status).toBe('FAIL');
  });

  it('accepts a SCHEDULE trigger with a cron expression', () => {
    const result = evaluateReadiness(
      input({ triggerType: 'SCHEDULE', triggerConfig: { cron: '0 9 * * 1' } }),
    );

    expect(result.ready).toBe(true);
    expect(result.summary.triggerSummary).toBe('On a schedule (0 9 * * 1)');
  });

  it('rejects an interval below the scheduler minimum', () => {
    const result = evaluateReadiness(
      input({ triggerType: 'SCHEDULE', triggerConfig: { everyMs: 5_000 } }),
    );

    expect(result.issues.map((i) => i.code)).toContain('TRIGGER_INCOMPLETE');
  });

  it('blocks an EVENT trigger with no event chosen', () => {
    const result = evaluateReadiness(
      input({ triggerType: 'EVENT', triggerConfig: {} }),
    );

    expect(result.issues.map((i) => i.code)).toContain('TRIGGER_INCOMPLETE');
  });

  it('blocks a workflow with no steps beyond the trigger', () => {
    const result = evaluateReadiness(
      input({ definition: definition([TRIGGER]) }),
    );

    expect(result.ready).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('NO_STEPS');
  });

  it('surfaces a misconfigured step from the real validator as a blocker', () => {
    const result = evaluateReadiness(
      input({
        definition: definition(
          [
            TRIGGER,
            {
              id: 'ai',
              type: 'AI_EMPLOYEE_STEP',
              name: 'Qualify',
              config: { employeeId: 'e1' },
            },
          ],
          [{ from: 't', to: 'ai' }],
        ),
      }),
    );

    expect(result.ready).toBe(false);
    const issue = result.issues.find((i) => i.code === 'INVALID_CONFIG');
    expect(issue?.message).toContain('needs an instruction');
    expect(issue?.fix).toEqual({ kind: 'OPEN_NODE', target: 'ai' });
    expect(result.checks.find((c) => c.key === 'NODE_CONFIG')?.status).toBe(
      'FAIL',
    );
  });

  it('warns — but does not block — on an approval with no routing', () => {
    const result = evaluateReadiness(
      input({
        definition: definition(
          [
            TRIGGER,
            {
              id: 'ap',
              type: 'APPROVAL',
              name: 'Manager sign-off',
              config: {},
            },
          ],
          [{ from: 't', to: 'ap' }],
        ),
      }),
    );

    expect(result.ready).toBe(true);
    const issue = result.issues.find((i) => i.code === 'APPROVAL_UNROUTED');
    expect(issue?.severity).toBe('WARNING');
    expect(result.checks.find((c) => c.key === 'APPROVAL')?.status).toBe('WARN');
    expect(result.summary.approvalCount).toBe(1);
  });

  it('does not warn about an auto-approving approval node', () => {
    const result = evaluateReadiness(
      input({
        definition: definition(
          [
            TRIGGER,
            {
              id: 'ap',
              type: 'APPROVAL',
              name: 'Auto',
              config: { autoApprove: true },
            },
          ],
          [{ from: 't', to: 'ap' }],
        ),
      }),
    );

    expect(result.issues.map((i) => i.code)).not.toContain('APPROVAL_UNROUTED');
  });

  it('reports external side effects so the confirmation can say so', () => {
    const result = evaluateReadiness(
      input({
        definition: definition(
          [
            TRIGGER,
            {
              id: 'send',
              type: 'TOOL_ACTION',
              name: 'Send the email',
              config: { skillKey: 'gmail', tool: 'send_email', args: {} },
            },
          ],
          [{ from: 't', to: 'send' }],
        ),
        skillRequirements: [skillRequirement({ status: 'READY' })],
      }),
    );

    expect(result.summary.hasExternalActions).toBe(true);
    expect(result.summary.skillKeys).toEqual(['gmail']);
  });

  it('passes graph warnings through without blocking', () => {
    const result = evaluateReadiness(
      input({ warnings: ['Step "Send" is never reached'] }),
    );

    expect(result.ready).toBe(true);
    expect(result.issues).toEqual([
      {
        code: 'GRAPH_WARNING',
        severity: 'WARNING',
        message: 'Step "Send" is never reached',
        nodeId: null,
        fix: null,
      },
    ]);
  });
});

describe('warning de-duplication', () => {
  it('does not list the same unreachable step twice from two sources', () => {
    // The validator and computeWarnings both notice this, in different words.
    const result = evaluateReadiness(
      input({
        definition: definition([
          TRIGGER,
          // No name, so both sources refer to it by id — the exact shape seen
          // in the browser when a node is dropped and not yet connected.
          {
            id: 'orphan',
            type: 'NOOP',
            config: {},
          },
          {
            id: 'ok',
            type: 'NOOP',
            config: {},
          },
        ], [{ from: 't', to: 'ok' }]),
        warnings: [
          'Step "orphan" (NOOP) can\u2019t be reached from the trigger \u2014 it will never run.',
        ],
      }),
    );

    const aboutOrphan = result.issues.filter((i) => i.message.includes('orphan'));
    expect(aboutOrphan).toHaveLength(1);
    // The surviving one is the validator's, which carries the fix action.
    expect(aboutOrphan[0].fix).toEqual({ kind: 'OPEN_NODE', target: 'orphan' });
    // And it BLOCKS: publish refuses an unreachable step (verified in a
    // browser — readiness previously called this a warning and then publish
    // returned 400, which is the one thing this preflight exists to prevent).
    expect(aboutOrphan[0].severity).toBe('BLOCKER');
    expect(result.ready).toBe(false);
  });
});
