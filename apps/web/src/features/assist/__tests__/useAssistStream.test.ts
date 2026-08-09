import { describe, expect, it } from 'vitest';
import type { AssistStreamEvent } from '@vaep/types';
import { reduce, type AssistStreamState } from '../useAssistStream';

const IDLE: AssistStreamState = {
  status: 'idle',
  text: '',
  thinking: null,
  trace: [],
  graph: null,
  tests: [],
  connection: null,
  error: null,
};

const run = (events: AssistStreamEvent[]): AssistStreamState =>
  events.reduce<AssistStreamState>(reduce, IDLE);

describe('assist stream reducer', () => {
  it('accumulates token text in order', () => {
    const state = run([
      { type: 'token', text: 'Building ' },
      { type: 'token', text: 'your ' },
      { type: 'token', text: 'workflow.' },
    ]);
    expect(state.text).toBe('Building your workflow.');
  });

  it('tracks the current thinking label and clears it on done', () => {
    const mid = run([{ type: 'thinking', label: 'Reading your skills' }]);
    expect(mid.thinking).toBe('Reading your skills');

    const end = reduce(mid, { type: 'done', finished: true });
    expect(end.thinking).toBeNull();
    expect(end.status).toBe('idle');
  });

  it('appends tool trace entries', () => {
    const state = run([
      { type: 'tool', tool: { name: 'list_skills', summary: 'Read 3 skills', ok: true } },
      { type: 'tool', tool: { name: 'propose_graph', summary: 'Saved 4 steps', ok: true } },
    ]);
    expect(state.trace.map((t) => t.name)).toEqual(['list_skills', 'propose_graph']);
  });

  it('stores the pushed graph with its version and unresolved items', () => {
    const state = run([
      {
        type: 'graph',
        definition: { nodes: [{ id: 't', type: 'TRIGGER', config: {} }], edges: [] },
        version: 2,
        unresolved: [{ nodeId: 'x', reason: 'needs a skill' }],
      },
    ]);
    expect(state.graph?.version).toBe(2);
    expect(state.graph?.definition.nodes).toHaveLength(1);
    expect(state.graph?.unresolved).toHaveLength(1);
  });

  it('keeps the error visible when done arrives after it', () => {
    // `done` always follows `error`, so flipping to idle there would hide the
    // failure the user needs to see — this is the guard for that.
    const state = run([
      { type: 'error', code: '500', message: 'Provider is down', retryable: true },
      { type: 'done', finished: false },
    ]);
    expect(state.status).toBe('error');
    expect(state.error).toEqual({ message: 'Provider is down', retryable: true });
  });

  it('goes back to idle on a clean done', () => {
    const state = run([
      { type: 'token', text: 'ok' },
      { type: 'done', finished: true },
    ]);
    expect(state.status).toBe('idle');
    expect(state.text).toBe('ok');
  });

  it('collects dry-run test results as they arrive', () => {
    const state = run([
      {
        type: 'test',
        result: {
          runId: 'r1',
          status: 'COMPLETED',
          headline: 'Ran end to end: 3 steps completed. 1 step was simulated.',
          steps: [
            { nodeId: 'send', name: 'Send it', status: 'COMPLETED', ms: 4, simulated: true },
          ],
        },
      },
    ]);
    expect(state.tests).toHaveLength(1);
    // The simulated flag has to survive to the UI — it is the honesty contract.
    expect(state.tests[0].steps[0].simulated).toBe(true);
  });

  it('captures a connection requirement so the Skill card can render', () => {
    const state = run([
      {
        type: 'connection',
        reason: 'This workflow needs 1 skill connection before it can run.',
        requirements: [
          {
            skillKey: 'gmail',
            displayName: 'Gmail',
            provider: 'google',
            capabilities: ['EMAIL_SEND'],
            compatibleSkillKeys: ['email'],
            requiresConnection: true,
            required: true,
            status: 'NOT_CONNECTED',
            connectionStatus: null,
            connectionType: 'oauth',
            installedSkillId: null,
            credentialsSet: false,
            nodeIds: ['send'],
            canManageConnection: true,
          },
        ],
      },
    ]);
    expect(state.connection?.requirements).toHaveLength(1);
    expect(state.connection?.requirements[0].skillKey).toBe('gmail');
  });

  it('handles a realistic full turn', () => {
    const state = run([
      { type: 'thinking', label: 'Working out what you need' },
      { type: 'tool', tool: { name: 'list_employees', summary: 'Read 1 employee', ok: true } },
      { type: 'tool', tool: { name: 'list_skills', summary: 'Read 1 skill', ok: true } },
      { type: 'tool', tool: { name: 'propose_graph', summary: 'Saved a 4-step draft', ok: true } },
      {
        type: 'graph',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'a', type: 'AI_EMPLOYEE_STEP', config: {} },
          ],
          edges: [{ from: 't', to: 'a' }],
        },
        version: 1,
        unresolved: [],
      },
      { type: 'token', text: 'Done — ' },
      { type: 'token', text: 'have a look.' },
      { type: 'done', finished: true },
    ]);

    expect(state.status).toBe('idle');
    expect(state.text).toBe('Done — have a look.');
    expect(state.trace).toHaveLength(3);
    expect(state.graph?.definition.nodes).toHaveLength(2);
    expect(state.error).toBeNull();
  });
});
