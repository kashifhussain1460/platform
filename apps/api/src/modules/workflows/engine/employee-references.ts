/**
 * Which AI Employees a workflow graph names, and which one a run is attributed to.
 *
 * ## Why this file exists
 *
 * The PRD's headline claim is that an AI Employee is the primary abstraction and
 * a workflow is something an employee *does*. The schema has carried
 * `WorkflowRun.actingEmployeeId` since the durable-runtime migration to make
 * that true — and the 2026-09-02 audit found the column had **one reference in
 * the entire repository: the line declaring it.** Nothing wrote it, nothing read
 * it, and a run whose only meaningful node was an `AI_EMPLOYEE_STEP` bound to a
 * specific employee came back with `actingEmployeeId: null`.
 *
 * Employee identity did reach the *node* level — persona, per-employee budget,
 * tool permissions, memory scoping and credit-ledger attribution all work. What
 * was missing was the run-level answer to "who did this?", which is the question
 * every dashboard, filter and audit conversation actually starts from.
 *
 * ## The attribution rule
 *
 * `actingEmployeeId` = **the employee referenced by the first employee-bearing
 * node in definition order.**
 *
 * One rule, deterministic, and never null when the graph names anybody:
 *
 * - The overwhelmingly common case is a graph naming exactly one employee, and
 *   then this is simply that employee.
 * - When a graph names several (an HR employee screening, then a Marketing one
 *   writing the announcement), the run is attributed to the one that acts
 *   first — which is the honest reading of "who is running this" — and
 *   {@link employeeIdsInGraph} carries the full set so a UI can say
 *   "Emma + 1 other" instead of picking a favourite.
 *
 * The alternative — null whenever a graph is ambiguous — was rejected because it
 * reintroduces exactly the hole this closes: the runs most worth attributing
 * (the multi-employee ones) would be the ones with no attribution.
 *
 * ## Node order, not topological order
 *
 * Definition order, deliberately. Topological order needs the edge set and is
 * undefined for a disconnected graph, and this value is written at run
 * CREATION — before any traversal has happened and before the engine has
 * decided anything. Authors build graphs top-down, so the first employee node in
 * the array is the one a human would also name. `PARALLEL` branches have no
 * meaningful "first" either way.
 */

/** The shape this module needs — deliberately narrower than `WorkflowNode`. */
interface NodeLike {
  readonly type?: unknown;
  readonly config?: unknown;
}

/**
 * Pull the node array out of an untrusted graph value.
 *
 * The graph arrives as a Prisma `Json` column, so it is `unknown` as far as the
 * type system is concerned and may legitimately be `null` (a workflow that
 * predates versioning) or a shape a much older release wrote. Attribution is
 * metadata: a graph this cannot read must produce "no employee", never a thrown
 * error that stops a run from being created.
 */
export function nodesOf(definition: unknown): NodeLike[] {
  if (typeof definition !== 'object' || definition === null) return [];
  const nodes = (definition as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(
    (n): n is NodeLike => typeof n === 'object' && n !== null,
  );
}

/** `config.employeeId`, when it is a non-empty string. */
function employeeIdOf(node: NodeLike): string | null {
  const config = node.config;
  if (typeof config !== 'object' || config === null) return null;
  const raw = (config as { employeeId?: unknown }).employeeId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // A `{{template}}` placeholder is not an id. It resolves at execution time
  // from run context, so it cannot be attributed at creation — and storing the
  // literal template string as a foreign key would fail the constraint.
  if (trimmed === '' || trimmed.includes('{{')) return null;
  return trimmed;
}

/**
 * Every distinct employee id the graph names, in first-appearance order.
 *
 * Covers `AI_EMPLOYEE_STEP`, `TOOL_ACTION`, `MEMORY_READ`, `MEMORY_WRITE`,
 * `APPROVAL` and `AI_STEP` — every node type whose config carries an
 * `employeeId` — by reading the field rather than switching on `type`, so a new
 * employee-scoped node type is included the day it is added instead of the day
 * someone remembers to update a list here.
 */
export function employeeIdsInGraph(nodes: readonly NodeLike[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const node of nodes) {
    const id = employeeIdOf(node);
    if (id && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/**
 * The employee a run is attributed to, or `null` when the graph names none
 * (a pure integration workflow: trigger → HTTP → condition → notify).
 *
 * `null` here means "no employee was involved", which is a true statement about
 * such a workflow — not the "we never bothered to record it" that the column
 * used to mean.
 */
export function actingEmployeeIdForGraph(nodes: readonly NodeLike[]): string | null {
  return employeeIdsInGraph(nodes)[0] ?? null;
}
