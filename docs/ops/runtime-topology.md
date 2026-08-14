# Runtime topology — workers, connection pooling, compensation

**Closes three Definition-of-Done items from the hardening plan §56 (Operations
and Execution):** *worker deployment strategy defined*, *connection pooling
strategy defined*, and *compensation semantics are explicit*.

Two of those are decisions to write down. The third is a decision to write down
**honestly**, which is the harder one.

---

## 1. Compensation — NOT IMPLEMENTED, and that is the semantic

The durable state machine already models compensation:

```
run:  RUNNING → COMPENSATING → FAILED | CANCELLED
step: COMPLETED → COMPENSATED
```

`WF_COMPENSATE_QUEUE` and `WF_COMPENSATE_JOB` exist too.

**Nothing drives any of it.** No code enqueues a compensate job, and no
processor consumes that queue. A run cannot reach `COMPENSATING`, and no step is
ever marked `COMPENSATED`.

This is stated plainly rather than left to be discovered, because the states are
visible in the schema and in `run-state.ts`, and reading them naturally suggests
the platform rolls a failed workflow back. **It does not.** When a step fails:

- the step is marked `FAILED` and the run is marked `FAILED`
- **already-completed steps are left exactly as they are** — an email that was
  sent stays sent, a payment link that was created stays created
- nothing is undone, retried in reverse, or cancelled downstream

### What an author should do instead

Model the undo explicitly in the graph. A `CONDITION` on the failure path
followed by a compensating `TOOL_ACTION` is a real rollback the author can see,
test and approve — and it is subject to the same high-risk approval gate as any
other side effect. An implicit saga would not be.

### Why not build it now

The plan's WAVE 1 task list is versioning, node registry, attempts, leases,
timers, retry, idempotency, approval state, reaper, outbox and cutover.
Compensation is not on it. A half-built saga layer is the more dangerous
outcome: people trust a rollback that only sometimes happens. The states stay in
the state machine because they are the correct target — and this document is the
contract until something drives them.

**If compensation is implemented later, the first thing it needs is a chaos test
proving a compensating action is itself exactly-once.** An undo that runs twice
is a second incident.

---

## 2. Worker deployment

There is exactly one process image (`apps/api/src/main.ts`). What it *does* is
decided by two environment variables, not by two builds — so a worker and an API
can never drift apart in version.

| Variable | Effect |
| --- | --- |
| `QUEUE_WORKERS_ENABLED` | unset/`true` → this process consumes BullMQ queues. `false` → HTTP only. |
| `WORKFLOW_EXECUTION_MODE` | `queue` (default) → runs are enqueued for a worker. `inline` → executed inside the request. |

### The three supported shapes

**A. Single always-on process (local, small deployments).**
Defaults. One process serves HTTP *and* consumes queues.

**B. Split: serverless HTTP + always-on worker (the target).**
API on Vercel with `QUEUE_WORKERS_ENABLED=false`, plus **at least one** always-on
worker with workers enabled and `WORKFLOW_EXECUTION_MODE=queue`. This is the only
shape in which the durable engine is genuinely in force.

**C. Serverless only (current deployment).**
`WORKFLOW_EXECUTION_MODE=inline`. There is no worker, so `EngineModeService`
**forces `legacy_walk`** — durable attempts, leases and reaper recovery do not
happen, and the API logs that loudly at boot. Time-based work is driven by
`/admin/cron/*` on a schedule instead of by BullMQ repeatables.

> **Shape C cannot be described to a customer as durable, self-healing or
> auto-recovering.** That is the standing WAVE 9 B1 blocker: it is a hosting
> decision, not a code gap.

### Scaling workers

Workers are safe to run N-up: every attempt is claimed under a database lease and
every advance under a per-run advisory lock, so two workers racing the same run
produce one execution. `DEFAULT_QUEUE_CONCURRENCY` bounds in-flight jobs per
process, and `MAX_INFLIGHT_ATTEMPTS_PER_COMPANY` (50) stops one tenant starving
the rest.

---

## 3. Connection pooling

### Reality today

`PrismaService` is a true singleton exported from a global module, so the whole
process shares **one** `PrismaClient` and therefore one pool. `DATABASE_URL`
carries no `connection_limit`, so Prisma's default applies:
`num_physical_cpus * 2 + 1`.

### Why that default is a trap in shape B/C

The pool is **per process**, and serverless multiplies processes. Ten concurrent
Vercel lambdas at 9 connections each is 90 connections; a managed Postgres with a
100-connection ceiling is then one traffic spike away from
`too many clients already` — which surfaces as authentication failures and looks
like an outage in a completely different subsystem.

### The strategy

1. **Serverless (HTTP) processes: cap the pool explicitly.**
   `?connection_limit=3&pool_timeout=10` on `DATABASE_URL`. A request handler
   does a handful of short queries; a large pool per lambda buys nothing and
   costs the ceiling.
2. **Worker processes: leave the default, bound concurrency instead.**
   A worker's parallelism is already limited by `DEFAULT_QUEUE_CONCURRENCY`, so
   the pool is sized by that rather than by CPU count.
3. **Past ~2 serverless instances, put a pooler in front** (PgBouncer in
   transaction mode, or the provider's own). Prisma then needs
   `pgbouncer=true` in the URL so it stops using prepared statements — omitting
   it produces intermittent `prepared statement "s0" already exists` errors that
   look like data corruption and are not.
4. **`connection_limit` belongs in the connection string, not in code.** It is a
   per-environment number; hard-coding it makes the two shapes above impossible
   to serve from one build.

### Not yet done

No production database has been sized against this, because there is no
always-on worker host to size it for. The numbers above are the strategy; the
measurement belongs with the hosting decision.
