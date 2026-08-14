import { BadRequestException } from '@nestjs/common';
import type { WorkflowDefinition } from '@vaep/types';
import {
  validateDefinitionStructure,
  validateStorableDefinition,
} from './definition-validator';

describe('validateDefinitionStructure', () => {
  it('accepts a valid linear definition', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'a', type: 'TRIGGER', config: {} },
        { id: 'b', type: 'NOTIFY', config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    expect(() => validateDefinitionStructure(def)).not.toThrow();
  });

  it('rejects a duplicate node id', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'a', type: 'TRIGGER', config: {} },
        { id: 'a', type: 'NOTIFY', config: {} },
      ],
      edges: [],
    };
    expect(() => validateDefinitionStructure(def)).toThrow(BadRequestException);
    expect(() => validateDefinitionStructure(def)).toThrow(/Duplicate node id "a"/);
  });

  it('rejects an edge to an unknown node', () => {
    const def: WorkflowDefinition = {
      nodes: [{ id: 'a', type: 'TRIGGER', config: {} }],
      edges: [{ from: 'a', to: 'ghost' }],
    };
    expect(() => validateDefinitionStructure(def)).toThrow(/unknown node id "ghost"/);
  });

  // `disabled` (Workflow Builder "Deactivate") — the engine SKIPS such a node,
  // so disabling the entry node would leave the run with no root.
  it('accepts a disabled non-trigger node', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'a', type: 'TRIGGER', config: {} },
        { id: 'b', type: 'NOOP', config: {}, disabled: true },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    expect(() => validateDefinitionStructure(def)).not.toThrow();
  });

  it('rejects a disabled TRIGGER', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'a', type: 'TRIGGER', config: {}, disabled: true },
        { id: 'b', type: 'NOOP', config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    expect(() => validateDefinitionStructure(def)).toThrow(BadRequestException);
    expect(() => validateDefinitionStructure(def)).toThrow(/cannot be disabled/);
  });
});

/**
 * A workflow being drawn is incomplete — that is the normal state of a draft,
 * not an error. The builder autosaves after every canvas change, so enforcing
 * readiness at save time made dropping a node break saving until every field on
 * it was filled in ("Couldn't save — retry", work lost on refresh). Found by
 * driving the real builder in a browser (WAVE 7).
 */
describe('validateStorableDefinition (draft saves)', () => {
  /** The exact graph the browser produced: a node dropped, not yet configured. */
  const halfBuilt: WorkflowDefinition = {
    nodes: [
      { id: 'trigger-1', type: 'TRIGGER', config: {} },
      { id: 'approval-1', type: 'APPROVAL', config: {} },
      { id: 'step-1', type: 'AI_EMPLOYEE_STEP', config: {} },
    ],
    edges: [
      { from: 'trigger-1', to: 'approval-1' },
      { from: 'approval-1', to: 'step-1' },
    ],
  };

  it('SAVES a node that has not been configured yet', () => {
    expect(() => validateStorableDefinition(halfBuilt)).not.toThrow();
  });

  it('but that same graph still cannot be published or run', () => {
    // The protection is not weakened, only moved: publish/activate/run all call
    // the full check.
    expect(() => validateDefinitionStructure(halfBuilt)).toThrow(
      /needs an employeeId/,
    );
  });

  it('SAVES a graph whose steps are not wired up yet', () => {
    // Dropping three nodes before drawing a single connection is how a canvas
    // is used. It must persist.
    expect(() =>
      validateStorableDefinition({
        nodes: [
          { id: 'trigger', type: 'TRIGGER', config: {} },
          { id: 'a', type: 'APPROVAL', config: {} },
        ],
        edges: [],
      }),
    ).not.toThrow();
  });

  it.each([
    [
      'a duplicate id, which would silently drop a node',
      {
        nodes: [
          { id: 'a', type: 'TRIGGER', config: {} },
          { id: 'a', type: 'NOOP', config: {} },
        ],
        edges: [],
      },
      /Duplicate node id/,
    ],
    [
      'an edge pointing at a node that does not exist',
      {
        nodes: [{ id: 'a', type: 'TRIGGER', config: {} }],
        edges: [{ from: 'a', to: 'ghost' }],
      },
      /unknown node id "ghost"/,
    ],
    [
      'a node type the engine does not know',
      {
        nodes: [{ id: 'a', type: 'DB_QUERY' as never, config: {} }],
        edges: [],
      },
      /unknown type/,
    ],
    [
      'an inline secret, which would be persisted into version history',
      {
        nodes: [
          { id: 'a', type: 'TRIGGER', config: {} },
          { id: 'b', type: 'TOOL_ACTION', config: { apiKey: 'sk-live-123' } },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
      /inline secret/,
    ],
  ])('still refuses to store %s', (_case, def, expected) => {
    expect(() => validateStorableDefinition(def as WorkflowDefinition)).toThrow(
      expected,
    );
  });
});

/**
 * The bug this rule exists for, found in a browser (WAVE 7): three nodes were
 * added from the palette but never connected, the workflow published happily,
 * and the run reported COMPLETED — 1/3 steps — having silently skipped the
 * approval gate and the AI step. A run that says "success" while never
 * executing the step a human was supposed to approve is the worst kind of
 * wrong: it looks fine.
 */
describe('unreachable steps', () => {
  const orphaned: WorkflowDefinition = {
    nodes: [
      { id: 'trigger', type: 'TRIGGER', config: {} },
      { id: 'approval-1', type: 'APPROVAL', config: {} },
    ],
    edges: [],
  };

  it('blocks publish/run when a step cannot be reached from the trigger', () => {
    expect(() => validateDefinitionStructure(orphaned)).toThrow(
      /can't be reached from the trigger/,
    );
  });

  it('does not block saving it — that is a graph mid-wiring', () => {
    expect(() => validateStorableDefinition(orphaned)).not.toThrow();
  });

  it('accepts a trigger-only workflow (the starter graph)', () => {
    // Every new workflow starts as a lone TRIGGER. If this ever throws, nobody
    // can create a workflow at all.
    expect(() =>
      validateDefinitionStructure({
        nodes: [{ id: 'trigger', type: 'TRIGGER', config: {} }],
        edges: [],
      }),
    ).not.toThrow();
  });

  it('counts a PARALLEL lane start as reachable, though no edge points at it', () => {
    // Lanes are wired through config, not edges. A reachability check that only
    // followed edges would reject every correct parallel workflow — including
    // the first-party templates.
    expect(() =>
      validateDefinitionStructure({
        nodes: [
          { id: 'trigger', type: 'TRIGGER', config: {} },
          {
            id: 'split',
            type: 'PARALLEL',
            config: { lanes: ['laneA'], joinNodeId: 'join' },
          },
          { id: 'laneA', type: 'NOOP', config: {} },
          { id: 'join', type: 'JOIN', config: {} },
        ],
        edges: [
          { from: 'trigger', to: 'split' },
          { from: 'laneA', to: 'join' },
        ],
      }),
    ).not.toThrow();
  });

  it('counts a LOOP `done` continuation as reachable', () => {
    // The exact graph from `workflow-p2-nodes.e2e-spec.ts`. Reachability
    // originally followed `body` but not `done`, so `end` looked like dead code
    // and the run was refused — a working workflow made unrunnable by a
    // validation rule that was wrong about the language it was validating.
    expect(() =>
      validateDefinitionStructure({
        nodes: [
          { id: 't', type: 'TRIGGER', config: {} },
          {
            id: 'l',
            type: 'LOOP',
            config: {
              over: 'trigger.people',
              itemVar: 'person',
              body: 'b',
              maxIterations: 5,
              done: 'end',
            },
          },
          { id: 'b', type: 'SET_VARIABLE', config: { name: 'lastPerson' } },
          { id: 'end', type: 'NOOP', config: {} },
        ],
        edges: [
          { from: 't', to: 'l' },
          { from: 'b', to: 'l' },
        ],
      }),
    ).not.toThrow();
  });

  it('counts a LOOP body as reachable', () => {
    expect(() =>
      validateDefinitionStructure({
        nodes: [
          { id: 'trigger', type: 'TRIGGER', config: {} },
          {
            id: 'loop',
            type: 'LOOP',
            config: { over: '{{items}}', body: 'body', maxIterations: 5 },
          },
          { id: 'body', type: 'NOOP', config: {} },
        ],
        edges: [{ from: 'trigger', to: 'loop' }],
      }),
    ).not.toThrow();
  });
});
