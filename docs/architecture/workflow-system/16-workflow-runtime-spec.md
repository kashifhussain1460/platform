# 16 — Workflow Runtime Specification (L2)

> **Level:** L2 — *exactly how engineers implement it.*
> **Extends:** `05-execution-engine.md` (L1). That document defines the state machine, the five
> queues, and the contracts `AdvanceJob`, `NodeAttemptJob`, `AttemptLease`, `RetryDecision`,
> `AdvanceDecision`, `TimerService`, `CancellationService`, `CompensationService`, `JoinResolver`,
> `LaneId`. **This document does not redefine any of them.** It specifies the mechanics L1 left open:
> exact SQL, transaction boundaries, idempotency key derivation, lease and clock semantics, worker
> loop structure, and the legacy→state-machine cutover.
> **Normative source:** `00-overview-and-canonical-contracts.md` §0.7 (enums/interfaces), §0.8 (NFRs).
> Where this document and L1 disagree, L1 wins and this document is the bug.

---

## 1. Purpose

Make `05-execution-engine.md` buildable without a single "how exactly?" left to the implementer's
judgement. Every decision below that L1 did not fix is called out explicitly under **[AMBIGUITY]** with
the chosen resolution and its rationale.

The runtime's job is one sentence: **advance a run from node to node, durably, exactly-once per side
effect, across process restarts, without two workers ever acting on the same run at the same time.**

## 2. Scope

In scope: the `wf-run-advance` / `wf-node-attempt` / `wf-timer` / `wf-compensate` / `wf-dlq` workers;
run and step state transitions; lease acquisition and expiry; retry scheduling; idempotency; the
outbox write; the reaper; the feature-flag cutover.

## 3. Responsibilities

| # | Responsibility |
|---|---|
| R1 | Own every write to `WorkflowRun.status`, `WorkflowStepRun.status`, `WorkflowStepAttempt` |
| R2 | Guarantee at most one in-flight advance per run |
| R3 | Guarantee each node's side effect executes at most once per `(runId, nodeId, attempt)` |
| R4 | Schedule and fire durable timers within ±30s (§0.8) |
| R5 | Recover orphaned work within 60s of worker death (§0.8) |
| R6 | Emit one `RunEventOutbox` row per externally-visible state change, in the same transaction |

## 4. Non-responsibilities

| Belongs to | Not here |
|---|---|
| `02` / `17` | What a node *does* internally |
| `08` | Who may approve, routing, SLA |
| `09` | Whether the actor may run this workflow |
| `10` | Audit-log content and hash chaining |
| `11` | Rollups and analytics |
| `13` | HTTP surface and DTO shapes |
| `06` | Variable resolution and scoping |

The runtime calls into these; it does not implement them.

## 5. Dependencies

`PrismaService`; BullMQ + Redis (`common/resilience/redis-connection.ts`); `NodeRegistry` (doc 02);
`RetryPolicyService`, `TimerService`, `CompensationService`, `JoinResolver` (doc 05);
`toolRequiresApproval` (`modules/skills/tool-approval-policy.ts` — the G25 gate, already shipped);
`common/resilience` circuit breaker + rate limiter + error classifier.

---

## 6. Detailed runtime behaviour

### 6.1 The two-queue split, and why

`wf-run-advance` decides *what to do next*. `wf-node-attempt` *does it*. They are separate because a
decision is cheap, idempotent and safe to repeat, while an attempt is expensive and may have an
irreversible side effect. Collapsing them would make every retry of the decision risk re-running the
effect.

```
advance(runId) ──► load run + version + step state
                   │
                   ├─ terminal?           ──► finalise, emit, stop
                   ├─ next node is WAIT?  ──► create timer, run → WAITING, stop
                   ├─ next node gated?    ──► create approval, run → WAITING, stop
                   └─ otherwise           ──► enqueue wf-node-attempt, stop
attempt(...)   ──► claim lease ──► execute ──► record ──► enqueue advance
```

Each worker does **one** unit and re-enqueues. No worker holds a run across an await of unbounded
duration.

### 6.2 [AMBIGUITY A1] Per-run serialisation

L1 requires "at most one in-flight advance per run" but does not say how.

**Resolution: a database advisory lock keyed on the run, not a Redis lock.** The state the lock
protects is in Postgres, so the lock must share its failure domain — a Redis eviction or failover must
never allow two advances. Cost is one round trip.

```ts
// Returns false if another worker holds the run; the job then exits cleanly (no retry
// needed — whoever holds it will enqueue the next advance).
private async withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T | null> {
  const [{ locked }] = await this.prisma.$queryRaw<[{ locked: boolean }]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${runId}, 0)) AS locked
  `;
  if (!locked) return null;
  return fn();
}
```

Must be called **inside** a transaction (`pg_try_advisory_xact_lock` releases on commit/rollback), which
also guarantees release if the worker dies.

### 6.3 [AMBIGUITY A2] Lease claim

L1 defines `AttemptLease` but not how it is claimed without two workers claiming the same attempt.

**Resolution: `UPDATE … WHERE` guarded on the current lease, single statement.** Not
`SELECT … FOR UPDATE SKIP LOCKED` — that holds a row lock for the attempt's whole lifetime, which for a
30s HTTP call means a 30s open transaction.

```sql
UPDATE "WorkflowStepAttempt"
   SET "leaseOwner" = $worker, "leaseExpiresAt" = now() + interval '60 seconds',
       "status" = 'RUNNING', "startedAt" = coalesce("startedAt", now())
 WHERE "id" = $attemptId
   AND ("leaseOwner" IS NULL OR "leaseExpiresAt" < now())
RETURNING "id";
```

Zero rows returned ⇒ someone else owns it ⇒ exit without error. Lease TTL is 60s and is **heartbeat-
renewed** every 20s by the executing worker; a node whose own timeout exceeds 60s stays safe because the
heartbeat keeps extending. If the worker dies, the heartbeat stops and the lease expires within 60s,
satisfying §0.8's recovery target.

### 6.4 [AMBIGUITY A3] Idempotency key derivation

L1 requires exactly-once side effects but never defines the key.

**Resolution:**

```
idempotencyKey = sha256(`${runId}:${nodeId}:${attempt}`)   // per ATTEMPT, not per node
```

Per-attempt, deliberately. A retry is a *new* attempt and must be allowed to re-issue the call — the
previous one may have failed before reaching the provider. Deduplicating per-node would make retries
silent no-ops. Connectors that support provider-side idempotency (Stripe) receive this value; those that
don't rely on the lease to prevent concurrent duplicates.

### 6.5 [AMBIGUITY A4] Transaction boundary around the side effect

The hardest correctness question, and L1 does not settle it: a node's external call cannot be inside a
database transaction (it would hold the transaction open for the call's duration and roll back
bookkeeping the provider already acted on).

**Resolution — three phases, two transactions, effect in the middle:**

```
T1 (tx): claim lease; write attempt RUNNING           ── commit ──►
         execute the node's side effect (NO transaction open)
T2 (tx): write attempt result + step status + outbox row  ── commit ──►
         enqueue next advance (AFTER commit)
```

The window between the effect and T2 is the only unsafe gap: a crash there leaves an effect that
happened with no record. This is **at-least-once by construction and cannot be eliminated** without
provider-side two-phase commit. It is bounded and detected by the reaper (§6.7): the lease expires, the
attempt is found `RUNNING` past its lease, and it is marked `FAILED` with
`failureClass = 'INTERNAL'` and `outcomeUnknown = true` rather than blindly retried. Retrying a
possibly-completed side effect is a worse failure than surfacing it.

**Never** enqueue the next job inside T2 — if T2 rolls back, the job would already be on the queue.

### 6.6 Attempt execution

```ts
async function runAttempt(job: NodeAttemptJob): Promise<void> {
  const lease = await claimLease(job.attemptId, workerId);      // §6.3
  if (!lease) return;                                            // lost the race

  const heartbeat = setInterval(() => renewLease(job.attemptId, workerId), 20_000);
  try {
    const node = registry.get(job.nodeType);                     // doc 02
    const result = await withTimeout(
      node.execute(buildContext(job)),
      node.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
    );
    await recordSuccess(job, result);                            // T2
  } catch (err) {
    const decision = retryPolicy.classify(err, job.attempt);     // doc 05
    await recordFailure(job, err, decision);                     // T2
    if (decision.retry) await scheduleRetry(job, decision);
  } finally {
    clearInterval(heartbeat);
  }
  await enqueueAdvance(job.runId);                               // after commit
}
```

`DEFAULT_NODE_TIMEOUT_MS = 30_000`. Every node **must** be wrapped — an un-timed-out node holds a
worker slot forever and is the single most common cause of a wedged queue.

### 6.7 The reaper

Runs every 60s (`wf-timer` queue, repeatable job). Three sweeps:

| Sweep | Finds | Action |
|---|---|---|
| Expired leases | `WorkflowStepAttempt` `RUNNING` and `leaseExpiresAt < now()` | Mark `FAILED`, `failureClass='INTERNAL'`, `outcomeUnknown=true`; enqueue advance |
| Stuck runs | `WorkflowRun` `RUNNING` with no live attempt and no queued advance, older than 5 min | Enqueue advance (self-heal) |
| Overdue runs | `WorkflowRun.deadlineAt < now()` and non-terminal | Transition to `TIMED_OUT` |

The existing 5-minute watchdog (already shipped) is superseded by sweep 2 and must be removed in the
same PR to avoid two components fighting over the same rows.

---

## 7. State transitions

**Run** (`WorkflowRunStatus`, §0.7.1):

```
PENDING ──► RUNNING ──► COMPLETED
   │           │  ▲          
   │           │  └── WAITING (timer fired / approval decided)
   │           ├──► WAITING ──► FAILED        (approval rejected)
   │           ├──► FAILED
   │           ├──► TIMED_OUT                 (deadlineAt exceeded)
   │           ├──► CANCELLED                 (operator/API)
   │           └──► COMPENSATING ──► FAILED | CANCELLED
   └──────────────► CANCELLED                 (cancelled before start)
```

**Step** (`StepRunStatus`): `PENDING → RUNNING → COMPLETED | FAILED | SKIPPED`, plus
`RUNNING → RETRYING → RUNNING`, `RUNNING → WAITING → RUNNING`, and `COMPLETED → COMPENSATED`.

Illegal transitions **must throw**, not silently no-op — a silent no-op here is how a run ends up in a
state nobody can explain. Enforce centrally:

```ts
const RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  PENDING:      ['RUNNING', 'CANCELLED'],
  RUNNING:      ['WAITING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'COMPENSATING'],
  WAITING:      ['RUNNING', 'FAILED', 'TIMED_OUT', 'CANCELLED'],
  COMPENSATING: ['FAILED', 'CANCELLED'],
  COMPLETED: [], FAILED: [], TIMED_OUT: [], CANCELLED: [],
};
export function assertRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  if (!RUN_TRANSITIONS[from].includes(to)) {
    throw new IllegalStateTransitionError(`run: ${from} → ${to}`);
  }
}
```

Terminal states have empty arrays — that is what makes "a COMPLETED run can never be reopened"
mechanical rather than a convention.

---

## 8–9. TypeScript contracts and interfaces

Only what L1 does **not** already declare.

```ts
/** Result of trying to take an attempt lease. */
export interface LeaseClaim {
  attemptId: string;
  workerId: string;
  expiresAt: Date;
}

/** Everything a node needs, assembled once per attempt. */
export interface AttemptContext {
  runId: string;
  companyId: string;                 // ALWAYS present — see §20
  workflowVersionId: string;
  nodeId: string;
  nodeType: NodeType;                // §0.7.1
  attempt: number;                   // 1-based
  idempotencyKey: string;            // §6.4
  config: Readonly<Record<string, unknown>>;
  variables: Readonly<Record<string, unknown>>;  // doc 06 resolves these
  correlationId: string;
  deadlineAt: Date | null;
  actingEmployeeId: string | null;
  logger: RuntimeLogger;
}

export interface RuntimeLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class IllegalStateTransitionError extends Error {}
export class LeaseLostError extends Error {}

/** Emitted into RunEventOutbox in the SAME transaction as the state change. */
export interface RunEventEnvelope {
  seq: number;            // BigInt autoincrement — NOT `sequence` (doc 14 §14.B.7)
  runId: string;
  companyId: string;
  type: RunEventType;
  emittedAt: string;      // ISO, the DB commit time
  data: Record<string, unknown>;
}
```

`AttemptContext` is `Readonly` on `config`/`variables` deliberately: a node mutating its own config has
caused bugs that only appear on retry, when the mutated value is re-read.

---

## 10. Validation rules

| Rule | Enforced where | On violation |
|---|---|---|
| Node count ≤ `MAX_WORKFLOW_NODES` | Publish time (doc 01) | `422` |
| Every edge's `from`/`to` exists | Publish time | `422` |
| No cycles except through `LOOP` | Publish time | `422` |
| `nodeType` is in the registry | Publish + attempt | `422` / `FAILED VALIDATION_ERROR` |
| Attempt number ≤ `maxAttempts` | Retry scheduling | Route to DLQ |
| `companyId` on job == `companyId` on run | Every worker, first line | Throw, alert (§20) |

Validation runs at **publish**, not at run start. A run that fails validation at start means an invalid
version was published, which is a bug in the publish path — but the attempt-time check stays as
defence in depth.

## 11. Error handling

Classify before reacting (`common/resilience` error classifier):

| Class | Examples | Retry? | Terminal status |
|---|---|---|---|
| `TRANSIENT` | 5xx, ECONNRESET, timeout | Yes | — |
| `RATE_LIMITED` | 429 | Yes, honour `Retry-After` | — |
| `CONNECTOR_UNAVAILABLE` | breaker open, DEGRADED | Yes, longer backoff | `FAILED` |
| `VALIDATION_ERROR` | bad config, unknown tool | **No** | `FAILED` |
| `AUTHORIZATION_DENIED` | permission/grant denied | **No** | `FAILED` |
| `INTERNAL` | bug, `outcomeUnknown` | **No** | `FAILED` |

Never retry a non-retryable class — retrying a `VALIDATION_ERROR` burns the whole retry budget on an
error that cannot change.

## 12. Retry behaviour

Uses `RetryPolicyService` (doc 05). Implementation constraints:

- Backoff `EXPONENTIAL` with **full jitter**: `delay = random(0, min(base * 2^(n-1), cap))`.
  Without jitter, N nodes failing on one provider outage retry in lockstep and re-DDoS it on recovery.
- `base = 1000ms`, `cap = 300_000ms`, `maxAttempts = 3` unless the node overrides.
- **Three retry layers must not compound** (this is the trap): BullMQ job retries, the runtime's
  per-node retry, and the connector's internal HTTP retry. Only the **runtime layer** retries business
  failures. BullMQ `attempts` is set to `1` for `wf-node-attempt` — the runtime schedules its own retry
  as a *new delayed job*, so the attempt count is visible in the database rather than hidden in Redis.
  Connector-level HTTP retry is capped at 1 immediate retry for idempotent verbs only.

## 13. Idempotency requirements

| Operation | Key | Mechanism |
|---|---|---|
| Run creation | `WorkflowRun.idempotencyKey` | `@@unique([companyId, idempotencyKey])` |
| Advance job | `advance:${runId}:${stepCursor}` | BullMQ `jobId` dedup |
| Node attempt | `attempt:${attemptId}` | BullMQ `jobId` + lease |
| Side effect | §6.4 | Provider idempotency where supported |
| Timer fire | `timer:${timerId}` | `WorkflowRunTimer.firedAt` null-check |
| Outbox publish | `seq` | Relay tracks last published `seq` |

Setting BullMQ `jobId` is what makes a duplicate enqueue free rather than a double execution.

## 14. Concurrency behaviour

- One advance per run (§6.2); unlimited runs in parallel.
- One attempt per `(runId, nodeId, attempt)` (§6.3).
- Parallel lanes (doc 05 §5.B) run as independent `wf-node-attempt` jobs; `JoinResolver` reconciles via
  `WorkflowJoinState` using an atomic `UPDATE … SET arrived = arrived + 1 … RETURNING arrived` — never
  read-then-write, which loses a lane under contention.
- Worker concurrency: `wf-node-attempt` is the only one that should exceed 1. Start at
  `min(16, cores-2)`; `wf-run-advance` at 4; `wf-timer`/`wf-compensate` at 1.
- **Per-tenant fairness:** a single tenant enqueueing 10k attempts must not starve others. Cap
  in-flight attempts per company in Redis (`INCR`/`DECR` with TTL); over the cap, re-enqueue with a
  short delay rather than executing.

## 15. Database interactions

Every query filters `companyId` first (§20). Indexes this runtime depends on (doc 12):
`WorkflowRun(status, deadlineAt)` — reaper; `WorkflowRun(companyId, status)`;
`WorkflowStepAttempt(runId, attempt)`; `RunEventOutbox(publishedAt, id)` — relay.

Writes are small and short. **No transaction may stay open across an external call** (§6.5).

## 16. API interactions

The runtime exposes no HTTP surface. Doc 13 owns it. The runtime is invoked by `POST /workflows/:id/run`
(→ enqueue advance), `POST /runs/:id/cancel`, `POST /runs/:id/compensate`, and approval decisions
(→ `resumeRun`). Reads (`GET /runs/:id/timeline`) never touch the runtime — they read the tables.

## 17. Events

One `RunEventOutbox` row per externally-visible change, written in T2. A relay publishes them in `seq`
order and marks `publishedAt`. Types: `run.started`, `run.completed`, `run.failed`, `run.cancelled`,
`run.timed_out`, `run.waiting`, `run.resumed`, `step.started`, `step.completed`, `step.failed`,
`step.retrying`, `step.skipped`, `step.compensated`.

Transactional outbox rather than direct publish — a direct publish either fires for a rolled-back
transaction or is lost on crash. Consumers must tolerate duplicates (at-least-once) and use `seq` to
detect gaps.

## 18. Queue interactions

| Queue | Concurrency | BullMQ attempts | Notes |
|---|---|---|---|
| `wf-run-advance` | 4 | 1 | Cheap, idempotent |
| `wf-node-attempt` | `min(16, cores-2)` | 1 | Runtime owns retry (§12) |
| `wf-timer` | 1 | 3 | Repeatable reaper + delayed timers |
| `wf-compensate` | 1 | 3 | Ordered rollback |
| `wf-dlq` | — | — | Terminal parking |

All five **must** be added to `DLQ_KNOWN_QUEUES` (`common/resilience/dlq.constants.ts`) — per ledger
**R7** (`13-api.md` §13.0.2) there is **no** `/admin/workflow-dlq*` surface; reuse
`GET /admin/dlq?queue=…`. Two queues were previously missing from that list and their poison jobs were
invisible; do not repeat it.

## 19. Security

Job payloads carry **identifiers only, never secrets or resolved credentials** — Redis is not
encrypted at rest here and payloads appear in DLQ dumps. Resolve credentials at execution time via the
connector layer. Redact `args` in logs against the connector's declared secret fields. Egress passes
the existing SSRF guard.

## 20. Tenant isolation

**A worker must never trust the `companyId` in a job payload.** Load the run by `id`, read its
`companyId` from the row, and assert it matches the payload; mismatch is a security event — throw,
log, alert, do not process. Every subsequent query uses the row's value. A forged or stale payload is
otherwise a cross-tenant execution.

## 21. Permissions

Authorisation is decided at **enqueue** time (doc 09), not per attempt — re-checking mid-run would make
a permission change mid-flight fail a half-completed run inconsistently. Two exceptions re-checked at
attempt time because they are safety controls, not access controls: the **G25 approval gate**
(already shipped) and subscription/plan state (a cancelled subscription must stop consuming).

## 22. Audit requirements

Doc 10 owns content. The runtime must emit an audit event for: run start, terminal transition, every
approval pause/resume, cancellation, compensation, and DLQ routing. `correlationId` threads
event → run → step → attempt and must be propagated into every job payload and log line.

## 23. Observability

Per attempt: `runId`, `companyId`, `nodeId`, `nodeType`, `attempt`, `correlationId`, `durationMs`,
`outcome`, `failureClass`. Metrics: attempt rate/error/duration (RED) per `nodeType`; queue depth and
oldest-job-age per queue; lease-expiry count (a rising count means workers are dying); outbox lag.
Traces: span per run → per step → per attempt, `correlationId` as trace id.

**Alert on:** oldest `wf-node-attempt` job age > 5 min; outbox lag > 1 min; lease expiries > 10/min;
any `wf-dlq` arrival.

## 24. Performance requirements

From §0.8: 10M node-attempts/day (~116/s sustained, design for 500/s peak); run-start p95 < 2s; node
overhead p95 < 50ms (runtime's own cost, excluding the node's work); timer accuracy ±30s; orphan
recovery < 60s.

The 50ms budget is the binding constraint: it allows roughly one lock, one lease claim, one context
build and two small writes. It rules out loading the full run history per attempt — load only the
current step's state.

## 25. Edge cases

| # | Case | Required behaviour |
|---|---|---|
| E1 | Worker dies mid-effect | Lease expires; attempt `FAILED` + `outcomeUnknown`; **not** auto-retried |
| E2 | Duplicate advance enqueued | Second exits on lock miss (§6.2) |
| E3 | Approval decided twice | `ApprovalRequest` claim (doc 08); second is a no-op |
| E4 | Timer fires for a cancelled run | Load run, see terminal, discard |
| E5 | Version deleted mid-run | Impossible — versions are immutable and never hard-deleted |
| E6 | Clock skew across workers | All deadlines computed by the **database** (`now()`), never `Date.now()` |
| E7 | Node returns a huge payload | Cap at 256KB; truncate with a marker; oversized output is a common OOM |
| E8 | Parallel lanes both fail | First failure wins `failureClass`; both recorded |
| E9 | `LOOP` never terminates | Per-run step budget (§0.8); exceed → `FAILED BUDGET_EXCEEDED` |
| E10 | Redis flushed | Runs stay in DB; reaper sweep 2 re-enqueues. **Must survive this** |

E10 is the real test of the design: state lives in Postgres, Redis holds only work-in-progress.

## 26. Failure scenarios

| Scenario | Blast radius | Recovery |
|---|---|---|
| Postgres down | Total stop | Jobs retry; no data loss |
| Redis down | No new work; in-flight completes | Reaper re-enqueues on recovery |
| One worker dies | Its leases | ≤60s |
| All workers die | Everything pauses | Runs resume from last committed step |
| Poison job | One run | DLQ after `maxAttempts` |
| Provider outage | Nodes using it | Breaker opens; `CONNECTOR_UNAVAILABLE` |
| Outbox relay down | Realtime stale | Rows accumulate; drains on recovery; **no loss** |

## 27. Testing requirements

Detailed strategy in `24-testing-strategy.md`. This runtime specifically requires:

- **Unit:** transition matrix (every illegal transition throws); retry classification; backoff jitter
  bounds; idempotency key stability.
- **Integration (real Postgres + Redis):** concurrent advance → exactly one proceeds; lease expiry →
  reaper recovers; duplicate `jobId` → single execution; join under parallel arrival.
- **Chaos:** kill a worker mid-attempt and assert `outcomeUnknown` (not silent retry); flush Redis
  mid-run and assert completion; induce clock skew.
- **Regression:** the existing workflow e2e suites must pass **unchanged** under
  `WORKFLOW_ENGINE_MODE=state_machine` — that is the cutover's proof.

## 28. Acceptance criteria

1. Existing workflow e2e suites pass in both engine modes.
2. Concurrency test: 100 parallel advances on one run ⇒ exactly one executes.
3. Kill-9 a worker mid-attempt ⇒ recovered < 60s, side effect not repeated.
4. `FLUSHALL` on Redis mid-run ⇒ every run reaches a terminal state.
5. Node overhead p95 < 50ms at 500 attempts/s.
6. Timers fire within ±30s under load.
7. All five queues appear in `GET /admin/dlq`.
8. No job payload contains a secret (automated scan).
9. Cross-tenant payload rejected and alerted.

## 29. Implementation notes

Build order inside W3 (`00 §0.10`): transition matrix + tests → lease/claim → advance worker →
attempt worker → outbox + relay → timers → reaper → retry/DLQ → compensation → cutover flag.

`WORKFLOW_ENGINE_MODE = legacy_walk | state_machine` **per company**. Both paths run against the same
e2e suite. Migrate the live Kashif tenant last, after a throwaway tenant has run for a full day.
Do not delete `workflow-engine.service.ts`'s walk until every tenant is migrated.

The G25 gate is already shipped in the legacy walk and **must be ported to the state machine before
cutover** — reintroducing the bypass would be a regression of a closed P0.

## 30. Definition of Done

- [ ] All §28 acceptance criteria pass in CI
- [ ] Transition matrix is the only writer of run/step status
- [ ] No transaction spans an external call (reviewed)
- [ ] Every query filters `companyId`; payload `companyId` asserted, never trusted
- [ ] Five queues registered in `DLQ_KNOWN_QUEUES`
- [ ] Metrics + alerts of §23 live in the dashboard
- [ ] Legacy walk still passes with the flag off
- [ ] G25 gate ported and covered by `workflow-tool-approval-gate.e2e-spec.ts` in both modes
- [ ] Runbook written for: stuck run, DLQ drain, outbox lag, mass lease expiry

---

**Ambiguities resolved here:** A1 per-run serialisation (advisory lock), A2 lease claim (guarded
UPDATE), A3 idempotency key (per-attempt), A4 transaction boundary (three-phase, at-least-once with
`outcomeUnknown`). None contradicts L1; each is additive.

**Next:** `17-node-library-spec.md`.
