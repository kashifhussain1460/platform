import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@vaep/types';

/**
 * WAVE 1 (gap W1-b) — durable graph traversal.
 *
 * Before this, `RunAdvanceProcessor` picked the next node with
 * `definition.nodes.find((n) => !doneIds.has(n.id))` — DECLARATION ORDER, with
 * `definition.edges` never read at all. On a linear graph authored top-to-bottom
 * that happens to look right; on a CONDITION it runs BOTH branches, which is a
 * silent correctness failure rather than an error. That made the durable runtime
 * unshippable as the production path no matter how good its durability was.
 *
 * These functions are PURE so the routing rules can be tested exhaustively
 * without Postgres, Redis or a Nest context.
 *
 * ## Why routing must be recomputable
 *
 * The advance worker may run long after the step that preceded it (a reaper
 * re-enqueue, a Redis flush, a redeploy). It therefore cannot rely on anything
 * held in memory or in a job payload: the branch a CONDITION/SWITCH selected is
 * persisted on `WorkflowStepRun.branch`, so "what comes next" is always
 * derivable from Postgres alone.
 *
 * Routing rules are ported verbatim from `WorkflowEngine.nextNode` so the two
 * engines cannot diverge while both exist behind the cutover flag.
 */

/** Step statuses that mean "this node is done, move past it". */
const SETTLED = new Set(['COMPLETED', 'SKIPPED']);

/** The minimum a step must expose for routing. */
export interface RoutingStep {
  nodeId: string;
  status: string;
  /** The branch label this node selected, or null when it does not branch. */
  branch: string | null;
  finishedAt?: Date | null;
  createdAt?: Date | null;
}

export class GraphRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphRoutingError';
  }
}

/**
 * Where a fresh run begins: the TRIGGER, else the first declared node.
 * Identical to the legacy walk's start selection.
 */
export function entryNode(
  definition: WorkflowDefinition,
): WorkflowNode | undefined {
  return (
    definition.nodes.find((n) => n.type === 'TRIGGER') ?? definition.nodes[0]
  );
}

/**
 * The node reached by leaving `nodeId` along the edge its recorded `branch`
 * selects. `undefined` means the graph ends here.
 *
 * A node with SOME branch-tagged edges that selected a branch matching NONE of
 * them throws rather than falling back to an arbitrary edge — silently running
 * the wrong downstream steps is the worse outcome, and it is invisible.
 */
export function successorOf(
  definition: WorkflowDefinition,
  nodeId: string,
  branch: string | null,
): WorkflowNode | undefined {
  const outgoing = definition.edges.filter(
    (e: WorkflowEdge) => e.from === nodeId,
  );
  if (outgoing.length === 0) return undefined;

  let edge: WorkflowEdge;
  if (branch !== null && branch !== undefined) {
    const matched = outgoing.find((e) => e.branch === branch);
    const anyBranchTagged = outgoing.some((e) => e.branch);
    if (matched) {
      edge = matched;
    } else if (!anyBranchTagged) {
      edge = outgoing[0];
    } else {
      throw new GraphRoutingError(
        `Node "${nodeId}" selected branch "${branch}", but no outgoing edge has branch="${branch}" (misconfigured workflow)`,
      );
    }
  } else {
    edge = outgoing[0];
  }

  const target = definition.nodes.find((n) => n.id === edge.to);
  if (!target) {
    // A dangling edge must FAIL the run. Returning undefined would end the walk
    // and mark the run COMPLETED, silently skipping every downstream step.
    throw new GraphRoutingError(
      `Edge from node "${nodeId}" points to unknown node "${edge.to}" (invalid workflow graph)`,
    );
  }
  return target;
}

/**
 * The next node that still needs to run, or `undefined` when this chain is
 * finished.
 *
 * `fromNodeId` is a HINT, not a requirement: the attempt worker passes the node
 * it just completed so the common path is one hop. When the hint is missing
 * (reaper recovery, a lost job) the walk restarts from the most recently
 * finished step, which is derivable from Postgres and therefore survives a
 * total Redis loss.
 *
 * Walking forward past already-settled nodes — rather than returning the first
 * unsettled node found anywhere — is what makes a duplicate advance harmless:
 * it lands on the same place the first one did.
 */
export function nextRunnableNode(input: {
  definition: WorkflowDefinition;
  steps: readonly RoutingStep[];
  fromNodeId?: string | null;
  maxHops?: number;
}): WorkflowNode | undefined {
  const { definition, steps, fromNodeId } = input;
  const maxHops = input.maxHops ?? DEFAULT_MAX_HOPS;

  if (definition.nodes.length === 0) return undefined;

  const byNode = new Map<string, RoutingStep>();
  for (const step of steps) {
    // Keep the LATEST row per node: a loop body legitimately has several.
    byNode.set(step.nodeId, step);
  }

  let current: WorkflowNode | undefined;
  if (fromNodeId) {
    current = definition.nodes.find((n) => n.id === fromNodeId);
    if (!current) {
      throw new GraphRoutingError(
        `Advance hint references unknown node "${fromNodeId}" in this version`,
      );
    }
  } else if (steps.length === 0) {
    return entryNode(definition);
  } else {
    const latest = mostRecentlyFinished(steps);
    current = latest
      ? definition.nodes.find((n) => n.id === latest.nodeId)
      : entryNode(definition);
    // The graph was edited under a run pinned to a different version, or the
    // step refers to a node that no longer exists: fall back to the entry.
    if (!current) return entryNode(definition);
  }

  for (let hop = 0; hop < maxHops; hop++) {
    const step = byNode.get(current.id);
    if (!step || !SETTLED.has(step.status)) {
      return current;
    }
    const next = successorOf(definition, current.id, step.branch);
    if (!next) return undefined;
    current = next;
  }

  throw new GraphRoutingError(
    `Traversal exceeded ${maxHops} hops without reaching a runnable node (cyclic graph?)`,
  );
}

/** Latest settled step by finishedAt, falling back to createdAt then order. */
function mostRecentlyFinished(
  steps: readonly RoutingStep[],
): RoutingStep | undefined {
  let best: RoutingStep | undefined;
  let bestAt = -Infinity;
  for (const step of steps) {
    if (!SETTLED.has(step.status)) continue;
    const at = (step.finishedAt ?? step.createdAt)?.getTime?.() ?? 0;
    // `>=` so that, among equal timestamps, the LAST one declared wins — which
    // matches insertion order and keeps the choice deterministic.
    if (at >= bestAt) {
      bestAt = at;
      best = step;
    }
  }
  return best;
}

/**
 * The branch a node selected, in the general form the edges are labelled with.
 * `conditionResult` is just the boolean special case of `branch`.
 */
export function branchOf(result: {
  branch?: string;
  conditionResult?: boolean;
}): string | null {
  if (result.branch !== undefined) return result.branch;
  if (result.conditionResult !== undefined) {
    return result.conditionResult ? 'true' : 'false';
  }
  return null;
}

/** Mirrors the legacy walk's MAX_WORKFLOW_NODES bound. */
const DEFAULT_MAX_HOPS = 50;
