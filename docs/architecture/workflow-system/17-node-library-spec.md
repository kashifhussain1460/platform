# 17 — Node Library Specification (L2)

> **Level:** L2.
> **Extends:** `02-node-architecture.md` (the `NodeHandler` contract, the registry, and the **8
> existing** node types ported unchanged). `00 §0.7.1` is the normative `NodeType` union (26 values).
> **This document specifies the 18 NEW node types** — one implementation contract each. It does not
> restate the registry or re-port the existing 8.
> **Runtime semantics** (leases, retry, idempotency) come from `16-workflow-runtime-spec.md`.

---

## 1. Purpose

Give each new node type a buildable definition: config schema, output shape, edge semantics, failure
modes, and its one non-obvious implementation trap.

## 2. Scope

The 18 values in `00 §0.7.1` marked `// NEW`. Grouped by `NodeCategory`.

## 3. Responsibilities · 4. Non-responsibilities

Own per-node config validation, execution, and output contract. Do **not** own scheduling, retry, or
persistence (doc 16), permissions (doc 09), or variable resolution (doc 06).

## 5. Dependencies

`NodeRegistry` (doc 02); `AttemptContext` (doc 16 §8); `SkillCatalog` + `toolRequiresApproval`;
`LlmProvider`; `KnowledgeService`; `EmployeeMemory`.

---

## 6. The uniform node contract

Every new node implements the doc-02 handler. L2 additions:

```ts
export interface NodeDefinition<C = unknown, O = unknown> {
  type: NodeType;
  category: NodeCategory;
  configSchema: ZodType<C>;          // validated at PUBLISH, not at run
  outputSchema: ZodType<O>;
  /** Declared edge labels. Empty = single unlabelled edge. */
  branches: readonly string[];
  /** True if execution can touch the outside world → needs idempotency + approval gate. */
  hasSideEffect: boolean;
  timeoutMs?: number;                // default 30_000 (doc 16 §6.6)
  execute(ctx: AttemptContext, config: C): Promise<NodeOutcome<O>>;
}

export type NodeOutcome<O> =
  | { kind: 'OK'; output: O; branch?: string }
  | { kind: 'WAIT'; resumeAt?: Date; reason: string }
  | { kind: 'TERMINATE'; status: 'COMPLETED' | 'FAILED'; reason: string };
```

`NodeOutcome` is the L2 addition that matters: a node returns **what happened**, and the runtime
decides what to do. Nodes never write run status themselves — that keeps doc 16 §7's transition matrix
the single writer.

`configSchema` is validated at publish time so a broken graph cannot be activated. Validating only at
run time means the failure surfaces to an end user mid-process instead of to the author.

---

## 7. Node specifications

### 7.1 LOGIC — `SWITCH`
Multi-way branch. Config: `{ on: string; cases: Array<{ value: string; branch: string }>; default?: string }`.
Resolves `on` as a template, compares as **string** after `String(v)` coercion, follows the matching
branch label. No match and no `default` ⇒ `VALIDATION_ERROR`.
**Trap:** `1` and `'1'` must compare equal or authors will be baffled; coerce explicitly and document it.

### 7.2 LOGIC — `PARALLEL`
Fans out to every outgoing edge as an independent lane (doc 05 §5.B). Config: `{ maxConcurrency?: number }`.
Emits no output of its own. **Must** be paired with a `JOIN`; publish-time validation rejects a
`PARALLEL` with no reachable `JOIN`, otherwise the run completes with lanes still running.

### 7.3 LOGIC — `JOIN`
Config: `{ mode: 'ALL' | 'ANY' | 'COUNT'; count?: number }`. Uses `WorkflowJoinState` with the atomic
increment from doc 16 §14 — never read-then-write.
`ALL` waits for every inbound lane; `ANY` proceeds on the first and **cancels** the rest; `COUNT` waits
for `count`. Output merges lane outputs keyed by lane id.
**Trap:** a lane that fails must still arrive at the join (as failed), or `ALL` hangs until the run
deadline.

### 7.4 LOGIC — `LOOP`
Config: `{ over: string; itemVar: string; maxIterations: number; body: string }` (`body` = entry node id).
Bounded by `maxIterations` **and** the per-run step budget (§0.8). Iterations are **sequential** — a
parallel loop is `PARALLEL` + `JOIN`, deliberately not folded in here.
**Trap:** the item variable must be scoped per iteration; leaking it across iterations is the classic
closure bug and shows up only with async bodies.

### 7.5 LOGIC — `SUB_WORKFLOW`
Config: `{ workflowId: string; versionPin?: 'ACTIVE' | number; input?: Record<string, unknown>; waitForCompletion: boolean }`.
Child gets its own `WorkflowRun` with `parentRunId` and the parent's `correlationId`.
**Depth cap 5**; exceeding ⇒ `VALIDATION_ERROR`. Cycle detection at publish time (A calls B calls A).
Parent cancellation cascades to children.
**Trap:** pin the version. Resolving `ACTIVE` at each call means a child publish silently changes parent
behaviour mid-flight.

### 7.6 LOGIC — `TERMINATE`
Config: `{ status: 'COMPLETED' | 'FAILED'; reason?: string }`. Returns
`{ kind: 'TERMINATE' }`. Ends the run immediately; other lanes are cancelled.

### 7.7 AI_EMPLOYEE — `AI_EMPLOYEE_STEP`
Runs a full AI Employee turn (plan → retrieve → memory → act → validate) rather than a bare prompt.
Config: `{ employeeId: string; instruction: string; maxToolCalls?: number }`.
Every tool call inside **must** pass `toolRequiresApproval` (G25). Approval pauses the whole run.
**Trap:** `maxToolCalls` defaults to 3 (matching the chat runtime); unbounded here is a cost incident.

### 7.8 AI_EMPLOYEE — `AI_DECISION`
Constrained classification into one of the declared branches.
Config: `{ prompt: string; branches: string[]; fallbackBranch?: string }`.
The LLM is forced to return exactly one branch label; anything else ⇒ `fallbackBranch`, or
`VALIDATION_ERROR` if unset.
**Trap:** never route on free-text LLM output. Validate against `branches` before following an edge.

### 7.9 AI_EMPLOYEE — `AI_EXTRACT`
Config: `{ prompt: string; schema: JSONSchema; source: string }`. Returns structured JSON validated
against `schema`; validation failure is retryable **once** with the errors fed back, then
`VALIDATION_ERROR`.

### 7.10 AI_EMPLOYEE — `AI_CLASSIFY`
Config: `{ input: string; labels: string[]; multi?: boolean }`. Output `{ labels: string[]; confidence: number }`.
Distinct from `AI_DECISION`: classify **labels data**, decide **routes the graph**.

### 7.11 KNOWLEDGE — `KNOWLEDGE_WRITE`
Config: `{ content: string; category?: EmployeeRole | null; title?: string }`. Writes a
`KnowledgeDocument` + chunks via the ingest queue. `hasSideEffect: true`.
**Trap:** a workflow that writes knowledge it later retrieves can build a feedback loop; document it and
default `category` to the acting employee's role.

### 7.12 MEMORY — `MEMORY_READ` / 7.13 `MEMORY_WRITE`
Read: `{ employeeId: string; kind?: MemoryKind; limit?: number }`.
Write: `{ employeeId: string; kind: MemoryKind; content: string }`.
Memory is per-employee and tenant-scoped; a cross-employee read requires the permission check in doc 09.

### 7.14 VARIABLE — `SET_VARIABLE`
Config: `{ name: string; value: unknown; scope: VariableScope }`. Writing to `SECRET` scope from a
workflow is **forbidden** ⇒ `VALIDATION_ERROR`. `ENVIRONMENT` is read-only at runtime.

### 7.15 VARIABLE — `TRANSFORM`
Config: `{ input: string; operations: TransformOp[] }` where ops are a **closed set** (`jsonPath`,
`map`, `filter`, `join`, `split`, `toNumber`, `toString`, `default`).
**No `eval`, no expression language, ever.** An arbitrary-expression node is remote code execution
inside a multi-tenant runtime. If authors need more, extend the closed set.

### 7.16 UTILITY — `NOOP`
No config, no output. Exists as a join target and a graph placeholder.

### 7.17 EXTERNAL_API — `HTTP_REQUEST`
Config: `{ method, url, headers?, body?, timeoutMs?, expectStatus? }`.
`hasSideEffect: true` for anything but `GET`.
**Must** pass the existing SSRF guard: no private ranges, no link-local, no redirects to them, DNS
re-resolution checked after redirect. Credentials come from a referenced connector, never inline in
config — inline secrets end up in run history and DLQ dumps.

### 7.18 DATABASE — `DB_QUERY`
Reads **only** from the tenant's own application data through a whitelisted, parameterised query
catalog. Config: `{ queryKey: string; params: Record<string, unknown> }`.
**No raw SQL from workflow config, under any circumstances.** `queryKey` indexes a code-defined
catalog, exactly as `SkillCatalog` does for tools. This is the single highest-risk node in the library
and the closed catalog is what makes it safe.

---

## 8–9. Contracts · 10. Validation

Publish-time validation per node: config parses against `configSchema`; declared `branches` match the
graph's outgoing edge labels; `PARALLEL` reaches a `JOIN`; `SUB_WORKFLOW` depth and cycles; `LOOP` has
`maxIterations`. Failures return `422` with a per-node error list (doc 13's envelope), not a single
opaque message.

## 11–14. Errors · Retry · Idempotency · Concurrency

Inherited from doc 16. Node-specific: nodes with `hasSideEffect: true` **must** accept and forward the
`idempotencyKey` from `AttemptContext`. Nodes with `hasSideEffect: false` are freely retryable.

## 15–18. DB · API · Events · Queues

Node metadata is served by `GET /workflow-nodes` and `GET /workflow-nodes/:type` (doc 13) — generated
from the registry, never hand-maintained, so the UI palette cannot drift from the runtime.

## 19–22. Security · Tenancy · Permissions · Audit

`HTTP_REQUEST`, `DB_QUERY` and `SUB_WORKFLOW` are the three nodes that can cross a boundary and each is
constrained above. Every node receives `companyId` in `AttemptContext` and must scope every query by it.
`hasSideEffect` nodes write a `SkillExecution`-equivalent audit row.

## 23–24. Observability · Performance

Metrics tagged by `nodeType`. Per-node p95 published; the runtime's own overhead stays within the 50ms
budget regardless of node cost (doc 16 §24).

## 25–26. Edge cases · Failures

| Case | Behaviour |
|---|---|
| `SWITCH` no match, no default | `VALIDATION_ERROR` |
| `JOIN` lane never arrives | Run deadline → `TIMED_OUT` |
| `LOOP` over a non-array | `VALIDATION_ERROR` |
| `SUB_WORKFLOW` child fails | Parent fails unless `onError: CONTINUE` |
| `AI_DECISION` returns an unknown label | `fallbackBranch`, else `VALIDATION_ERROR` |
| `HTTP_REQUEST` redirected to a private IP | Blocked by SSRF guard, `FAILED` |

## 27. Testing

Per node: config-schema accept/reject; happy path; each declared failure mode; idempotency for
side-effecting nodes. Plus graph-level tests for `PARALLEL`/`JOIN`/`LOOP`/`SUB_WORKFLOW`.
Security tests are mandatory for `HTTP_REQUEST` (SSRF) and `DB_QUERY` (injection attempt via `params`).

## 28. Acceptance criteria

1. All 18 registered and returned by `GET /workflow-nodes`.
2. Publish-time validation rejects every §10 case with a per-node message.
3. `TRANSFORM` contains no dynamic evaluation (verified by review + a test asserting an expression
   string is treated as a literal).
4. `DB_QUERY` rejects any `queryKey` not in the catalog.
5. SSRF suite passes for `HTTP_REQUEST`.
6. `SUB_WORKFLOW` depth cap and cycle detection enforced at publish.
7. Every `hasSideEffect` node forwards `idempotencyKey`.

## 29. Implementation notes

Build order: `NOOP` → `SET_VARIABLE` → `TRANSFORM` (establishes the pattern with no side effects) →
`SWITCH` → `AI_DECISION` → `PARALLEL`/`JOIN` → `LOOP` → `SUB_WORKFLOW` → the AI trio →
`MEMORY_*`/`KNOWLEDGE_WRITE` → `HTTP_REQUEST` → `DB_QUERY` last (highest risk, most review).

## 30. Definition of Done

- [ ] 18 nodes registered, each with config + output schema
- [ ] Publish validation covers every §10 rule
- [ ] `TRANSFORM` closed-set only; no `eval` anywhere in the codebase (CI grep)
- [ ] `DB_QUERY` catalog-only; raw SQL impossible by construction
- [ ] SSRF + injection suites green
- [ ] Node palette generated from the registry
- [ ] Per-node docs generated into `GET /workflow-nodes/:type`

---

**Next:** `19-workflow-templates-spec.md`.
