import type { NodeDefinitionDto, NodeType } from '@vaep/types';

/**
 * Connection validity for the editable canvas (doc 29 §5.3). Pure + unit-tested:
 * given a candidate edge and the current graph, decide whether it's allowed and,
 * if not, why (a plain-language reason for the inline `aria-live` hint).
 *
 * Rules: no missing endpoint · no self-loop · nothing into a TRIGGER's input ·
 * nothing out of a no-output node (TERMINATE) · no duplicate edge · no cycle —
 * EXCEPT a back-edge whose target is a LOOP node (the legitimate "iterate" edge).
 */

export interface ConnectionCandidate {
  source: string | null | undefined;
  target: string | null | undefined;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface ConnectionContext {
  /** Resolve a node id to its NodeType (undefined if unknown). */
  nodeType: (id: string) => NodeType | undefined;
  defsByType: Map<NodeType, NodeDefinitionDto>;
  /** The existing edges (definition shape). */
  edges: { from: string; to: string; branch?: string }[];
}

export type ConnectionVerdict = { ok: true } | { ok: false; reason: string };

const DEFAULT_HANDLE = 'default';

function acceptsInput(type: NodeType | undefined, defs: ConnectionContext['defsByType']): boolean {
  if (!type) return true;
  const def = defs.get(type);
  if (def) return def.inputs > 0;
  return type !== 'TRIGGER';
}

function allowsOutput(type: NodeType | undefined, defs: ConnectionContext['defsByType']): boolean {
  if (!type) return true;
  const def = defs.get(type);
  if (def) return def.outputs.length > 0 || Boolean(def.dynamicOutputs);
  return type !== 'TERMINATE';
}

/** Does `to` already reach `from` through existing edges? (i.e. would closing to→from form a cycle) */
function reaches(from: string, to: string, edges: ConnectionContext['edges']): boolean {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from);
    if (list) list.push(e.to);
    else adjacency.set(e.from, [e.to]);
  }
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

export function validateConnection(
  candidate: ConnectionCandidate,
  ctx: ConnectionContext,
): ConnectionVerdict {
  const { source, target } = candidate;
  if (!source || !target) return { ok: false, reason: 'Drag onto a step to connect it.' };
  if (source === target) return { ok: false, reason: "A step can't connect to itself." };

  const sourceType = ctx.nodeType(source);
  const targetType = ctx.nodeType(target);

  if (!acceptsInput(targetType, ctx.defsByType)) {
    return { ok: false, reason: "A trigger has no input — it's where things start." };
  }
  if (!allowsOutput(sourceType, ctx.defsByType)) {
    return { ok: false, reason: 'Stop has no next step.' };
  }

  const branch =
    candidate.sourceHandle && candidate.sourceHandle !== DEFAULT_HANDLE
      ? candidate.sourceHandle
      : undefined;
  const duplicate = ctx.edges.some(
    (e) => e.from === source && e.to === target && (e.branch ?? undefined) === branch,
  );
  if (duplicate) return { ok: false, reason: 'These steps are already connected.' };

  // A cycle is allowed only as a LOOP back-edge (target is the LOOP node).
  if (reaches(target, source, ctx.edges) && targetType !== 'LOOP') {
    return { ok: false, reason: 'That would loop the steps back — only a Loop step can take a back-edge.' };
  }

  return { ok: true };
}
