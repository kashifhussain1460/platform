# Workflow System — Implementation Gap Audit

**Date:** 2026-08-05
**Supersedes:** the 2026-08-02 edition of this file (kept in git history). This pass re-verifies every prior finding against current code and resolves the items the last audit left "not independently verified" (Marketing REST wiring, partitioning/RLS, the TRANSFORM / KNOWLEDGE_WRITE doc conflicts, CI, test-isolation suites, variables/secrets).
**Method:** Read-only. No code was modified. Eight independent subsystem passes each read the canonical docs (`docs/architecture/workflow-system/00–30`, the master DB design, and `connector-event-workflow-architecture.md`) and then inspected the live codebase with `file:line` evidence, cross-referencing the two. Coverage: NestJS modules, Prisma schema (~57 models) + **41 migrations**, workflow services, both execution engines, BullMQ queues/workers, AI-Employee runtime, Skills, Events/connectors, Approvals, Permissions, Knowledge, Memory, Variables/Secrets, Audit, Analytics, the REST API surface, the frontend builder, and the test suite (55 e2e spec files, 38 unit spec files).
**Scope rule:** This audit does not redesign architecture. Where code diverges from a doc, the doc is the target unless a later, more specific doc supersedes it (see §3). No new design is proposed except where an existing design is technically impossible (none found).

---

## 0. How to read this report — and what changed since 2026-08-02

The doc set has two tiers, and conflating them produces a falsely alarming or falsely reassuring audit:

- **L1 (docs 00–29, minus the L2 set below)** — the system actually built through the P3 milestone plus the Workflow Builder frontend: auth/tenant, the legacy graph-walk engine, AI-Employee runtime, Skills, Knowledge, Approvals + Routing + SLA, HR, Marketing templates, Workflow Templates, RUN-level Workflow Permissions, and the builder UI. These match their source docs closely.
- **L2 (docs 05, 06, 07, 10, 11, 12-partition/RLS, 16, and doc 99's readiness bar)** — a later, more ambitious target: a durable state-machine engine, a typed variables/secrets system, semantic memory, a hash-chained immutable audit stream, analytics rollups, DB partitioning + Row-Level Security, and a realtime WebSocket gateway. Most of this is **not live** — but where scaffolding exists (durable-runtime tables, the outbox, the variables tables) it was built and then never wired into a real run path.

**Net finding is unchanged from the last pass, with three important deltas:**

1. **CI now exists.** `.github/workflows/api-ci.yml` (lint + typecheck + unit + e2e against pgvector + redis) and `web-ci.yml` are present. Doc 99's top blocker **B1 ("no CI pipeline") is closed** — doc 99 is now stale on this point.
2. **Tenant-isolation and DTO-contract test suites now exist** as dedicated, table-driven suites (`test/tenant-isolation.e2e-spec.ts`, `test/contract.e2e-spec.ts`). Doc 24's two named gaps here are closed.
3. **The variables/secrets tables shipped** (migration `20260801180000_p2_workflow_variables`: `WorkflowVariable`, `WorkflowSecretRef`) — the last audit reported them missing. They are present but only partially wired (see §1-G).

**Two findings got worse / newly surfaced this pass and are the reason there is now a P0 tier** (the last audit found none):

- **The dormant durable engine is not merely inert — it is dangerous while dormant.** The 5-minute reaper sweep will re-drive *legacy* runs into the state-machine path and re-execute side-effecting nodes. See P0-1.
- **The public, unauthenticated webhook trigger has no idempotency**, so a normal provider redelivery double-fires a real side-effecting run. See P0-2.

One correction carried forward and re-confirmed: the `TOOL_ACTION` approval-gate bypass once described in doc 04 §4.5 (historical gap G25) **is fixed** — the engine calls the same `toolRequiresApproval(...)` policy as the chat path (`workflow-engine.service.ts:832-842,516-600`). Doc 04 §4.5 is stale.

---

## 1. Requirement → Implementation Traceability Matrix

Status vocabulary: **IMPLEMENTED · PARTIALLY IMPLEMENTED · NOT IMPLEMENTED · IMPLEMENTED DIFFERENTLY · BLOCKED · DEPRECATED.** For PARTIAL/DIFFERENT the reason is stated.

### A. Auth / Tenant Foundations — IMPLEMENTED
RBAC (OWNER/ADMIN/MEMBER), JWT, multi-tenant Company/User. `companyId` scoping is enforced on essentially every query across every audited module. Both durable-runtime processors re-load the run and reject a payload/run `companyId` mismatch (`run-advance.processor.ts:67-73`, `node-attempt.processor.ts:93-98`). Two internal-only exceptions noted in §2 (`resumeRun`/`cancelRun`). Table-driven isolation is now regression-guarded (`test/tenant-isolation.e2e-spec.ts:177`, `it.each` → 404 probes).

### B. Execution Engine — legacy graph-walk (the only path real runs use)
**IMPLEMENTED**, running today. Evidence: `workflows.service.ts:87-117` (`dispatchRun`), `:672-734` (`enqueueRun`). All node types have registered handlers; the static catalog is typed `Record<NodeType,…>` so a missing entry is a compile error (`nodes/node-catalog.ts:97`). The `TOOL_ACTION`/`AI_EMPLOYEE_STEP` approval gate is enforced here (see §0). `WORKFLOW_EXECUTION_MODE` inline vs queue (G40) is handled correctly, including the SCHEDULE double-fire fix (`workflows.service.ts:838-878`).

### C. Execution Engine — durable state machine (docs 05/16) — NOT IMPLEMENTED (dormant, and unsafe while dormant)
Scaffolding is **built and module-wired**: `WorkflowStepAttempt`, `WorkflowRunTimer`, `WorkflowJoinState`, `RunEventOutbox` tables (migration `20260801150000`), advance/attempt/timer processors, lease/lock/traversal/retry-policy services, a reaper, and `EngineModeService`. **But no code path routes a real run into it:** `enqueueRun`/`dispatchRun` never consult engine mode, and `EngineModeService.usesStateMachine()/modeFor()` is called only from a test (`engine-mode.ts:47-54`; `test/workflow-runtime-p1.e2e-spec.ts:79-80`). Nothing seeds the first `wf-run-advance` job at run creation, so the machine's only real-world entry is the reaper accidentally re-driving a stuck legacy run (P0-1). Direct consequences:
- **Run deadline / `TIMED_OUT`: NOT IMPLEMENTED.** `WorkflowRun.deadlineAt` is only ever *read* (`reaper.service.ts:146`); no code writes it. No live run has a hard time ceiling beyond the 10-minute orphan watchdog.
- **Compensation / rollback: NOT IMPLEMENTED.** `WF_COMPENSATE_QUEUE` is registered (`workflow-runtime.module.ts:45`) but has **no processor and no producer**; `COMPENSATING`/`COMPENSATED` are unreachable.

### D. Node Registry / Frozen Contract (doc 26)
**IMPLEMENTED DIFFERENTLY** on two literal acceptance criteria:
- Doc 26 §12 says `GET /workflow-nodes` must return **exactly 17** contracts. The live catalog serves **19** (`packages/types/src/index.ts:1140-1160`) — the frozen 17 plus legacy `AI_STEP`, plus `NOOP`/`TRANSFORM`/`MEMORY_READ`/`MEMORY_WRITE`. The boot guard (`node-catalog.spec.ts`) asserts completeness against the 19-entry `NODE_TYPES`, so **no test can ever catch drift from doc 26's "exactly 17"**. Reasoned back-compat choice, but the acceptance criterion as written is unmet and untested.
- G10 (`EmployeeRole.MARKETING`) is confirmed shipped.

### E. Definition Validator (doc 26 §10, rules V1–V12) — PARTIALLY IMPLEMENTED
`definition-validator.ts` implements ~20 structural rules. Mapped to the freeze contract: V4/V5/V6/V11/V12 full; V1 partial (checks "≤1 trigger", not "exactly one"); V7 partial (only APPROVAL-in-LOOP, no compatibility matrix); V8 partial (hand-rolled required-field checks, not schema-driven against each node's `configSchema` — RETRIEVE/AI_STEP/CONDITION/NOTIFY/TOOL_ACTION args unchecked at save). **V2 (fromPort), V3 (reachable-to-terminal), V9 (employee exists/role), V10 (skill+tool installed) are absent.** V9/V10 are architecturally impossible in the current pure-function validator (no DB access) — they can only fail at run time today, the exact "silently wrong run later" outcome the validator's own docstring warns against.

### F. Versioning / Publish — IMPLEMENTED, with client-composed substitutes
`WorkflowVersion` draft/publish/list/get is real, transactional, idempotent. **Version diff (API-09): NOT IMPLEMENTED** (no route, no FE workaround). **Rollback / clone: IMPLEMENTED DIFFERENTLY** — no backend route; the frontend composes them (`hooks.ts:264-274` restore, `:344-363` duplicate), a documented, accepted degrade. `PATCH /workflows/:id` still writes `definition` directly (doc 13 R6 shim never built) — column and active version can drift if a caller PATCHes after publish.

### G. Variables / Secrets (doc 06) — PARTIALLY IMPLEMENTED / IMPLEMENTED DIFFERENTLY (new since last audit)
The tables now exist (`schema.prisma:1391-1433`) but diverge from doc 06 and are mostly dead scaffolding:
- `WorkflowVariable.scope`/`type` are `String`, not the mandated Prisma enums; keyed `[workflowId,scope,key]` with no `companyId` and no company-wide rows. It stores exactly the scopes doc 06 reserved *out* of this table.
- `WorkflowSecretRef` supports only `CONNECTOR_CREDENTIAL`; **there is no INLINE / `encryptedValue` path** — a user cannot store a typed-in secret (functional gap, not just schema).
- The typed `context.vars.*` scope model in `engine/variables/variables.ts` (`buildVariableContext`/`resolveVariable`) is **never called by the engine** — the run loop flattens WORKFLOW/OUTPUT rows to top-level `context[key]` (`workflow-engine.service.ts:298-310`), so `{{vars.WORKFLOW.x}}` scope-qualified access silently doesn't work, and INPUT/GLOBAL/ENVIRONMENT scopes have no data source.
- **Secret redaction: PARTIALLY IMPLEMENTED.** Value-based masking exists but is local to `tool-action.handler.ts:120-147`, not a per-attempt taint boundary. Engine error/catch sinks persist `error` without masking → a provider error echoing a token can leak into `WorkflowStepRun.error`. Dry-run leak (doc 06 §6.2.10) *is* closed by construction (`tool-action.handler.ts:108-118`).
- No safe expression evaluator (doc 06 §6.3) — consistent with the closed-op-set decision (§3).

### H. Approvals + Routing + SLA (doc 08) — IMPLEMENTED (faithful)
All 6 `ApproverRuleType` values; `canDecide` exact logic (unrouted → OWNER/ADMIN; routed → matched subject only, no admin override — `approval-routing.service.ts:61-84`); the decide guard moved from `@Roles` to service-level `assertCanDecide` run before `claim` on all three paths; multi-level lazy chains; `routingSnapshot`; the cross-tenant 5-minute SLA sweep with race-safe guarded `updateMany WHERE status='PENDING'`; `onTimeout` defaulting to `NONE`. The `assignedToMe` inbox filters in memory rather than using the purpose-built index (scale-only concern). **No audit-log entry for any approval decision** (see §2).

### I. Workflow Permissions / Authorization (doc 09) — PARTIALLY IMPLEMENTED (2 of 8 levels)
- **Level 1** (company role) — implemented (pre-existing).
- **Level 5** (`WorkflowPermission`) — the model has all 7 actions, but **only `RUN` is enforced** (`workflow-permissions.service.ts:59-62`). `VIEW/EDIT_GRAPH/UPDATE/PUBLISH/DELETE/MANAGE_PERMISSIONS` grants can be created and stored via the API but **are never read by any enforcement path** — a misleading surface that looks enforced and isn't. `workflow:run` is enforced at enqueue (`workflows.service.ts:696-703`); the DISABLED-publisher kill-switch works (`:197-210`).
- **Levels 4/6** (employee-skill grant) — checked when *listing* tools in chat (`skills.service.ts:341-364`) but **never re-checked at execution** (`runTool` at `skills.service.ts:371-449`, and the `TOOL_ACTION` node at `tool-action.handler.ts:130`). See P1-1.
- **Levels 2/3/7/8** (`RoleScopeAssignment`, a central `AuthorizationService.can()` PDP, node-level `requiredPermission`, `preventSelfApproval` segregation of duties) — **NOT IMPLEMENTED** (grep-confirmed absent).

### J. Events / Connectors / Resilience (doc 04 + `connector-event-workflow-architecture.md`) — PARTIALLY IMPLEMENTED
- **Working:** GitHub webhook driver+mapper (ingress); Gmail inbound poller (real OAuth/API, idempotent, self-loop guarded); circuit breaker + per-connector rate limiter wired into real skill egress (`skills.service.ts:461-512`); single-flight token refresh (`connector-token.service.ts:80-130`). The last two **contradict** the connector-event doc, which still marks them `[TARGET]` — code is ahead of the doc; correct the doc.
- **Reconciliation catch-up sweep: NOT IMPLEMENTED (permanent no-op).** `hasPoller()` returns `false` for every provider (`connector-reconcile.service.ts:93-95`), so any non-Gmail provider has no recovery for a dropped webhook — a direct contradiction of the doc's "never lose an event" principle.
- **Chatwoot: IMPLEMENTED DIFFERENTLY (bypasses canonical pipeline).** The webhook verifies its signature then writes straight to `SupportConversation`/`SupportMessage` (`support-webhook.controller.ts:108-159`), never touching `RawEvent`/`CanonicalEvent`/`fireEvent` — so an inbound support message **cannot trigger an EVENT workflow**. Tenant resolution uses a non-unique `chatwootAccountId` (`findFirst`).
- **Plane: NOT IMPLEMENTED (dead code).** The signature verifier exists (`plane-client.service.ts:109`) but **no controller** consumes it — Plane inbound is fully absent.
- **PKCE on OAuth: NOT IMPLEMENTED** (signed-state CSRF protection is present; PKCE is defense-in-depth, matches doc `[TARGET]`).
- **New this pass — inbound events die on the documented serverless shape.** Gmail polling and reconciliation run only as worker-gated BullMQ repeatables and are **not** among the four Vercel cron routes (`admin/cron.controller.ts:68-80` wires only schedules/watchdog/approval-sla/hr-retention). With `QUEUE_WORKERS_ENABLED=false` (the documented G40 Vercel shape) no Gmail poll and no reconciliation ever run — silent event loss. See P1-4.

### K. Skills / AI-Employee Runtime — IMPLEMENTED
`AgentRuntimeService` full plan→retrieve→memory→act(bounded loop)→validate pipeline. `SKILL_EXECUTOR` mock/real/auto switch. **Real executors:** slack, http, gmail.send_email, calendar.create_event, gdrive.*, scheduling.*, postiz.*, chatwoot.*, plane.* . **Mock-only:** stripe, email, hubspot, jira, github (incl. create_issue), gmail.read_inbox. Credential encryption (AES-256-GCM) refuses to boot in prod without a real `ENCRYPTION_KEY` (`crypto.service.ts:117-151`). Memory recall is **recency-only** (documented, accepted; semantic recall not built). The one real hole is the execution-time skill-grant gap (§1-I, P1-1).

### L. Knowledge / RAG — IMPLEMENTED; RETRIEVE node scoping is the one gap
pgvector(384, HNSW) tenant-scoped cosine search; category role-scoping (`null`=Shared) enforced on **both** manual search and AI retrieval (`knowledge.service.ts:162-164`, `retrieval.service.ts:29-37`). The workflow `RETRIEVE` node stays company-wide/unscoped (`retrieve.handler.ts:31-34`) — but doc 07 §7.0.4's recommended fix (opt-in `category`/`employeeId` + save-time warning) is not built, so a role-scoped chat and an unscoped workflow can surface different documents. `KNOWLEDGE_WRITE` node: **NOT IMPLEMENTED** at all (no handler, not in the catalog, no `KnowledgeService.createFromText`) — workflows can consume but not produce knowledge.

### M. Audit Trail (doc 10) — NOT IMPLEMENTED as specified
The simpler `AuditLog` (admin-action trail) is real and best-effort (`audit-log.service.ts:35-88`). The doc-10 vision is entirely unbuilt: no hash-chained immutable `AuditEvent`, no `AuditChainCheckpoint`, no `redact()` function, no audit retention/partitioning, no `dataRetentionDays` enforcement, no `GET /audit-events` read API. **Missing audit events are the biggest compliance gap** — see §2.

### N. Analytics / Metrics (doc 11) — NOT IMPLEMENTED as specified
Live aggregation over base tables works (`analytics.service.ts`), but the entire rollup family is absent: no `NodeMetricDaily`/`WorkflowMetricDaily`/`EmployeeMetricDaily`, no rollup job, none of the doc-11 endpoints. Per-attempt cost/token attribution (G11) is absent — `WorkflowStepAttempt` has no cost/token columns and `WorkflowRun` has no cost totals; the only cost stream is coarse, non-joinable `UsageEvent`. `SkillExecution` is written on every tool call but has **no row-level read API** (aggregate-only). The doc's intended three-way cost split is 1/3 built (so there is currently no duplication — just no per-run cost at all).

### O. Transactional Outbox (`RunEventOutbox`) — IMPLEMENTED DIFFERENTLY, dormant, feeds nothing
The table exists but in the doc-16 realtime shape (`runId` + BigInt `seq`), not doc-10's. Only `RunStateWriter` writes it, and only on the state-machine path — so on the default legacy path **no outbox row is ever written**. The relay (`outbox-relay.service.ts`) has **no sink registered**: it drains rows, stamps `publishedAt`, and discards them. It feeds neither an audit stream nor a rollup.

### P. Database Schema / Migrations (doc 12 + master DB design) — mixed
- **Shipped:** `WorkflowVersion`, `WorkflowPermission`, `WorkflowTemplate`, the 6 HR models, all 4 durable-runtime tables, `WorkflowVariable`, `WorkflowSecretRef`. `companyId` present on every one. The pgvector HNSW index survived all 41 migrations (21 correctly stripped the false-drift `DROP INDEX`). `CANCELLED`/`CANCELED` coexist by design (backfilled; `SubscriptionStatus` carries both).
- **NOT shipped:** the hash-chained `AuditEvent`, the 3 `*MetricDaily` tables, `WorkflowRun` sub-workflow lineage columns.
- **Partitioning + Row-Level Security: NOT IMPLEMENTED (now confirmed).** `grep "PARTITION BY"` and `"ENABLE ROW LEVEL SECURITY"/"CREATE POLICY"` across all 41 migrations return **zero matches**. The master design calls monthly RANGE partitioning "the single most important scalability decision"; the 4 high-volume tables are plain heaps, and tenant isolation rests solely on the application `companyId` filter (no DB backstop). The last audit could not confirm this; it is now confirmed absent.
- **Missing hot-path index:** `WorkflowsService.fireEvent` filters `companyId + status='ACTIVE' + triggerType='EVENT'` on every inbound event, but `Workflow` has only `@@index([companyId])` — a full per-tenant scan per event. `WorkflowStepAttempt` also has no `companyId`-leading index.

### Q. HR Domain (doc 03 §3.1, doc 27) — IMPLEMENTED
`StaffMember` + 5 satellites; PII fields sealed with AES-256-GCM (`hr-pii.util.ts`, ciphertext-at-rest asserted in `hr.e2e-spec.ts:77`); retention sweep prunes satellites only and is worker-gated. 11 HR templates, frozen-vocab only.

### R. Marketing Domain (doc 03 §3.2, doc 28) — split: templates IMPLEMENTED, relational domain NOT IMPLEMENTED
The **runtime path is real** — Postiz engine sync + `marketing-webhook.controller.ts` + 11 templates (highRisk correctly set on `postiz.schedule_post`/`publish_now`, `catalog.ts:554,568`). But the **relational marketing domain is dead schema (G21 confirmed):** `Campaign`/`MediaAsset`/`BrandAsset`/`MarketingAnalyticsSnapshot` exist (`schema.prisma:1050-1128`) yet **zero Prisma access and no CRUD controller anywhere** — grep returns no hits. The last audit left this unverified; it is now confirmed as schema-ahead-of-code.

### S. Workflow Templates (doc 19) — IMPLEMENTED (faithful)
Deep-copy transactional install with `Idempotency-Key` and race handling; prereq check returns 422 naming what's missing; the same publish validator rejects `DB_QUERY` + inline secrets for both first-party and tenant-authored templates. 22 first-party templates (11 HR + 11 Marketing), count/vocab guarded by `workflow-templates.catalog.spec.ts:16-49`.

### T. Workflow Builder Frontend (doc 29) — PARTIALLY IMPLEMENTED
Phases 0–3, 5, and core of 6 are built. The **Inspector cluster is missing**: `EdgeInspector`, `MultiSelectInspector`, `CommandPalette`, `ValueInserter`, `SecretPicker`, `ApprovalRoutingBuilder`, `WorkflowPermissionsPanel` are all absent — so approval routing (P3-05) and permissions (P3-06) are **API-only, with no UI to configure them**. The 14 hand-specced per-node field renderers are **IMPLEMENTED DIFFERENTLY** as one generic `configSchema`-driven `NodeConfigForm` (`Inspector.tsx:75-83`) — the intended architecture, not a defect. Realtime is polling (`hooks.ts:473-481`, 1s), which is spec-conformant for this phase (WS deferred). **Frontend/backend DTO contract: zero mismatches** — every `@vaep/types` import resolves and every field accessed is declared (`WorkflowDto`/`WorkflowRunDto`/`WorkflowStepRunDto`/`UserDto`/`NodeDefinitionDto` all consistent), now regression-guarded by `test/contract.e2e-spec.ts`.

### U. REST API surface (doc 13) — PARTIALLY IMPLEMENTED
Present: versions list/get, draft/publish, `node-definitions`, `node-types`, run cancel/retry (under `/workflows/runs/:id/*`), template install with `Idempotency-Key`. **Absent:** version diff, canonical top-level `/runs/:id`, `/runs/:id/{timeline,attempts,tool-calls,resume,compensate}`, `GET /runs/waiting`. Run creation still returns **201, not the doc-13-mandated 202** (ledger R9), and the additive `input`/`idempotencyKey` request fields (R10/R11) were never added.

### V. Testing / CI / Production Readiness (docs 23–25, 99) — much improved; operational gaps remain
- **CI: IMPLEMENTED** (`api-ci.yml`, `web-ci.yml`) — closes doc 99 B1.
- **Tenant-isolation + DTO-contract suites: IMPLEMENTED** (table-driven).
- Suite size: 55 e2e spec files, 38 unit spec files; healthy and enforcing the audited contracts.
- **NOT IMPLEMENTED:** the 3 core services (`workflows.service`, `workflow-engine.service`, `engine-mode`/reaper/durable processors) have **no dedicated unit tests** — orchestration logic is e2e-only. Chaos-test suite (doc 24 §25, 5 named experiments) absent. Backup/restore rehearsal, APM/tracing — no repo evidence (operational, not code).

---

## 2. Cross-Cutting Risk Findings

- **Dead / dormant infrastructure (architectural drift).** The entire durable state-machine engine (5 queues, lease/attempt system, reaper, retry-policy, timers, outbox) and the typed `context.vars` variable model are built, unit/e2e-tested in isolation, and **never reached by a real run**. Two divergent implementations of graph traversal, branch routing, JOIN handling, and status management are maintained in parallel. This is the single biggest drift, and the source of the P0 race below.
- **Cross-engine race (P0).** With queue workers enabled, the reaper's 5-minute `sweepStuckRuns` matches any `RUNNING` run with no live attempt rows — which is **every legacy run** — and re-enqueues a state-machine advance job that re-executes side-effecting nodes, while the legacy 10-minute watchdog independently marches the same row to FAILED. The reaper's own comment says the two "must never run at once"; nothing enforces it.
- **Missing idempotency (P0/P1).** The public, unauthenticated `POST /workflows/webhooks/:token` and `POST /workflows/:id/run` and `fireEvent` have no client-facing idempotency key. A provider redelivery or client retry double-fires a real, side-effecting run. Only template install dedups.
- **Missing execution-time authorization (P1).** `EmployeeSkill` grants are enforced only at chat tool-listing, never at execution; six of seven `WorkflowPermission` actions are modeled but never read. A workflow `TOOL_ACTION` can invoke any installed skill for any employee with the tenant's live credentials.
- **Missing audit events (P1/P2).** No audit-log row for: approval decisions (human **or** SLA-auto), `WorkflowPermission` grant/revoke, user status-only disable (the security kill-switch — `users.service.ts:127` gates the write on a role change), or workflow activate/deactivate. All are cheap to add via the already-global `AuditLogService`.
- **Missing tenant isolation (defensive).** `WorkflowsService.resumeRun`/`cancelRun` query/update `WorkflowRun` by `id` alone (internal callers only today, but an IDOR the moment a new caller is added). Separately: **no DB-level RLS anywhere** — tenant safety is application-code-only.
- **Missing metrics / observability.** No rollup tables; `SkillExecution` and the outbox relay are effectively write-only/discarded; no metric emission for breaker trips, rate-limit denials, reconcile misses, or SLA auto-approvals (the "sharpest edge" is log-only); no APM/tracing.
- **Unsafe production assumptions.** (a) The reconciliation sweep is a permanent no-op, so any non-Gmail provider silently loses dropped webhooks. (b) Inbound Gmail/reconciliation don't run at all under the documented serverless shape. (c) Secret masking is handler-local, so engine error sinks can persist a live credential. (d) The API contract advertises `TIMED_OUT`/`COMPENSATING`/`COMPENSATED`/`deadlineAt` states the live engine can never produce.
- **Incomplete tests.** The highest-risk orchestration code (legacy engine claim/PARALLEL-merge/LOOP-budget, both durable processors) has no isolated unit tests; the "exactly 17" node contract has no enforcing test.
- **Duplicate implementations.** Only the two-engine duplication above (unintended). Cost attribution is *not* duplicated (only `UsageEvent` exists today).
- **Frontend/backend contract mismatches.** None — genuinely clean, now guarded by a test.

---

## 3. Doc-vs-Doc Conflicts (resolved this pass where code could adjudicate)

1. **TRANSFORM node — RESOLVED.** Doc 17 (closed, non-evaluated op set) vs doc 06 (expression engine). The live handler implements a **closed op set only** (`jsonPath/map/filter/join/split/toNumber/toString/default`, unknown op throws — `data.handlers.ts:90-196`). **Doc 17 wins in code.** No expression engine exists anywhere.
2. **KNOWLEDGE_WRITE default category — MOOT.** Doc 17 (default acting role) vs doc 07 (default Shared). The node **does not exist** — no handler, not in the catalog. Conflict cannot arise until it is built; whoever builds it should pick the default explicitly then.
3. **Nested PARALLEL — code follows doc 26 (banned), not doc 05 (depth 3).** The validator rejects `NESTED_PARALLEL` (`definition-validator.ts:287-296`). Gap: the ban only checks a lane's immediate start node, so a PARALLEL reachable deeper in a lane slips past validation and the engine would execute it. Confirm doc 26 as canonical and make validation catch deep nesting.
4. **Connector health / single-flight token refresh — code is ahead of the doc.** `connector-event-workflow-architecture.md` still marks these `[TARGET]`; both are shipped. Correct the doc.
5. **`CANCELLED` vs `CANCELED` — resolved in schema, both coexist by design** (backfill migration). Settle the spelling before the durable engine is ever activated.

---

## 4. Priority-Ordered Findings

> **Status update 2026-08-05 (Production Backend Completion pass): both P0 items FIXED — see `backend-completion-report.md`.**

### P0 — blocks correct execution (a live run can misbehave or duplicate irreversible side effects)
1. ✅ **FIXED — Reaper vs legacy-watchdog cross-engine race.** `sweepStuckRuns` now filters `attempts: { some: {} }`, so it acts only on runs that entered the durable engine; legacy runs (zero attempts) are never re-enqueued. *(`reaper.service.ts`, regression test `reaper.service.spec.ts`)*
2. ✅ **FIXED — No idempotency on the public webhook trigger.** `enqueueRun` now dedups on `WorkflowRun.idempotencyKey` (`@@unique([companyId, idempotencyKey])`, P2002-race-safe). The webhook route keys on `Idempotency-Key` / `X-GitHub-Delivery`; `fireEvent` keys on the canonical event id. *(`workflows.service.ts`, `webhooks.controller.ts`, e2e in `workflow-triggers.e2e-spec.ts`)*

### P1 — blocks production (at scale, or for a regulated customer)
1. ✅ **FIXED — `EmployeeSkill` grants not enforced at tool execution.** `runTool` now gates on an ENABLED `EmployeeSkill` when the call is attributed to an employee; a company-wide call (no employeeId) is allowed as before. *(`skills.service.ts`, unit `skills.service.spec.ts`)*
2. ✅ **FIXED — No idempotency on `POST /workflows/:id/run`.** Reads `Idempotency-Key` header, keyed per workflow. *(`workflows.controller.ts`, e2e in `workflow-triggers.e2e-spec.ts`)*
3. ◑ **ADDRESSED (fenced) — Durable engine dormant.** The unsafe consequence (P0-1) is fixed and the engine is now provably unreachable-by-accident (no seeding path; reaper scoped). Full activation (deadline writing, compensation processor, `EngineModeService` cutover with the G25 gate re-verified) is deliberately **deferred to an explicit L2 activation plan** — it is large, requires a design decision, and adding it hastily would risk correctness.
4. ✅ **FIXED — Inbound events die on serverless.** Added `/admin/cron/gmail-poll` and `/admin/cron/connector-reconcile` (+ `vercel.json` cron entries). *(`admin/cron.controller.ts`, e2e in `inline-execution.e2e-spec.ts`)*
5. ✅ **FIXED — No audit trail for approval decisions or user disable.** Human approve/reject/modify audited at the `claim` chokepoint; SLA escalate/expire/auto-decide audited; status-only user disable/reactivate audited. *(`approval.service.ts`, `approval-sla.service.ts`, `users.service.ts`, e2e in `rbac-users.e2e-spec.ts`)*
6. ⏸ **DEFERRED (blocked, needs design) — Chatwoot/Plane cannot trigger workflows.** Firing from the Support engine is blocked by a real module cycle (Workflows→Skills→Support→Workflows) and the worker-gated canonical-normalize path; Plane also needs an event-type taxonomy + tenant-resolution decision. Requires a scoped design (event-bus seam or `forwardRef` + serverless-safe fire), not a small safe change. See report §Deferred.
7. ⏸ **DEFERRED (needs live integration) — Reconciliation sweep is a permanent no-op.** Real per-provider catch-up needs live cursor/history APIs and credentials; it cannot be implemented as verifiable production behavior offline, and a stub would be fake behavior (forbidden by this pass's rules). The cron route now exists (P1-4) so activation is a matter of implementing real `hasPoller()`/cursor logic per provider under live test.
8. ✅ **FIXED — Secret leak via unscrubbed engine error/log sinks.** `runTool` now redacts resolved `{{secret.X}}` values and connector credential values from the persisted `SkillExecution.error`/result and the returned call — a single taint boundary. *(`skills.service.ts`, `common/crypto/redact-secrets.ts`, unit `redact-secrets.spec.ts`)*
9. ✅ **FIXED — `resumeRun`/`cancelRun` missing `companyId` filter.** Both now take `companyId` and query by `{ id, companyId }`; all callers updated. *(`workflows.service.ts`, `approval.service.ts`, `approval-sla.service.ts`)*

### P2 — enterprise readiness
- No DB partitioning + no Row-Level Security on the 4 high-volume tables (confirmed absent).
- Missing `Workflow[companyId,status,triggerType]` hot-path index (per-event full-tenant scan) and `WorkflowStepAttempt` `companyId`-leading index.
- Six of seven `WorkflowPermission` actions storable-but-inert (a `PUBLISH`/`MANAGE_PERMISSIONS` grant silently does nothing) — enforce or reject at the API until enforced.
- No audit for permission grant/revoke and workflow activate/deactivate.
- Per-attempt cost/token attribution (G11) and analytics rollups (doc 11 / G17) absent — live aggregation won't scale.
- Hash-chained `AuditEvent` + redaction + audit retention (doc 10) unbuilt.
- `preventSelfApproval` (segregation of duties, doc 09 §8) not modeled.
- INLINE secrets unsupported (secrets tied to connector-credential fields only).
- Validator V2/V3/V9/V10 + full V7 matrix absent (move failures from run time to save time; V9/V10 need a tenant-aware publish-time pass).
- Chaos-test suite (doc 24 §25) absent.
- `CANCELLED`/`CANCELED` spelling (confirmed, still open) — settle before activating the durable engine.

### P3 — UX / observability
- Frontend Inspector cluster missing (`EdgeInspector`, `MultiSelectInspector`, `CommandPalette`, `ValueInserter`, `SecretPicker`, `ApprovalRoutingBuilder`, `WorkflowPermissionsPanel`) — routing/permissions are API-only.
- No dedicated unit tests for the 3 core workflow/engine services or the durable processors; "exactly 17" contract untested.
- `SkillExecution` has no row-level read API; the outbox relay discards every event.
- RETRIEVE node role-scoping opt-in (doc 07 §7.0.4) not built.
- Dead `context.vars` variable scaffolding — wire it or remove it.
- `@HttpCode(202)` + additive `input`/`idempotencyKey` on run creation (ledger R9/R10/R11).
- Refresh doc 99 (understates current state now that CI + isolation/contract suites shipped).

### P4 — future enhancement
- Remaining 6 of 8 levels of the doc 09 permission model (`RoleScopeAssignment`, central PDP, node `requiredPermission`).
- Semantic memory recall (recency-only today; documented, accepted).
- `KNOWLEDGE_WRITE` node (consume-only knowledge today).
- Version diff endpoint (API-09); realtime WebSocket gateway + `RunCanvasLayer` live feed.
- Marketing relational CRUD (G21) — build it or drop the 4 dead models.
- PKCE on OAuth; webhook replay/timestamp window on github/generic drivers.
- Deep nested-PARALLEL validation; nested-PARALLEL policy reconciliation (doc 05 vs 26).
- Kafka-scale event backbone beyond BullMQ.

---

## 5. Can implementation safely continue?

**Yes — additive feature work is safe to continue, but two P0 items should be fixed first, and the P1 list closed before the platform is presented as production-hardened at scale or offered to a regulated customer.**

Everything shipped through the P3 wave and the builder frontend phases — the legacy engine, AI-Employee runtime, Skills, Knowledge, Approvals + Routing + SLA, HR, Marketing templates, Workflow Templates, and RUN-level permissions — is solid, faithful to its source docs, and now backed by CI plus table-driven isolation/contract suites. No design was found to be technically impossible; every gap is additive over a working base. The historical G25 approval-gate bypass is confirmed closed and tested.

Three conditions:

1. **Fix the two P0s before the next real-tenant run under a worker deployment.** The reaper race can silently re-execute side-effecting nodes on live legacy runs, and the public webhook has no de-dup against provider redelivery. Both cause duplicate irreversible side effects (emails, posts, calendar invites) with no human in the loop. Neither is hypothetical on the live Kashif tenant.
2. **Do not assume the durable engine, run timeouts, or compensation exist just because their tables, workers, and enum states do.** They are unreachable. Either put activation on an explicit plan (wire `EngineModeService`, seed the first advance job, re-verify the G25 gate in that path, settle the CANCELLED spelling) or document clearly that the platform is legacy-walk-only — so no one designs a feature assuming deadline enforcement or rollback that isn't live.
3. **Close the P1 list before scaling tenant count, workflow volume, or regulatory exposure** — especially the execution-time skill-grant check, run/webhook idempotency, the missing approval/kill-switch audit trail, the serverless inbound-event death, and the dead reconciliation sweep. These are silent-failure-mode risks, not loud ones.

The doc-vs-doc conflicts in §3 that code could adjudicate are now resolved (TRANSFORM → closed op set; nested PARALLEL → banned per doc 26; KNOWLEDGE_WRITE moot). The remaining decisions — activate-or-fence the durable engine, and settle `CANCELLED`/`CANCELED` — should be made explicitly, not left for the next engineer to infer.
