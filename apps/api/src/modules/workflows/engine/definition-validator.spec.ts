import { BadRequestException } from '@nestjs/common';
import type { WorkflowDefinition } from '@vaep/types';
import { validateDefinitionStructure } from './definition-validator';

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
