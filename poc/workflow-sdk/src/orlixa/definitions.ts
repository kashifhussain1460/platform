/**
 * POC ONLY — NOT PRODUCTION.
 *
 * A cut-down copy of Orlixa's WorkflowDefinition JSON contract — the shape that
 * `WorkflowVersion.definition` actually holds. Nothing here is a TypeScript
 * function: the graph is DATA, which is precisely what POC-07 has to prove the
 * Workflow SDK can execute.
 */

export type OrlixaNodeType =
  | 'TRIGGER'
  | 'AI_EMPLOYEE_STEP'
  | 'CONDITION'
  | 'TOOL_ACTION'
  | 'WAIT'
  | 'APPROVAL';

export interface OrlixaNode {
  id: string;
  type: OrlixaNodeType;
  disabled?: boolean;
  config?: Record<string, unknown>;
}

export interface OrlixaEdge {
  from: string;
  to: string;
  /** 'true' | 'false' for a CONDITION; absent = the default edge. */
  branch?: string;
}

export interface OrlixaDefinition {
  nodes: OrlixaNode[];
  edges: OrlixaEdge[];
}

/** Stand-in for the `WorkflowVersion` table. */
export const VERSIONS: Record<string, OrlixaDefinition> = {
  // v1 — publishes without asking anybody.
  v1: {
    nodes: [
      { id: 'n_trigger', type: 'TRIGGER', config: {} },
      { id: 'n_draft', type: 'AI_EMPLOYEE_STEP', config: { prompt: 'Draft the launch post' } },
      { id: 'n_check', type: 'CONDITION', config: { path: 'n_draft.length', op: 'gt', value: 3 } },
      {
        id: 'n_publish',
        type: 'TOOL_ACTION',
        config: { skillTool: 'postiz.publish_now', args: { channel: 'linkedin' } },
      },
      { id: 'n_short', type: 'AI_EMPLOYEE_STEP', config: { prompt: 'Too short — rewrite' } },
    ],
    edges: [
      { from: 'n_trigger', to: 'n_draft' },
      { from: 'n_draft', to: 'n_check' },
      { from: 'n_check', to: 'n_publish', branch: 'true' },
      { from: 'n_check', to: 'n_short', branch: 'false' },
    ],
  },

  // v2 — SAME workflow, but an approval gate was inserted before publishing and
  // a WAIT was added. A run pinned to v1 must never see these nodes.
  v2: {
    nodes: [
      { id: 'n_trigger', type: 'TRIGGER', config: {} },
      { id: 'n_draft', type: 'AI_EMPLOYEE_STEP', config: { prompt: 'Draft the launch post' } },
      { id: 'n_wait', type: 'WAIT', config: { duration: '2s' } },
      { id: 'n_approve', type: 'APPROVAL', config: { reason: 'Marketing sign-off' } },
      {
        id: 'n_publish',
        type: 'TOOL_ACTION',
        config: { skillTool: 'postiz.publish_now', args: { channel: 'linkedin', v: 2 } },
      },
    ],
    edges: [
      { from: 'n_trigger', to: 'n_draft' },
      { from: 'n_draft', to: 'n_wait' },
      { from: 'n_wait', to: 'n_approve' },
      { from: 'n_approve', to: 'n_publish' },
    ],
  },

  // Used by POC-10: the same graph, but the acting employee is not permitted
  // to use the tool. The run must fail at the Orlixa authorization boundary.
  authz: {
    nodes: [
      { id: 'n_trigger', type: 'TRIGGER', config: {} },
      {
        id: 'n_publish',
        type: 'TOOL_ACTION',
        config: { skillTool: 'postiz.publish_now', args: { channel: 'linkedin' } },
      },
    ],
    edges: [{ from: 'n_trigger', to: 'n_publish' }],
  },
};

/** Pure graph helper — safe to run inside a workflow body (no I/O, no clock). */
export function nextNodeId(
  definition: OrlixaDefinition,
  fromNodeId: string,
  branch?: string,
): string | undefined {
  const outgoing = definition.edges.filter((e) => e.from === fromNodeId);
  if (outgoing.length === 0) return undefined;
  if (branch === undefined) return outgoing[0]?.to;
  const matched = outgoing.find((e) => e.branch === branch);
  return (matched ?? outgoing.find((e) => e.branch === undefined))?.to;
}

/** Pure condition evaluation — deliberately NOT a step. */
export function evaluateCondition(
  node: OrlixaNode,
  context: Record<string, unknown>,
): boolean {
  const path = String(node.config?.path ?? '');
  const op = String(node.config?.op ?? 'eq');
  const expected = node.config?.value;

  const actual = path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    if (typeof acc === 'string' && key === 'length') return acc.length;
    return undefined;
  }, context);

  if (op === 'gt') return Number(actual) > Number(expected);
  if (op === 'lt') return Number(actual) < Number(expected);
  return actual === expected;
}
