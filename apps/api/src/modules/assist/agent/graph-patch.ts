import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@vaep/types';
import { isFrozenNodeType, rejectionFor } from './frozen-node-types';

/**
 * Apply a list of edits to a workflow graph.
 *
 * Pure and total: it never mutates its input and never throws. It returns either
 * the new graph or the first problem, so the caller can hand that problem back
 * to the model as a correction.
 *
 * ── Why patches at all, when `propose_graph` replaces the whole thing ────────
 * Models are reliably good at emitting one small complete graph and reliably bad
 * at long mutation sequences — which is why CREATION uses whole-graph. Editing is
 * the opposite case: re-emitting a 20-step workflow to change one field invites
 * silent drops of the steps it wasn't thinking about. So edits are patches.
 *
 * ── Atomicity ───────────────────────────────────────────────────────────────
 * Ops apply to a CLONE. If any op fails, nothing is returned and the caller keeps
 * the original — a half-applied patch is never observable.
 */

export type GraphPatchOp =
  | { op: 'addNode'; id?: string; type: string; name?: string; config?: Record<string, unknown> }
  | { op: 'removeNode'; id: string }
  | { op: 'updateNodeConfig'; id: string; config: Record<string, unknown>; merge?: boolean }
  | { op: 'renameNode'; id: string; name: string }
  | { op: 'addEdge'; from: string; to: string; branch?: string }
  | { op: 'removeEdge'; from: string; to: string; branch?: string };

export type PatchResult =
  | { ok: true; definition: WorkflowDefinition; applied: number }
  | { ok: false; error: string };

export function applyGraphPatch(
  source: WorkflowDefinition,
  ops: GraphPatchOp[],
): PatchResult {
  if (ops.length === 0) {
    return { ok: false, error: 'The patch had no changes in it.' };
  }

  // Deep-ish clone: nodes and edges are replaced wholesale below, and configs are
  // copied on write, so a shallow copy per element is enough and much cheaper
  // than serialising the whole graph.
  let nodes: WorkflowNode[] = source.nodes.map((n) => ({ ...n }));
  let edges: WorkflowEdge[] = source.edges.map((e) => ({ ...e }));

  for (const [index, op] of ops.entries()) {
    const at = `Change ${index + 1} (${op.op})`;
    const fail = (reason: string): PatchResult => ({
      ok: false,
      error: `${at} could not be applied: ${reason}`,
    });

    switch (op.op) {
      case 'addNode': {
        if (!isFrozenNodeType(op.type)) return fail(rejectionFor(op.type));
        const id = op.id?.trim() || generateId(op.type, nodes);
        if (nodes.some((n) => n.id === id)) {
          return fail(`there is already a step called "${id}".`);
        }
        if (op.type === 'TRIGGER' && nodes.some((n) => n.type === 'TRIGGER')) {
          return fail('a workflow can only have one trigger.');
        }
        nodes = [
          ...nodes,
          {
            id,
            type: op.type as WorkflowNode['type'],
            config: op.config ?? {},
            ...(op.name ? { name: op.name } : {}),
          },
        ];
        break;
      }

      case 'removeNode': {
        if (!nodes.some((n) => n.id === op.id)) {
          return fail(`there is no step called "${op.id}".`);
        }
        const target = nodes.find((n) => n.id === op.id);
        if (target?.type === 'TRIGGER') {
          return fail(
            'the trigger starts the workflow, so it cannot be removed — replace it instead.',
          );
        }
        nodes = nodes.filter((n) => n.id !== op.id);
        // Dangling edges would fail validation later with a confusing message,
        // so they go with the node.
        edges = edges.filter((e) => e.from !== op.id && e.to !== op.id);
        break;
      }

      case 'updateNodeConfig': {
        const i = nodes.findIndex((n) => n.id === op.id);
        if (i === -1) return fail(`there is no step called "${op.id}".`);
        nodes[i] = {
          ...nodes[i],
          config:
            op.merge === false
              ? { ...op.config }
              : { ...nodes[i].config, ...op.config },
        };
        break;
      }

      case 'renameNode': {
        const i = nodes.findIndex((n) => n.id === op.id);
        if (i === -1) return fail(`there is no step called "${op.id}".`);
        if (!op.name.trim()) return fail('the new name was empty.');
        nodes[i] = { ...nodes[i], name: op.name.trim() };
        break;
      }

      case 'addEdge': {
        const problem = edgeProblem(nodes, edges, op.from, op.to, op.branch);
        if (problem) return fail(problem);
        edges = [
          ...edges,
          { from: op.from, to: op.to, ...(op.branch ? { branch: op.branch } : {}) },
        ];
        break;
      }

      case 'removeEdge': {
        const before = edges.length;
        edges = edges.filter(
          (e) =>
            !(
              e.from === op.from &&
              e.to === op.to &&
              (op.branch === undefined || e.branch === op.branch)
            ),
        );
        if (edges.length === before) {
          return fail(`there is no connection from "${op.from}" to "${op.to}".`);
        }
        break;
      }

      default:
        return fail('that is not a change I know how to make.');
    }
  }

  return { ok: true, definition: { nodes, edges }, applied: ops.length };
}

/**
 * The same rules the CANVAS enforces (`connectionRules.ts`), so the agent cannot
 * draw a connection a human would be prevented from drawing. Keeping these in
 * step matters: a graph only the agent can produce is a graph the user cannot
 * then fix by hand.
 */
function edgeProblem(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  from: string,
  to: string,
  branch?: string,
): string | null {
  if (from === to) return 'a step cannot connect to itself.';

  const source = nodes.find((n) => n.id === from);
  const target = nodes.find((n) => n.id === to);
  if (!source) return `there is no step called "${from}".`;
  if (!target) return `there is no step called "${to}".`;

  if (target.type === 'TRIGGER') {
    return 'nothing can lead into the trigger — it is where the workflow starts.';
  }
  if (source.type === 'TERMINATE') {
    return 'a stop step ends the run, so nothing can follow it.';
  }
  if (
    edges.some((e) => e.from === from && e.to === to && e.branch === branch)
  ) {
    return 'those two steps are already connected that way.';
  }
  // A cycle is only legitimate when it closes back onto a LOOP.
  if (target.type !== 'LOOP' && createsCycle(edges, from, to)) {
    return 'that would make the workflow loop back on itself.';
  }
  return null;
}

/** Would adding from→to create a cycle? (Is `from` reachable from `to`?) */
function createsCycle(edges: WorkflowEdge[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === from) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const e of edges) {
      if (e.from === current) stack.push(e.to);
    }
  }
  return false;
}

/** `tool_action-3` style — readable, and stable within one patch. */
function generateId(type: string, nodes: WorkflowNode[]): string {
  const base = type.toLowerCase();
  let n = 1;
  while (nodes.some((node) => node.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
