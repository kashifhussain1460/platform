# 26 — MVP Node Contract · **FROZEN FOR IMPLEMENTATION**

**Frozen:** 2026-08-01 · **Applies to:** HR Employee + Marketing Employee MVP
**Canonical source:** `00 §0.7.1` (`NodeType`, 26 values). **This document freezes a 17-type subset.**
**Extends:** `02-node-architecture.md` (registry), `17-node-library-spec.md` (per-node L2).
**Change policy:** identifiers below are frozen. Changing one requires a written migration strategy
(§9), because `WorkflowVersion.definition` persists them and in-flight runs dereference them.

---

## 1. Headline result

**The MVP needs zero new engine node types.** All 17 required types already exist in the canonical 26.
The requested palette maps onto them without extending `00 §0.7.1`.

That is only true because of one design decision made here:

> **A palette entry is not a node type.** The palette is what an author sees; the node type is what the
> engine dispatches on. Four trigger cards are one `TRIGGER` type with different config. Two AI Employee
> cards are one `AI_EMPLOYEE_STEP` with different roles.

Collapsing these would have meant 6 new engine types, 6 new handlers, and 6 more branches in the
runtime — for zero behavioural difference.

## 2. Three requested items that are **not** nodes

I am not creating these, and the reason matters more than the decision.

| Requested | Reality | Where it actually lives |
|---|---|---|
| **Retry** node | Retry is a **per-node policy**, not a graph step | `retryPolicy` on every node (`00 §0.7.1` `BackoffStrategy`, `maxAttempts`). Doc 16 §12 **forbids compounding retry layers**; a Retry node would add a fourth on top of BullMQ, runtime and connector retries, and the interaction is not analysable |
| **Error Handler** node | Error routing is a **per-node policy plus a port** | `onError: FAIL_RUN \| CONTINUE \| ROUTE_TO_ERROR \| COMPENSATE` (`00 §0.7.1` `OnErrorBehaviour`) + the `error` output port every node already has (§4). Authors get error branches; the engine gets no new type |
| **Filter** node | An operation, not a step | `TRANSFORM` with `operations: [{ op: 'filter', … }]` (doc 17 §7.15). It ships as its own **palette card** that emits a pre-filled `TRANSFORM` |

If the intent was a visible "Error Handler" box on the canvas, that is satisfied by the `error` port
plus `ROUTE_TO_ERROR`, which is strictly more expressive: every node gets error routing, not just the
ones an author remembered to wire to a handler.

## 3. Palette → engine mapping (the frozen contract)

| # | Palette card | Engine `NodeType` | Discriminator | Status |
|---|---|---|---|---|
| 1 | Manual Trigger | `TRIGGER` | `triggerType: 'MANUAL'` | EXISTING |
| 2 | Schedule Trigger | `TRIGGER` | `triggerType: 'SCHEDULE'` | EXISTING |
| 3 | Webhook Trigger | `TRIGGER` | `triggerType: 'WEBHOOK'` | EXISTING |
| 4 | Event Trigger | `TRIGGER` | `triggerType: 'EVENT'` | EXISTING |
| 5 | HR Employee | `AI_EMPLOYEE_STEP` | `role: 'HR'` | NEW node, EXISTING role |
| 6 | Marketing Employee | `AI_EMPLOYEE_STEP` | `role: 'MARKETING'` | NEW node, **role blocked by G10** |
| 7 | Condition | `CONDITION` | — | EXISTING |
| 8 | Switch | `SWITCH` | — | NEW |
| 9 | Filter | `TRANSFORM` | `operations[0].op = 'filter'` | NEW |
| 10 | Loop | `LOOP` | — | NEW |
| 11 | Merge | `JOIN` | display alias only | NEW |
| 12 | Split | `PARALLEL` | display alias only | NEW |
| 13 | Delay / Wait | `WAIT` | — | EXISTING |
| 14 | Stop | `TERMINATE` | — | NEW |
| 15 | Set Variable | `SET_VARIABLE` | — | NEW |
| 16 | Transform Data | `TRANSFORM` | — | NEW |
| 17 | Knowledge Search | `RETRIEVE` | — | EXISTING |
| 18 | Memory Read | `MEMORY_READ` | — | NEW |
| 19 | Memory Write | `MEMORY_WRITE` | — | NEW |
| 20 | Approval | `APPROVAL` | — | EXISTING |
| 21 | *(one card per installed skill tool)* | `TOOL_ACTION` | `skillKey` + `tool` | EXISTING |
| — | *(internal)* | `NOOP` | — | NEW |

**21 palette cards → 17 engine types**, all inside the canonical 26.

**Merge/Split naming:** the canvas says Merge and Split because that is what authors call them; the
contract says `JOIN` and `PARALLEL` because that is what `00 §0.7.1` froze. Display names are free to
change; identifiers are not.

### 3.1 Blocking dependency — G10

`AI_EMPLOYEE_STEP` with `role: 'MARKETING'` **cannot ship** until `EmployeeRole` gains `MARKETING`.
Verified against the live schema: `EmployeeRole` is `SUPPORT | SALES | RECRUITER | HR | ACCOUNTANT |
PROJECT_MANAGER | CUSTOM` — no `MARKETING`. `00 §0.7.1` already declares it NEW and `00 §0.3` tracks it
as **G10**.

Do **not** ship a Marketing Employee as `CUSTOM` as a workaround. `CUSTOM` breaks role-scoped knowledge
retrieval and role-based analytics, so the employee would silently retrieve the wrong knowledge — a
correctness bug disguised as a config choice. **G10 is a prerequisite of palette card #6.**

---

## 4. The uniform node contract

Declared once. Per-node tables (§5–§8) specify only what varies.

```ts
/** FROZEN. The registry entry every node provides. */
export interface NodeContract<TConfig = unknown, TIn = unknown, TOut = unknown> {
  /** Stable identifier. FROZEN — never rename without §9. */
  type: NodeType;                      // 00 §0.7.1
  /** Contract version. Bump on a BREAKING config/port change; see §9. */
  version: number;
  category: NodeCategory;              // 00 §0.7.1
  display: NodeDisplay;
  ports: { inputs: PortSpec[]; outputs: PortSpec[] };
  configSchema: ZodType<TConfig>;      // validated at PUBLISH
  inputSchema: ZodType<TIn>;           // runtime payload in
  outputSchema: ZodType<TOut>;         // runtime payload out
  validate?(cfg: TConfig, graph: GraphContext): ValidationIssue[];  // cross-node rules
  execution: ExecutionSemantics;
  security: NodeSecurity;
  panel: PanelSpec;                    // config-panel metadata (no UI code here)
  execute(ctx: AttemptContext, cfg: TConfig): Promise<NodeOutcome<TOut>>;  // doc 17 §6
}

export interface PortSpec {
  id: string;                 // FROZEN per node
  label: string;
  kind: 'main' | 'error' | 'branch';
  required: boolean;
  /** For dynamic branch ports (SWITCH, AI_DECISION): derived from config. */
  dynamic?: boolean;
}

export interface ExecutionSemantics {
  hasSideEffect: boolean;     // → idempotency + G25 approval gate
  idempotent: boolean;        // safe to re-run without a key
  retry: { strategy: BackoffStrategy; maxAttempts: number };  // 00 §0.7.1
  timeoutMs: number;
  onErrorDefault: OnErrorBehaviour;
  concurrencySafe: boolean;   // may run in a PARALLEL lane
  pausesRun: boolean;         // returns WAIT (doc 17 §6)
}

export interface NodeSecurity {
  requiredRole: Role | null;            // null = any authenticated member
  requiresSecrets: boolean;
  secretFields: string[];               // redacted in logs, masked in API
  audit: 'none' | 'metadata' | 'full';  // doc 10
  tenantScoped: true;                   // ALWAYS — no exceptions
}

export interface NodeDisplay {
  label: string; description: string;
  icon: string;                          // lucide-react name
  colorToken: string;                    // semantic token, not a hex — design-system doc
  group: string;                         // palette section
}

export interface PanelSpec {
  fields: PanelField[];                  // data-driven, like SkillCatalog.configSchema
  advanced?: PanelField[];               // collapsed by default
  docsUrl?: string;
}
```

**Every node has an `error` output port.** That is what makes "Error Handler" unnecessary and error
routing universal.

---

## 5. Execution semantics matrix (FROZEN)

| Type | side-effect | idempotent | retry | timeout | onError default | concurrency-safe | pauses |
|---|---|---|---|---|---|---|---|
| `TRIGGER` | no | yes | NONE ×1 | 5s | FAIL_RUN | yes | no |
| `AI_EMPLOYEE_STEP` | **yes** | no | EXPONENTIAL ×3 | 120s | FAIL_RUN | yes | **yes** (approval) |
| `CONDITION` | no | yes | NONE ×1 | 5s | FAIL_RUN | yes | no |
| `SWITCH` | no | yes | NONE ×1 | 5s | FAIL_RUN | yes | no |
| `LOOP` | no | yes | NONE ×1 | — | FAIL_RUN | no | no |
| `PARALLEL` | no | yes | NONE ×1 | 5s | FAIL_RUN | — | no |
| `JOIN` | no | yes | NONE ×1 | — | FAIL_RUN | — | **yes** (until lanes arrive) |
| `WAIT` | no | yes | NONE ×1 | — | FAIL_RUN | yes | **yes** (durable timer) |
| `TERMINATE` | no | yes | NONE ×1 | 5s | — | yes | no |
| `SET_VARIABLE` | no | yes | NONE ×1 | 5s | FAIL_RUN | yes | no |
| `TRANSFORM` | no | yes | NONE ×1 | 10s | FAIL_RUN | yes | no |
| `RETRIEVE` | no | yes | EXPONENTIAL ×3 | 30s | FAIL_RUN | yes | no |
| `MEMORY_READ` | no | yes | EXPONENTIAL ×2 | 10s | FAIL_RUN | yes | no |
| `MEMORY_WRITE` | **yes** | no | EXPONENTIAL ×2 | 10s | FAIL_RUN | yes | no |
| `APPROVAL` | no | yes | NONE ×1 | — | FAIL_RUN | no | **yes** (human) |
| `TOOL_ACTION` | **yes** | per-tool | EXPONENTIAL ×3 | 30s | FAIL_RUN | yes | **yes** (if gated) |
| `NOOP` | no | yes | NONE ×1 | 1s | CONTINUE | yes | no |

`LOOP`, `JOIN` and `APPROVAL` have no timeout because they are bounded by the **run** deadline, not a
node deadline. Giving them a node timeout would kill a legitimately slow human approval.

`concurrencySafe: false` on `LOOP` and `APPROVAL`: a loop maintains iteration state and an approval owns
a single request row; neither is safe to duplicate inside a parallel lane.

## 6. Ports matrix (FROZEN)

| Type | Inputs | Outputs |
|---|---|---|
| `TRIGGER` | — | `main`, `error` |
| `AI_EMPLOYEE_STEP` | `main` | `main`, `error` |
| `CONDITION` | `main` | `true`, `false`, `error` |
| `SWITCH` | `main` | *dynamic per case*, `default`, `error` |
| `LOOP` | `main` | `body`, `done`, `error` |
| `PARALLEL` | `main` | *dynamic per lane*, `error` |
| `JOIN` | *n dynamic* | `main`, `error` |
| `WAIT` | `main` | `main`, `error` |
| `TERMINATE` | `main` | — |
| `SET_VARIABLE` | `main` | `main`, `error` |
| `TRANSFORM` | `main` | `main`, `error` |
| `RETRIEVE` | `main` | `main`, `error` |
| `MEMORY_READ` / `MEMORY_WRITE` | `main` | `main`, `error` |
| `APPROVAL` | `main` | `approved`, `rejected`, `error` |
| `TOOL_ACTION` | `main` | `main`, `error` |
| `NOOP` | `main` | `main` |

Port ids are **frozen**: they are persisted as `edge.fromPort` in `WorkflowVersion.definition`.
Renaming `true`→`yes` on `CONDITION` would orphan every saved edge.

## 7. Security, secrets and audit matrix (FROZEN)

| Type | required role | secrets | audit |
|---|---|---|---|
| `TRIGGER` (WEBHOOK) | none (public route, token-auth) | webhook token | full |
| `TRIGGER` (others) | MEMBER | no | metadata |
| `AI_EMPLOYEE_STEP` | MEMBER | via connector | **full** |
| `TOOL_ACTION` | MEMBER | via connector | **full** |
| `APPROVAL` | MEMBER to author; decision guard per doc 08 / ledger R12 | no | **full** |
| `MEMORY_WRITE`, `KNOWLEDGE_WRITE` | MEMBER | no | full |
| `RETRIEVE`, `MEMORY_READ` | MEMBER | no | metadata |
| logic/data nodes | MEMBER | no | metadata |

**No node ever declares an inline credential.** Secrets are referenced through the connector layer
(`04 §4.2`); a secret in node config would be persisted into `WorkflowVersion.definition`, which is
immutable and surfaced in run history and DLQ dumps.

**Every node is `tenantScoped: true`.** There is no opt-out.

## 8. Node Compatibility Matrix

Legend: ✅ allowed · ⚠️ allowed with the stated constraint · ❌ rejected at publish.

| Node | inside `LOOP` body | inside `PARALLEL` lane | after `APPROVAL` | as first node | as last node |
|---|---|---|---|---|---|
| `TRIGGER` | ❌ | ❌ | ❌ | ✅ **only** | ❌ |
| `AI_EMPLOYEE_STEP` | ⚠️ cost — needs `maxIterations` | ✅ | ✅ | ❌ | ✅ |
| `CONDITION` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `SWITCH` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `LOOP` | ⚠️ nesting depth ≤ 2 | ⚠️ lane-local state | ✅ | ❌ | ❌ |
| `PARALLEL` | ⚠️ fan-out multiplies | ❌ no nested parallel in MVP | ✅ | ❌ | ❌ |
| `JOIN` | ✅ | ❌ | ✅ | ❌ | ✅ |
| `WAIT` | ⚠️ iterations × delay | ✅ | ✅ | ❌ | ✅ |
| `TERMINATE` | ✅ exits the whole run | ✅ cancels sibling lanes | ✅ | ❌ | ✅ |
| `SET_VARIABLE` | ⚠️ scope per iteration | ⚠️ **lane-local only** | ✅ | ❌ | ✅ |
| `TRANSFORM` | ✅ | ✅ | ✅ | ❌ | ✅ |
| `RETRIEVE` | ✅ | ✅ | ✅ | ❌ | ✅ |
| `MEMORY_READ` | ✅ | ✅ | ✅ | ❌ | ✅ |
| `MEMORY_WRITE` | ⚠️ writes per iteration | ⚠️ **last-write-wins** | ✅ | ❌ | ✅ |
| `APPROVAL` | ❌ human-per-iteration | ❌ | ⚠️ chained approvals allowed | ❌ | ✅ |
| `TOOL_ACTION` | ⚠️ rate limits | ✅ | ✅ | ❌ | ✅ |
| `NOOP` | ✅ | ✅ | ✅ | ❌ | ✅ |

**The four ❌ rules worth stating plainly:**
1. `TRIGGER` is first, exactly once, and nowhere else.
2. `APPROVAL` inside a `LOOP` would ask a human once per iteration — always a mistake, so it is rejected
   rather than warned about.
3. No nested `PARALLEL` in MVP — lane accounting is not worth the complexity before there is demand.
4. `SET_VARIABLE` inside a lane writes **lane-local** scope. Cross-lane writes are last-write-wins and
   non-deterministic; publish emits a warning, and `MEMORY_WRITE` in a lane does the same.

### 8.1 Trigger compatibility

| Trigger | Employee | Notes |
|---|---|---|
| Manual | both | Always available |
| Schedule | both | BullMQ repeatable; one schedule per workflow |
| Webhook | both | Public token route, plural path `/workflows/webhooks/:token` (ledger R2) |
| Event | both | ⚠️ **Only one recruiting workflow may be ACTIVE per Gmail connector** — a known live-tenant conflict; publish must warn |

---

## 9. Registry architecture — adding nodes without touching the engine

The engine must never contain a `switch (node.type)`. It resolves a handler and calls it.

```ts
@Injectable()
export class NodeRegistry {
  private readonly byType = new Map<NodeType, NodeContract>();

  register(contract: NodeContract): void {
    if (this.byType.has(contract.type)) {
      throw new Error(`Duplicate node contract: ${contract.type}`);
    }
    this.byType.set(contract.type, contract);
  }

  get(type: NodeType): NodeContract {
    const c = this.byType.get(type);
    if (!c) throw new UnknownNodeTypeError(type);   // → VALIDATION_ERROR, never a crash
    return c;
  }

  /** Feeds GET /workflow-nodes — the palette is GENERATED, never hand-maintained. */
  list(): NodeContract[] { return [...this.byType.values()]; }
}
```

Adding a node = one file implementing `NodeContract` + one `register()` call. **No engine change, no
migration, no API change** — `GET /workflow-nodes` and the palette both derive from `list()`.

The one rule that keeps this true: **the engine may read only `NodeContract` fields, never the concrete
type.** Any `if (node.type === …)` in the runtime is a review rejection.

### 9.1 Versioning and the migration strategy

`version` starts at `1`. Bump it only for a **breaking** change: removing/renaming a config key,
removing/renaming a port, or changing output shape. Additive optional config does not bump.

A bump requires all three:
1. Both versions registered simultaneously (`SWITCH@1`, `SWITCH@2`).
2. An `upgrade(cfgV1): cfgV2` function, applied lazily when a draft is opened — **never** to a
   `PUBLISHED` version, which is immutable (ADR-002).
3. In-flight runs keep executing v1 until they terminate.

**Renaming a `type` identifier is not a version bump — it is a data migration** touching every
`WorkflowVersion.definition` JSON. That is why §3's identifiers are frozen.

---

## 10. Validation rules enforced at publish

| # | Rule | Error |
|---|---|---|
| V1 | Exactly one `TRIGGER`, and it is the entry node | `422 SINGLE_TRIGGER_REQUIRED` |
| V2 | Every `edge.fromPort` exists on the source node | `422 UNKNOWN_PORT` |
| V3 | Every non-terminal node has a reachable path to a terminal | `422 UNREACHABLE` |
| V4 | Every `PARALLEL` reaches a `JOIN` | `422 UNJOINED_PARALLEL` |
| V5 | No cycles except through `LOOP` | `422 CYCLE_DETECTED` |
| V6 | `LOOP` declares `maxIterations` | `422 UNBOUNDED_LOOP` |
| V7 | Compatibility matrix ❌ violated | `422 INCOMPATIBLE_PLACEMENT` |
| V8 | Config parses against `configSchema` | `422 INVALID_CONFIG` |
| V9 | `AI_EMPLOYEE_STEP.employeeId` exists, is in this tenant, matches the card's role | `422 INVALID_EMPLOYEE` |
| V10 | `TOOL_ACTION` skill installed and tool exists | `422 SKILL_NOT_AVAILABLE` |
| V11 | No inline secret in any config | `422 INLINE_SECRET_FORBIDDEN` |
| V12 | Node count ≤ `MAX_WORKFLOW_NODES` | `422 GRAPH_TOO_LARGE` |

Errors are returned as a **list**, one per offending node, using doc 13's envelope. A single opaque
"invalid workflow" is unusable on a 30-node graph.

## 11. Frontend metadata (contract only — no UI here)

`GET /workflow-nodes` returns `display` + `panel` + `ports` per contract. The canvas renders from that
response and holds **no hardcoded node list**. Visual design (colors, node card anatomy, states) is
owned by `design-system/2026-08-01-orlixa-design-system.md`; this document supplies only the semantic
`colorToken` and lucide icon name.

## 12. Acceptance criteria

1. `GET /workflow-nodes` returns exactly 17 contracts; the palette shows 21 cards.
2. No `switch`/`if` on `node.type` anywhere in the engine (CI grep).
3. All 12 publish validations return per-node errors.
4. Every node exposes an `error` port; `ROUTE_TO_ERROR` follows it.
5. Compatibility matrix ❌ cases rejected; ⚠️ cases warn but publish.
6. Registering a new node requires no engine file change (proved by adding a throwaway node in a test).
7. No node config can carry a secret (V11 + automated scan).
8. Marketing Employee card is **hidden** until G10 ships.

## 13. Freeze declaration

> ### 🔒 MVP NODE CONTRACT — **FROZEN FOR IMPLEMENTATION** · 2026-08-01
>
> **Frozen:** the 17 `NodeType` identifiers (§3), all port ids (§6), execution semantics (§5), and
> security/audit classes (§7).
>
> **Not frozen** (may change without migration): display labels, icons, colour tokens, palette
> grouping, help text, panel field ordering, and additive optional config keys.
>
> **Changing anything frozen requires §9.1's migration strategy in writing, reviewed before merge.**

### Known open items that do **not** block the freeze

| # | Item | Effect |
|---|---|---|
| G10 | `MARKETING` role missing | Palette card #6 hidden until closed. Contract unaffected |
| D5 | `WAITING` not split into timer-wait vs approval-wait | `WAIT`, `JOIN`, `APPROVAL` and gated `TOOL_ACTION` all surface as `WAITING`; the UI must read the current node's type to explain why. Resolve before W9 |
| D4 | `CANCELLED` / `CANCELED` spelling | Runtime-level, not node-level |
| R12 | Approval decision guard loosening | Changes who may decide, not the node contract |

None touches a frozen identifier, which is why the freeze can proceed now.

---

**Prerequisites before implementation:** W0.5 from `23-implementation-roadmap.md` — CI, flaky-suite
cleanup, and G29. The registry refactor (W2) is a pure refactor whose only safety net is the test suite.
