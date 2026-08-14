# Turning on the durable engine — one company at a time

WAVE 9 finding **B1**. The durable state machine was built in WAVE 1, tested,
and never switched on: every run in every environment still uses the old
in-memory walker. This is the plan for changing that safely.

**Decision taken (2026-08-13): pilot with ONE company first**, watch it, then
widen. Not a global flip.

---

## Plain-language version

A workflow is a job with steps: *read email → screen CV → ask manager → send
reply*.

- **Old engine (running today).** Runs all the steps in one go, in memory,
  writing nothing down as it goes. If the server restarts halfway, that job is
  stuck and a person has to notice.
- **New engine.** Writes each step to the database *before* doing it. If the
  server dies, another worker resumes from exactly where it stopped — and if a
  step may already have sent the email, it stops and asks a human rather than
  sending twice.

The new engine needs one **always-on background server** (a "worker"). Vercel
only runs code when a request arrives, so on Vercel the new engine cannot run at
all — the code deliberately falls back to the old one rather than silently
enqueueing work nothing will ever pick up.

---

## Prerequisite: somewhere for a worker to live

The durable engine is queue-driven by construction — a *decision* (advance) and
an *effect* (attempt) are separate jobs, precisely so retrying a decision cannot
re-run an effect. That needs a process that is always listening.

| Requirement | Value |
| --- | --- |
| `WORKFLOW_EXECUTION_MODE` | `queue` (the default — must **not** be `inline`) |
| `QUEUE_WORKERS_ENABLED` | unset or `true` on the worker process |
| Host | any always-on runtime (small VM, Render, Railway, Fly, ECS). **Not** Vercel serverless |
| Redis | already required; the worker and the API must share it |

Until such a process exists, opting a company in does nothing — `modeFor()`
returns `legacy_walk` whenever execution mode is `inline`.

---

## The rollout

### Step 1 — pick a pilot company

Use a **real but low-volume** tenant, or an internal test one. Get its id:

```sql
select id, name from "Company" where name = 'Pilot Co';
```

### Step 2 — opt exactly that company in

On the API **and** the worker:

```bash
WORKFLOW_EXECUTION_MODE=queue
QUEUE_WORKERS_ENABLED=true
WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES=<companyId>
# WORKFLOW_ENGINE_MODE stays UNSET → everyone else keeps the old engine
```

Confirm on boot:

```
[EngineModeService] workflow engine mode: default=legacy_walk opted-in-companies=1
```

If that line says `opted-in-companies=0`, the variable did not reach the
process; nothing else in this document will work.

### Step 3 — verify which engine actually ran the job

This is the only check that matters, and it needs no special tooling. **The old
engine never writes `WorkflowStepAttempt` rows.** So:

```sql
-- Ran on the NEW engine if this returns rows:
select s."nodeId", a.attempt, a.status
from "WorkflowStepAttempt" a
join "WorkflowStepRun" s on s.id = a."stepId"
where a."runId" = '<runId>'
order by a."createdAt";
```

And confirm the blast radius is contained — a company that was **not** opted in
must return **0**:

```sql
select count(*) from "WorkflowStepAttempt" where "runId" = '<otherCompanysRunId>';
```

### Step 4 — watch for a week

| Watch | Where | What is bad |
| --- | --- | --- |
| Runs stuck in `RUNNING` | `WorkflowRun` | reaper not reclaiming — check the worker is alive |
| `outcomeUnknown = true` attempts | `WorkflowStepAttempt` | a worker died mid-effect; each one needs a human decision |
| Queue depth | `/admin/metrics` → `queue_depth` | rising = worker too slow or down |
| Duplicate side effects | the provider (inbox, Slack) | **stop the rollout** — this is the invariant the engine exists to protect |

### Step 5 — widen

Add company ids to the same comma-separated list. Only once you are confident
across several tenants, set `WORKFLOW_ENGINE_MODE=state_machine` to make the new
engine the default for everyone.

### Rollback

Remove the company id from `WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES` and
restart. New runs immediately use the old engine again.

**Runs already in flight on the new engine are the caveat.** A run parked at an
approval keeps its state-machine rows; after rollback nothing advances it. Roll
back when the tenant is quiet, or let in-flight runs finish first. This is the
one part of the rollout that is not instant, and it should not be discovered
during an incident.

---

## Rehearsal — done 2026-08-13, real, recorded

Run locally against real Postgres and Redis, API on :4100, workers enabled, with
exactly one company opted in (`cmsqfjuz9005d2m3xubbsftdb`, a throwaway WAVE 7
test tenant — never a real customer).

**Boot:**

```
[EngineModeService] workflow engine mode: default=legacy_walk opted-in-companies=1
```

**Opted-in company** — workflow with TRIGGER → APPROVAL → AI_EMPLOYEE_STEP:

```
run status: WAITING
WorkflowStepAttempt rows:
  trigger              attempt 1  COMPLETED
  approval-0d7b72b9    attempt 1  COMPLETED
```

Attempt rows exist → the **durable engine** executed it.

**Control company (NOT opted in)**, same server, same moment:

```
run status: COMPLETED
WorkflowStepAttempt rows: 0
steps: t COMPLETED, n COMPLETED
```

Zero attempt rows → still the **old engine**. The pilot is contained.

**Completing the loop** — approved through the API, run resumed:

```
run status: COMPLETED
nodeId                     attempts
trigger                    1
approval-0d7b72b9          2
ai_employee_step-0f485f23  1
```

The side-effecting AI step ran **exactly once**. The APPROVAL node shows two
attempts because a durable approval gate is re-entrant by design: attempt 1
parks the run as `WAITING`, attempt 2 resumes it after the human decides. That
is the expected shape, not a double execution — and it is worth knowing before
you see it in production and think something ran twice.

---

## What is still not true after this

- The durable engine is **off in every deployed environment** until the worker
  above exists and the variables are set. This rehearsal was local.
- On Vercel it cannot be turned on at all. Moving to it means moving execution
  off serverless-only hosting.
- Until then, do not describe execution as durable, self-healing or
  auto-recovering to a customer. The capability is real; it is not in force.
