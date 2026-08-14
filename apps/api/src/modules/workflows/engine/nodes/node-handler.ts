import type { ConditionOp, NodeType, WorkflowNode } from '@vaep/types';

/**
 * P1-03 — the node handler contract.
 *
 * Extracted from `WorkflowEngine`'s `switch (node.type)`. Doc 26 §9 is explicit:
 * the engine must resolve a handler and call it, never branch on the node type
 * itself. Adding a node then means adding one file and one `register()` call —
 * no engine change, no migration, no API change.
 *
 * Behaviour is ported verbatim from the original private `exec*` methods. This
 * is a pure refactor: the existing workflow e2e suites are the proof, and they
 * must pass unchanged.
 */

/** Exactly the shape the original private exec methods returned. */
export interface NodeResult {
  /** Persisted verbatim to WorkflowStepRun.output. */
  output: unknown;
  /** Stored at context[node.config.outputKey] when both are present. */
  contextValue?: unknown;
  /**
   * The context key a handler wants its `contextValue` bound to, overriding
   * `node.config.outputKey`.
   *
   * Exists because SET_VARIABLE's whole contract is "bind under the variable's
   * OWN name" — its doc comment said so, and neither engine implemented it: both
   * bound `contextValue` only when the author had also set an unrelated
   * `outputKey`, so a RUNTIME variable was silently discarded and the next node
   * saw nothing. Found by the first durable LOOP test, which could not read the
   * array a SET_VARIABLE had just written.
   */
  contextKey?: string;
  /** CONDITION branch selector (true/false). */
  conditionResult?: boolean;
  /**
   * NAMED branch selector — the generalisation of `conditionResult` used by
   * SWITCH (P2-02). The engine follows the outgoing edge whose `branch` matches.
   * A handler sets one or the other, never both.
   */
  branch?: string;
  /**
   * Ends the run immediately with this outcome (TERMINATE, P2-02). The engine
   * stops walking; sibling work is not started.
   */
  terminate?: { status: 'COMPLETED' | 'FAILED'; reason?: string };

  // ── Traversal directives ──────────────────────────────────────────────────
  // A handler cannot walk the graph itself — it has no access to edges and no
  // way to write step rows. So a node whose SEMANTICS are about control flow
  // returns a directive and the engine acts on it.
  //
  // This is why the engine still needs no `switch (node.type)`: it reacts to
  // what a handler RETURNS, not to what the node IS. Adding a future
  // control-flow node reuses these fields instead of editing the walk.

  /**
   * Fan out (PARALLEL). The engine runs each lane to completion, then resumes
   * at the join. Lanes execute SEQUENTIALLY — see the note on `laneOutputKey`.
   */
  fanOut?: {
    /** Node ids that start each lane, in declaration order. */
    lanes: string[];
    /** Where the lanes converge. The sub-walk for each lane stops here. */
    joinNodeId: string;
    /** ALL = run every lane · ANY = run the first lane only. */
    mode: 'ALL' | 'ANY';
  };

  /**
   * Iterate a body subgraph once per item (LOOP). The engine binds each item to
   * `itemVar` in the run context before walking the body.
   */
  iterate?: {
    items: unknown[];
    itemVar: string;
    /** First node of the loop body. */
    bodyNodeId: string;
    /** Hard bound; the engine also enforces the run-wide step budget. */
    maxIterations: number;
    /** Where to continue once iteration finishes. */
    doneNodeId?: string;
  };

  /**
   * Pause the run and wait for a human (P2 risk fix: AI_EMPLOYEE_STEP hitting a
   * gated tool). The engine persists context, sets the run WAITING and resumes
   * at `resumeAtSelf` — so the step re-runs and picks up the approved result,
   * rather than failing the run and forcing a manual restart.
   */
  pause?: {
    reason: string;
    approvalId?: string;
    /** Resume at THIS node (the work has not happened yet). */
    resumeAtSelf: true;
  };
}

/** Everything a handler is given. Assembled once per node execution. */
export interface NodeExecContext {
  companyId: string;
  /**
   * The workflow this run belongs to. Needed by any node that persists state
   * beyond the run — WORKFLOW-scope variables outlive a single run, so they are
   * keyed to the workflow.
   */
  workflowId: string;
  /** The run being executed. Present so a handler can correlate its own logs. */
  runId: string;
  node: WorkflowNode;
  /** The run's mutable context bag. Handlers READ this; the engine writes it. */
  context: Record<string, unknown>;
  /** Test mode: side-effecting handlers must preview instead of acting. */
  dryRun: boolean;
  /**
   * Aborted when the node exceeds its execution budget.
   *
   * OPTIONAL because only the durable runtime supplies one — the legacy walker
   * has no per-node timeout to hang it off. A handler that calls out to a slow
   * third party (an LLM, a provider API) should pass this down; one that does
   * not simply keeps the older behaviour of running to completion and having
   * its result discarded.
   *
   * Without it a timed-out node frees its worker slot while the request it
   * started keeps running — for a model call that is real money spent on an
   * answer nobody reads, and no usage row, because the code that would have
   * written one was already unwound.
   */
  signal?: AbortSignal;
}

export interface NodeHandler {
  readonly type: NodeType;
  execute(ctx: NodeExecContext): Promise<NodeResult> | NodeResult;
}

/** DI token for the handler collection the registry is built from. */
export const NODE_HANDLERS = Symbol('NODE_HANDLERS');

// ── Shared helpers ───────────────────────────────────────────────────────────
// Moved out of workflow-engine.service.ts so handlers can use them without
// importing the engine (which imports the registry, which imports handlers —
// a cycle). Logic is unchanged.

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strict numeric parse for a CONDITION's gt/lt operands. Unlike the EVENT
 * trigger DSL (conditions.ts), where a non-numeric operand safely means
 * "don't fire" (fail-closed, no side effect yet), an in-graph CONDITION node
 * sits mid-run: silently treating a bad operand as `NaN`/`0` would route an
 * ALREADY-STARTED run down the wrong branch (an LLM reply like "around 85"
 * instead of "85" would read as `NaN > 79 === false` and silently auto-reject a
 * strong candidate). Throwing fails the step — and the run — with a clear
 * message instead.
 */
export function toNumber(value: string): number {
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (trimmed === '' || Number.isNaN(n)) {
    throw new Error(
      `CONDITION expected a number but got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/** Manual (no-eval) comparison used by CONDITION nodes. */
export function compare(left: string, op: ConditionOp, right: string): boolean {
  switch (op) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'contains':
      return left.includes(right);
    case 'gt':
      return toNumber(left) > toNumber(right);
    case 'lt':
      return toNumber(left) < toNumber(right);
    default:
      return false;
  }
}
