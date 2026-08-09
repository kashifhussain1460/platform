import type { Edge } from '@xyflow/react';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@vaep/types';
import type { WorkflowCanvasNode } from './definitionToFlow';

const DEFAULT_HANDLE = 'default';

/**
 * Serialize the live React Flow graph back into a persistable
 * `WorkflowDefinition` (the inverse of `definitionToFlow`). Node identity/config
 * come from the node's original `data.node`; the current canvas `position` is
 * captured (rounded) so a manual layout survives Save; an edge's `sourceHandle`
 * becomes its `branch` (the synthetic 'default' handle carries no branch).
 *
 * Pure — no wall clock, no side effects — so autosave payloads are deterministic
 * and the round-trip with `definitionToFlow` is unit-testable.
 */
export function flowToDefinition(
  nodes: WorkflowCanvasNode[],
  edges: Edge[],
): WorkflowDefinition {
  return {
    nodes: nodes.map((n) => {
      const base = n.data.node;
      const node: WorkflowNode = {
        id: base.id,
        type: base.type,
        config: base.config ?? {},
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      };
      if (base.name !== undefined) node.name = base.name;
      // Only emitted when actually disabled, so an untouched graph round-trips
      // byte-identically instead of gaining `disabled: false` everywhere.
      if (base.disabled) node.disabled = true;
      return node;
    }),
    edges: edges.map((e) => {
      const branch =
        e.sourceHandle && e.sourceHandle !== DEFAULT_HANDLE ? e.sourceHandle : undefined;
      const edge: WorkflowEdge = { from: e.source, to: e.target };
      if (branch) edge.branch = branch;
      return edge;
    }),
  };
}
