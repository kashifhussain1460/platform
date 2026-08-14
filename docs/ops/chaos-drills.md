# Chaos drills

WAVE 8 §8.1. Fourteen failure scenarios, six invariants:

```
No lost run          No duplicate side effect    No tenant leak
No approval bypass   No phantom success          No secret leak
```

## How the fourteen are split

Some failures can be caused honestly from inside a test. Some cannot — they need
the infrastructure to actually be taken away, and an in-process mock of "Redis
went away" proves nothing about a real Redis outage. Those are **drills**: run
by a person, against a running system, with the result recorded here.

| # | Scenario | How it is covered | Where |
| --- | --- | --- | --- |
| 1 | Worker crash | automated (lease expiry → `outcomeUnknown`, no retry) | `test/chaos.e2e-spec.ts` |
| 2 | API restart | automated (run survives process teardown) + **drill 1** below | `test/chaos.e2e-spec.ts` |
| 3 | Redis restart | **drill 2** | below |
| 4 | DB connection loss | **drill 3** | below |
| 5 | Duplicate queue job | automated (idempotency key → one run) | `test/chaos.e2e-spec.ts` |
| 6 | Duplicate webhook | automated (same delivery id → one Raw/Canonical event; mutated-header replay still deduped) | `test/event-ingestion.e2e-spec.ts` |
| 7 | External API timeout | automated (retry classifier → DLQ, replay/discard) | `test/dlq.e2e-spec.ts`, `test/workflow-runtime-p1.e2e-spec.ts` |
| 8 | External API 500 | automated (same) | `test/dlq.e2e-spec.ts`, `test/integrations.e2e-spec.ts` |
| 9 | OAuth expiry | automated (`invalid_grant` on refresh → connector `DISCONNECTED`) | `test/connector-health.e2e-spec.ts` |
| 10 | LLM timeout | ⚠️ **NOT COVERED** — see below | — |
| 11 | Approval timeout | automated (escalate / AUTO_APPROVE / EXPIRED / race) | `test/approval-sla.e2e-spec.ts` |
| 12 | Deployment during workflow | **drill 1** (it is an API restart with traffic) | below |
| 13 | Lease expiry | automated | `test/chaos.e2e-spec.ts` |
| 14 | Reaper recovery | automated | `test/chaos.e2e-spec.ts` |

### Known gap: LLM timeout (#10)

There is **no test** for what happens when the model provider hangs. The
`LlmProvider` seam supports abort, and a thrown error would fail the step like
any other — but "would" is not evidence, and this is a likely failure in
production: an AI_EMPLOYEE_STEP is the longest-running node type in the system
and the one most exposed to a third party's latency.

What needs proving: a provider that never responds must fail the step within a
bounded time, leave the run in a non-`COMPLETED` state, and not hold a worker
slot indefinitely. Do not report §8.1 as fully closed until this exists.

Run the automated ones with:

```bash
cd apps/api
SKILL_EXECUTOR=mock BILLING_PROVIDER=mock LLM_PROVIDER=mock \
EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
  npx jest --config ./test/jest-e2e.json --testPathPattern chaos
```

---

## Drill 1 — kill the API mid-run (also covers "deployment during workflow")

A deploy is an API restart that happens while runs are in flight. Same drill.

```bash
# 1. Start a workflow that pauses at an APPROVAL node. Confirm it is WAITING.
curl -s "$API/workflows/runs/$RUN" -H "Authorization: Bearer $TOKEN" | jq .status
#    -> "WAITING"

# 2. Kill the process outright. Not a graceful shutdown — a crash.
#    Linux:   kill -9 $(lsof -ti :4000)
#    Windows: taskkill //PID $(netstat -ano | grep ':4000 .*LISTENING' | awk '{print $5}') //F

# 3. Bring it back.
pnpm --filter @vaep/api run dev

# 4. Approve, and check the run finished with EXACTLY ONE execution per step.
curl -s "$API/workflows/runs/$RUN" -H "Authorization: Bearer $TOKEN" \
  | jq '{status, steps: [.steps[] | {nodeId, status, attempt}]}'
```

**Pass:** run is `COMPLETED`; every step appears once with `attempt = 1`.
**Fail:** any step at `attempt > 1` with a real side effect, or a run that
reports `COMPLETED` with a step missing.

### Last run — 2026-08-12 (recorded)

Performed against a real local stack (API :4000 killed with `taskkill /F` while
run `cmsqgjs5d0039fuicrlx62qrm` was `WAITING` on an approval):

```
run status after crash+restart : WAITING      <- state survived in Postgres
   trigger              TRIGGER  COMPLETED  attempt=1
   approval-0d7b72b9    APPROVAL RUNNING    attempt=1

...approved through the browser after restart:

run status : COMPLETED
step rows  : 3
   trigger                    TRIGGER            COMPLETED  attempt=1
   approval-0d7b72b9          APPROVAL           COMPLETED  attempt=1
   ai_employee_step-0f485f23  AI_EMPLOYEE_STEP   COMPLETED  attempt=1
AI step executed exactly once: True
```

Invariants held: no lost run, no duplicate side effect, no phantom success.

---

## Drill 2 — Redis restart

Redis holds the queue, rate limiters and circuit-breaker state. It is
deliberately treated as **disposable**: run state lives in Postgres, and the
reaper re-enqueues what is outstanding.

```bash
# 1. Start several runs so jobs are in flight.
# 2. Take Redis away completely.
docker compose -f infra/docker-compose.yml stop redis
sleep 30
docker compose -f infra/docker-compose.yml start redis

# 3. Drive the reaper (or wait 60s for its own cadence).
curl -s -X POST "$API/admin/cron/workflow-watchdog" -H "X-Cron-Secret: $CRON_SECRET"
```

**Pass:** no run is stuck for ever. Runs whose jobs were lost are either
re-enqueued by the reaper's stuck-run sweep or marked `FAILED` visibly. Nothing
is silently re-executed.
**Fail:** a run left `RUNNING` for ever, or a side effect fired twice.

**Note on `--appendonly yes`:** the compose file enables AOF, so a restart
usually keeps the queue. To test the *worst* case — total loss — flush it first
(`docker exec vaep-redis-1 redis-cli flushall`). That is the case the stuck-run
sweep exists for, and it is the one worth actually drilling.

---

## Drill 3 — database connection loss

```bash
# 1. With runs in flight, take Postgres away.
docker compose -f infra/docker-compose.yml stop postgres
sleep 20
docker compose -f infra/docker-compose.yml start postgres
```

**Pass:** the API returns errors while the database is gone (it must not invent
success), recovers without a restart once the database is back, and
`GET /health` reflects reality throughout. Any attempt that was mid-flight is
reclaimed by the reaper as `outcomeUnknown` rather than retried.
**Fail:** the process wedges permanently, or a request that could not be
persisted is reported as succeeded.

---

## Recording a drill

Add the date, what you did, and the raw output under the drill — as in Drill 1.
A drill with no recorded output is indistinguishable from one nobody ran. If an
invariant broke, write that down too; the value of these is the failures they
find, and a runbook that only ever records passes is not being run honestly.
