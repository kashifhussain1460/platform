import type { WorkflowDefinition } from '@vaep/types';
import { resolveReferences } from './graph-references';

/**
 * What a freshly-designed graph still needs from the customer.
 *
 * The case that produced this file: an assistant asked for a recruitment
 * workflow in a tenant with NO skills connected wrote `gmail/send_message` —
 * Gmail has no such action (it has `send_email`; `send_message` is Slack's).
 * The only thing reported was "gmail isn't connected yet", so the customer
 * connects Gmail, publishes, activates, runs, and the step fails on a name that
 * was wrong before any of that.
 */
const prismaWith = (skills: string[], employees: string[]) =>
  ({
    installedSkill: {
      findMany: jest.fn().mockResolvedValue(skills.map((skillKey) => ({ skillKey }))),
    },
    aiEmployee: {
      findMany: jest.fn().mockResolvedValue(employees.map((id) => ({ id }))),
    },
  }) as never;

const toolNode = (skillKey: string, tool: string): WorkflowDefinition => ({
  nodes: [
    {
      id: 'send',
      type: 'TOOL_ACTION',
      name: 'Send Rejection Email',
      config: { skillKey, tool, args: { to: 'a@b.co', subject: 's', body: 'b' } },
    } as never,
  ],
  edges: [],
});

describe('resolveReferences — TOOL_ACTION', () => {
  it('reports a NON-EXISTENT action even when the skill is also not connected', async () => {
    const out = await resolveReferences(prismaWith([], []), 'co-1', toolNode('gmail', 'send_message'));

    expect(out).toHaveLength(1);
    // The permanent problem, not the temporary one.
    expect(out[0].reason).toMatch(/isn't one of its actions/i);
    expect(out[0].reason).not.toMatch(/isn't connected/i);
  });

  it('reports the connection when the action itself is real', async () => {
    const out = await resolveReferences(prismaWith([], []), 'co-1', toolNode('gmail', 'send_email'));

    expect(out).toHaveLength(1);
    expect(out[0].reason).toMatch(/isn't connected/i);
  });

  it('is happy when the action is real and the skill is connected', async () => {
    const out = await resolveReferences(
      prismaWith(['gmail'], []),
      'co-1',
      toolNode('gmail', 'send_email'),
    );

    expect(out).toEqual([]);
  });
});

/**
 * Step results are read by outputKey, never by step id.
 *
 * A live QA run shipped `{{prepareRejection.rejectionEmail}}` all the way
 * through generation, a dry run, publish, activation and a human approval, and
 * only stopped at the send — where the approver had already agreed to email a
 * candidate a rejection letter whose body would have been empty.
 */
describe('propose_graph — step-id references', () => {
  const { findNodeIdRefsForTest } = jest.requireActual<{
    findNodeIdRefsForTest: (
      nodes: { id?: unknown; config?: unknown }[],
      ids: Set<string>,
    ) => string[];
  }>('./assist-write-tools');

  const ids = new Set(['prepareRejection', 'evaluateCV', 'send']);

  it('catches a reference to a step id', () => {
    expect(
      findNodeIdRefsForTest(
        [{ id: 'send', config: { args: { body: '{{prepareRejection.rejectionEmail}}' } } }],
        ids,
      ),
    ).toEqual(['[send] {{prepareRejection.rejectionEmail}}']);
  });

  it('leaves a plain outputKey reference alone', () => {
    expect(
      findNodeIdRefsForTest(
        [{ id: 'send', config: { args: { body: '{{rejectionEmail}}' } } }],
        ids,
      ),
    ).toEqual([]);
  });

  it('never blames {{trigger.*}} or {{secret.*}}', () => {
    // The run payload and the connector-boundary namespace are not steps, even
    // if a step happens to share the name.
    expect(
      findNodeIdRefsForTest(
        [
          {
            id: 'send',
            config: { args: { to: '{{trigger.email}}', key: '{{secret.apiToken}}' } },
          },
        ],
        new Set(['trigger', 'secret', 'send']),
      ),
    ).toEqual([]);
  });

  it('finds them nested inside a TOOL_ACTION\'s args', () => {
    expect(
      findNodeIdRefsForTest(
        [{ id: 'send', config: { args: { deep: ['{{evaluateCV.decision}}'] } } }],
        ids,
      ),
    ).toHaveLength(1);
  });
});

/**
 * A branch that can never be taken.
 *
 * Live evidence: a leave request of 8 days overlapping a critical project — two
 * policy conflicts — took the "no conflict" branch, skipped the mandatory HR
 * approval, and the run finished COMPLETED with zero approvals. The CONDITION
 * compared the AI's whole paragraph against the literal "true".
 */
describe('propose_graph — conditions on an AI answer', () => {
  const { findUntestableConditionsForTest: check } = jest.requireActual<{
    findUntestableConditionsForTest: (n: Record<string, unknown>[]) => string[];
  }>('./assist-write-tools');

  const aiStep = (instruction: string) => ({
    id: 'check',
    type: 'AI_EMPLOYEE_STEP',
    config: { employeeId: 'e1', instruction, outputKey: 'conflict' },
  });
  const condition = (op: string, right: string) => ({
    id: 'gate',
    type: 'CONDITION',
    config: { left: '{{conflict}}', op, right },
  });

  it('catches a comparison the step was never told to satisfy', () => {
    const out = check([aiStep('Check whether this leave conflicts with policy.'), condition('eq', 'true')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/never told to answer "true"/);
  });

  it('allows it when the instruction demands that exact answer', () => {
    // A one-word answer is a perfectly good design and must keep working.
    expect(
      check([
        aiStep('Reply with exactly one word: true or false.'),
        condition('eq', 'true'),
      ]),
    ).toEqual([]);
  });

  it('ignores conditions on values a person or another step supplies', () => {
    // Only an AI step's prose is the problem; trigger data is exact.
    expect(
      check([
        { id: 'gate', type: 'CONDITION', config: { left: '{{trigger.days}}', op: 'gt', right: '5' } },
      ]),
    ).toEqual([]);
  });
});

describe('resolveReferences — an AI step given nothing from the run', () => {
  const prisma = {
    installedSkill: { findMany: jest.fn().mockResolvedValue([]) },
    aiEmployee: { findMany: jest.fn().mockResolvedValue([{ id: 'e1' }]) },
  } as never;

  const withInstruction = (instruction: string): WorkflowDefinition => ({
    nodes: [
      {
        id: 'check',
        type: 'AI_EMPLOYEE_STEP',
        name: 'Check conflict',
        config: { employeeId: 'e1', instruction },
      } as never,
    ],
    edges: [],
  });

  it('flags an instruction that references nothing', async () => {
    const out = await resolveReferences(prisma, 'co-1', withInstruction('Check the leave request.'));
    expect(out).toHaveLength(1);
    expect(out[0].reason).toMatch(/not given anything from the request/i);
  });

  it('is quiet when the instruction reads the run', async () => {
    const out = await resolveReferences(
      prisma,
      'co-1',
      withInstruction('Check this leave request: {{trigger.leaveType}} for {{trigger.requestedDays}} days.'),
    );
    expect(out).toEqual([]);
  });
});
