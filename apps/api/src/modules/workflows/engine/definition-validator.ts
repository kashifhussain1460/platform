import { BadRequestException } from '@nestjs/common';
import { NODE_TYPES, type WorkflowDefinition } from '@vaep/types';
import { MAX_WORKFLOW_NODES } from '../workflows.constants';

export interface ValidationIssue {
  nodeId: string | null;
  code: string;
  message: string;
}

/** Secret-ish words, matched as a whole trailing segment of the key. */
const SECRET_KEY_RE =
  /(?:^|_)(?:secret|password|passwd|apikey|api_key|token|credential|privatekey)s?$/;

/**
 * Whether a config key looks like it holds a credential.
 *
 * camelCase is split first (`clientSecret` → `client_secret`), because a plain
 * word-boundary regex misses exactly the spelling developers use most.
 * `tokenizer` must NOT match — a false positive here blocks a legitimate save.
 */
function looksLikeSecretKey(key: string): boolean {
  const normalised = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return SECRET_KEY_RE.test(normalised);
}

/**
 * Structural + semantic validation for a workflow definition (P2-04).
 *
 * Shared by manual create/update (WorkflowsService), draft publish
 * (WorkflowVersionService) and AI generation (WorkflowGeneratorService), so a
 * graph cannot enter the system through a side door unchecked.
 *
 * Issues are collected and reported TOGETHER: on a 30-node graph, fixing one
 * problem per round-trip is unusable.
 *
 * BACKWARDS COMPATIBILITY: every rule either already held (unique ids,
 * resolvable edges) or applies only to node types that did not exist before P2.
 * `STARTER_DEFINITION` (a lone TRIGGER) stays valid.
 */
export function collectDefinitionIssues(
  definition: WorkflowDefinition,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const edges = Array.isArray(definition?.edges) ? definition.edges : [];

  const push = (nodeId: string | null, code: string, message: string) =>
    issues.push({ nodeId, code, message });

  // Unique ids (pre-existing rule — message text preserved for callers/tests).
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      push(
        node.id,
        'DUPLICATE_NODE_ID',
        `Duplicate node id "${node.id}" in workflow definition`,
      );
    }
    ids.add(node.id);
  }

  // Edges resolve (pre-existing rule — message text preserved).
  for (const edge of edges) {
    if (!ids.has(edge.from)) {
      push(
        null,
        'UNKNOWN_EDGE_SOURCE',
        `Edge references unknown node id "${edge.from}"`,
      );
    }
    if (!ids.has(edge.to)) {
      push(
        null,
        'UNKNOWN_EDGE_TARGET',
        `Edge references unknown node id "${edge.to}"`,
      );
    }
  }

  // Every node has a type the registry knows.
  const known = new Set<string>(NODE_TYPES);
  for (const node of nodes) {
    if (!known.has(node.type)) {
      push(
        node.id,
        'UNKNOWN_NODE_TYPE',
        `Node "${node.id}" has unknown type "${String(node.type)}"`,
      );
    }
  }

  // V12 — graph size. The engine caps visits at runtime too, but a graph that
  // can never finish should be rejected at save time, not discovered mid-run.
  if (nodes.length > MAX_WORKFLOW_NODES) {
    push(
      null,
      'GRAPH_TOO_LARGE',
      `Workflow has ${nodes.length} nodes, above the ${MAX_WORKFLOW_NODES} limit`,
    );
  }

  // V1 — at most one TRIGGER, and it is the entry node.
  // Deliberately NOT "at least one": a lone-TRIGGER starter graph and existing
  // saved drafts must stay valid, and the engine already falls back to the first
  // node when no TRIGGER is present.
  const triggers = nodes.filter((n) => n.type === 'TRIGGER');
  if (triggers.length > 1) {
    push(
      triggers[1].id,
      'SINGLE_TRIGGER_REQUIRED',
      `A workflow may have at most one TRIGGER node; found ${triggers.length}`,
    );
  }
  for (const trigger of triggers) {
    if (edges.some((e) => e.to === trigger.id)) {
      push(
        trigger.id,
        'TRIGGER_NOT_ENTRY',
        `TRIGGER node "${trigger.id}" is the entry point and cannot have an incoming edge`,
      );
    }
    // The engine skips a disabled node and walks on from it. Doing that to the
    // entry node would leave the run with no root, so this is rejected rather
    // than silently producing a workflow that starts nowhere.
    if (trigger.disabled) {
      push(
        trigger.id,
        'TRIGGER_NOT_DISABLABLE',
        `TRIGGER node "${trigger.id}" cannot be disabled — it is the entry point`,
      );
    }
  }

  // V11 — no inline secret in any node config. A secret in config is persisted
  // verbatim into the immutable version JSON, which surfaces in run history and
  // DLQ dumps.
  for (const node of nodes) {
    for (const key of Object.keys(node.config ?? {})) {
      if (looksLikeSecretKey(key)) {
        push(
          node.id,
          'INLINE_SECRET_FORBIDDEN',
          `Node "${node.id}" config key "${key}" looks like an inline secret. ` +
            `Reference the connector's stored credentials instead — node config is ` +
            `persisted verbatim into run history.`,
        );
      }
    }
  }

  // Per-node config rules for the P2 additions.
  for (const node of nodes) {
    const cfg = node.config ?? {};
    const outgoing = edges.filter((e) => e.from === node.id);

    if (node.type === 'SWITCH') {
      const cases = Array.isArray(cfg.cases) ? cfg.cases : [];
      if (cases.length === 0) {
        push(node.id, 'SWITCH_NO_CASES', `SWITCH node "${node.id}" has no cases`);
      }
      const branches = new Set<string>();
      for (const c of cases) {
        const branch =
          c && typeof c === 'object'
            ? (c as { branch?: unknown }).branch
            : undefined;
        if (typeof branch === 'string' && branch) branches.add(branch);
      }
      if (typeof cfg.default === 'string' && cfg.default) {
        branches.add(cfg.default);
      }
      // A declared branch with no matching edge dead-ends the run mid-flight.
      for (const branch of branches) {
        if (!outgoing.some((e) => e.branch === branch)) {
          push(
            node.id,
            'MISSING_BRANCH_EDGE',
            `SWITCH node "${node.id}" declares branch "${branch}" but no outgoing edge is tagged with it`,
          );
        }
      }
    }

    if (node.type === 'SET_VARIABLE') {
      if (typeof cfg.name !== 'string' || !cfg.name.trim()) {
        push(
          node.id,
          'INVALID_CONFIG',
          `SET_VARIABLE node "${node.id}" needs a variable name`,
        );
      }
      const scope = typeof cfg.scope === 'string' ? cfg.scope : 'RUNTIME';
      if (['SECRET', 'ENVIRONMENT', 'INPUT', 'GLOBAL'].includes(scope)) {
        push(
          node.id,
          'READ_ONLY_SCOPE',
          `SET_VARIABLE node "${node.id}" cannot write scope ${scope} — it is read-only to a workflow`,
        );
      }
    }

    if (node.type === 'MEMORY_READ' || node.type === 'MEMORY_WRITE') {
      if (typeof cfg.employeeId !== 'string' || !cfg.employeeId.trim()) {
        push(
          node.id,
          'INVALID_CONFIG',
          `${node.type} node "${node.id}" needs an employeeId`,
        );
      }
      if (
        node.type === 'MEMORY_WRITE' &&
        (typeof cfg.content !== 'string' || !cfg.content.trim())
      ) {
        push(
          node.id,
          'INVALID_CONFIG',
          `MEMORY_WRITE node "${node.id}" needs content to store`,
        );
      }
    }

    if (node.type === 'AI_EMPLOYEE_STEP') {
      if (typeof cfg.employeeId !== 'string' || !cfg.employeeId.trim()) {
        push(
          node.id,
          'INVALID_CONFIG',
          `AI_EMPLOYEE_STEP node "${node.id}" needs an employeeId`,
        );
      }
      if (typeof cfg.instruction !== 'string' || !cfg.instruction.trim()) {
        push(
          node.id,
          'INVALID_CONFIG',
          `AI_EMPLOYEE_STEP node "${node.id}" needs an instruction`,
        );
      }
    }

    if (node.type === 'TERMINATE' && outgoing.length > 0) {
      push(
        node.id,
        'TERMINATE_HAS_OUTGOING_EDGE',
        `TERMINATE node "${node.id}" ends the run, so it cannot have an outgoing edge`,
      );
    }
  }

  // ── Control-flow wiring ───────────────────────────────────────────────────
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    const cfg = node.config ?? {};

    if (node.type === 'PARALLEL') {
      const lanes = Array.isArray(cfg.lanes)
        ? cfg.lanes.filter((l): l is string => typeof l === 'string' && !!l)
        : [];
      const joinNodeId = typeof cfg.joinNodeId === 'string' ? cfg.joinNodeId : '';

      if (lanes.length === 0) {
        push(node.id, 'PARALLEL_NO_LANES', `PARALLEL node "${node.id}" declares no lanes`);
      }
      if (!joinNodeId) {
        push(
          node.id,
          'UNJOINED_PARALLEL',
          `PARALLEL node "${node.id}" has no joinNodeId — its lanes would never converge`,
        );
      } else if (byId.get(joinNodeId)?.type !== 'JOIN') {
        push(
          node.id,
          'UNJOINED_PARALLEL',
          `PARALLEL node "${node.id}" joinNodeId "${joinNodeId}" is not a JOIN node`,
        );
      }
      for (const lane of lanes) {
        if (!byId.has(lane)) {
          push(
            node.id,
            'UNKNOWN_LANE_START',
            `PARALLEL node "${node.id}" references unknown lane start "${lane}"`,
          );
        } else if (byId.get(lane)?.type === 'PARALLEL') {
          // Doc 26 §8: lanes run sequentially, so nesting multiplies the step
          // budget in a way that is not worth reasoning about before there is demand.
          push(
            node.id,
            'NESTED_PARALLEL',
            `PARALLEL node "${node.id}" starts lane "${lane}" which is itself PARALLEL — nesting is not supported`,
          );
        }
      }
    }

    if (node.type === 'LOOP') {
      const requested = Number(cfg.maxIterations);
      if (!Number.isFinite(requested) || requested <= 0) {
        push(
          node.id,
          'UNBOUNDED_LOOP',
          `LOOP node "${node.id}" needs a positive maxIterations — an unbounded loop is never valid`,
        );
      }
      const body = typeof cfg.body === 'string' ? cfg.body : '';
      if (!body) {
        push(node.id, 'INVALID_CONFIG', `LOOP node "${node.id}" needs a body node id`);
      } else if (!byId.has(body)) {
        push(
          node.id,
          'INVALID_CONFIG',
          `LOOP node "${node.id}" references unknown body node "${body}"`,
        );
      }
      if (typeof cfg.over !== 'string' || !cfg.over) {
        push(node.id, 'INVALID_CONFIG', `LOOP node "${node.id}" needs an "over" path`);
      }
    }
  }

  // Doc 26 §8: an APPROVAL inside a loop body would ask a human once per
  // iteration. Always a mistake, so rejected rather than warned about.
  for (const loop of nodes.filter((n) => n.type === 'LOOP')) {
    const bodyId =
      typeof loop.config?.body === 'string' ? loop.config.body : '';
    if (!bodyId || !byId.has(bodyId)) continue;
    for (const reached of reachableFrom(bodyId, edges, loop.id)) {
      if (byId.get(reached)?.type === 'APPROVAL') {
        push(
          reached,
          'INCOMPATIBLE_PLACEMENT',
          `APPROVAL node "${reached}" sits inside LOOP "${loop.id}" — it would ask a human once per iteration`,
        );
      }
    }
  }

  // V5 — cycles. A cycle through anything but a LOOP body means the walk only
  // stops at the run-wide visit cap, surfacing as a confusing "exceeded max node
  // count" long after the actual mistake.
  const loopNodeIds = new Set(
    nodes.filter((n) => n.type === 'LOOP').map((n) => n.id),
  );
  for (const cycle of findCycles(nodes.map((n) => n.id), edges, loopNodeIds)) {
    push(
      cycle[0],
      'CYCLE_DETECTED',
      `Cycle detected: ${cycle.join(' → ')}. Only a LOOP body may loop back.`,
    );
  }

  return issues;
}

/** Node ids reachable from `startId` without traversing back through `stopId`. */
function reachableFrom(
  startId: string,
  edges: WorkflowDefinition['edges'],
  stopId: string,
): Set<string> {
  const seen = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (id === stopId || seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) {
      if (edge.from === id) queue.push(edge.to);
    }
  }
  return seen;
}

/**
 * Cycles in the graph, ignoring edges that point AT a LOOP node — a body looping
 * back to its LOOP is legitimate and bounded by `maxIterations`.
 *
 * Iterative DFS with an explicit stack, not recursion: a pathological graph is
 * exactly the input this exists to reject, so it must not blow the call stack
 * on the way to rejecting it.
 */
function findCycles(
  ids: string[],
  edges: WorkflowDefinition['edges'],
  loopNodeIds: Set<string>,
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of edges) {
    if (loopNodeIds.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const cycles: string[][] = [];

  for (const root of ids) {
    if (colour.get(root) !== WHITE) continue;
    const stack: { id: string; path: string[] }[] = [{ id: root, path: [root] }];
    colour.set(root, GREY);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const next = adjacency.get(top.id)?.shift();
      if (next === undefined) {
        colour.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      if (colour.get(next) === GREY) {
        const from = top.path.indexOf(next);
        cycles.push([...top.path.slice(from === -1 ? 0 : from), next]);
        continue;
      }
      if (colour.get(next) === WHITE) {
        colour.set(next, GREY);
        stack.push({ id: next, path: [...top.path, next] });
      }
    }
  }
  return cycles;
}

/**
 * Throwing wrapper. Signature unchanged so every existing caller keeps working.
 */
export function validateDefinitionStructure(
  definition: WorkflowDefinition,
): void {
  const issues = collectDefinitionIssues(definition);
  if (issues.length === 0) return;

  // ONE message listing every problem — a 30-node graph fixed one error per
  // request is unusable. The first issue's text leads so single-problem
  // messages stay readable.
  if (issues.length === 1) {
    throw new BadRequestException(issues[0].message);
  }
  const detail = issues
    .map((i) => `• ${i.nodeId ? `[${i.nodeId}] ` : ''}${i.message}`)
    .join('\n');
  throw new BadRequestException(
    `Workflow definition has ${issues.length} problems:\n${detail}`,
  );
}
