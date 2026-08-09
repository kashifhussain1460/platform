import type { WorkflowDefinition } from '@vaep/types';
import { applyGraphPatch, type GraphPatchOp } from './graph-patch';

const base = (): WorkflowDefinition => ({
  nodes: [
    { id: 'trigger', type: 'TRIGGER', config: {} },
    { id: 'think', type: 'AI_EMPLOYEE_STEP', name: 'Score it', config: { employeeId: 'e1' } },
    { id: 'send', type: 'TOOL_ACTION', config: { skillKey: 'slack', tool: 'send_message' } },
  ],
  edges: [
    { from: 'trigger', to: 'think' },
    { from: 'think', to: 'send' },
  ],
});

const apply = (ops: GraphPatchOp[]) => applyGraphPatch(base(), ops);

describe('applyGraphPatch', () => {
  it('merges config by default and replaces when told to', () => {
    const merged = apply([
      { op: 'updateNodeConfig', id: 'send', config: { args: { channel: '#hr' } } },
    ]);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const node = merged.definition.nodes.find((n) => n.id === 'send');
    // The original keys survive a merge.
    expect(node?.config.skillKey).toBe('slack');
    expect(node?.config.args).toEqual({ channel: '#hr' });

    const replaced = apply([
      { op: 'updateNodeConfig', id: 'send', config: { skillKey: 'gmail' }, merge: false },
    ]);
    if (!replaced.ok) throw new Error('expected ok');
    expect(replaced.definition.nodes.find((n) => n.id === 'send')?.config).toEqual({
      skillKey: 'gmail',
    });
  });

  it('removes a node together with every edge touching it', () => {
    const result = apply([{ op: 'removeNode', id: 'think' }]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.definition.nodes.map((n) => n.id)).toEqual(['trigger', 'send']);
    // Dangling edges would fail validation later with a confusing message.
    expect(result.definition.edges).toHaveLength(0);
  });

  it('adds a node with a generated id when none is given', () => {
    const result = apply([{ op: 'addNode', type: 'APPROVAL', name: 'Check' }]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.definition.nodes).toHaveLength(4);
    expect(result.definition.nodes[3].id).toBe('approval-1');
  });

  it('refuses a node type outside the frozen 17, and says what to use instead', () => {
    const result = apply([{ op: 'addNode', type: 'NOTIFY' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('TOOL_ACTION');
    expect(result.error).toMatch(/does NOT message anyone/i);
  });

  it('protects the trigger from removal and duplication', () => {
    expect(apply([{ op: 'removeNode', id: 'trigger' }]).ok).toBe(false);
    expect(apply([{ op: 'addNode', type: 'TRIGGER' }]).ok).toBe(false);
  });

  // Edge rules must match the canvas's, or the agent can produce a graph the
  // user is then prevented from fixing by hand.
  describe('edge rules mirror the canvas', () => {
    it('rejects a self-loop', () => {
      expect(apply([{ op: 'addEdge', from: 'think', to: 'think' }]).ok).toBe(false);
    });

    it('rejects an edge INTO the trigger', () => {
      expect(apply([{ op: 'addEdge', from: 'send', to: 'trigger' }]).ok).toBe(false);
    });

    it('rejects a duplicate edge', () => {
      expect(apply([{ op: 'addEdge', from: 'trigger', to: 'think' }]).ok).toBe(false);
    });

    it('rejects a cycle', () => {
      expect(apply([{ op: 'addEdge', from: 'send', to: 'think' }]).ok).toBe(false);
    });

    it('ALLOWS a cycle that closes back onto a LOOP', () => {
      const result = applyGraphPatch(
        {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', config: {} },
            { id: 'loop', type: 'LOOP', config: {} },
            { id: 'body', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 'trigger', to: 'loop' },
            { from: 'loop', to: 'body' },
          ],
        },
        [{ op: 'addEdge', from: 'body', to: 'loop' }],
      );
      expect(result.ok).toBe(true);
    });

    it('rejects an edge out of a stop step', () => {
      const result = applyGraphPatch(
        {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', config: {} },
            { id: 'stop', type: 'TERMINATE', config: {} },
            { id: 'after', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 'trigger', to: 'stop' }],
        },
        [{ op: 'addEdge', from: 'stop', to: 'after' }],
      );
      expect(result.ok).toBe(false);
    });
  });

  it('is ATOMIC — a later failure discards the earlier ops', () => {
    const source = base();
    const result = applyGraphPatch(source, [
      { op: 'renameNode', id: 'think', name: 'Renamed first' },
      { op: 'removeNode', id: 'does-not-exist' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Names the failing op so the model can fix that one.
    expect(result.error).toContain('Change 2');
    // And the input is untouched — a half-applied patch is never observable.
    expect(source.nodes.find((n) => n.id === 'think')?.name).toBe('Score it');
  });

  it('never mutates the input on success either', () => {
    const source = base();
    const result = applyGraphPatch(source, [
      { op: 'renameNode', id: 'think', name: 'New name' },
    ]);
    expect(result.ok).toBe(true);
    expect(source.nodes.find((n) => n.id === 'think')?.name).toBe('Score it');
  });

  it('rejects an empty patch rather than silently doing nothing', () => {
    expect(applyGraphPatch(base(), []).ok).toBe(false);
  });
});
