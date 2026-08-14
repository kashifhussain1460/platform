# CTO Gap Closure — WAVE 5: Observability + Realtime (P1)

**Date:** 2026-08-12
**Authority:** `docs/implementation/workflow-system/orlixa-cto-master-gap-closure-plan(1).md` §WAVE 5
**Predecessors:** WAVE 0–4

---

## 1. What changed, in one sentence

The platform gained the three things you need at 2am — a correlation id that survives every async
hop, logs that are *queryable* rather than greppable, and metrics with alert thresholds — plus the
realtime run stream the outbox was built for and never got.

---

## 2. The gap

| §5 requirement | Before |
|---|---|
| execution context (12 identifiers) | none — no requestId, no traceId, nothing carried |
| structured logs | Nest's default prose: `[Nest] LOG [WorkflowEngine] workflow.run start run=abc` |
| metrics (16 named) | **none at all** — no registry, no endpoint, no dependency |
| alerts | none |
| realtime | `RunEventSink` existed as an interface with **no implementation**; the relay drained the outbox straight to nothing and the UI polled every second |
| outbox lag observable | no |

The logging gap is the sharpest one. "Logs searchable by workflowRunId" cannot be satisfied by prose
— the id sits inside a sentence, so finding every line for a run is a substring grep that also
matches ids embedded in other text, and correlating across services is impossible.

---

## 3. §5.1 — the execution context

`common/observability/execution-context.ts`: an `AsyncLocalStorage` carrying every identifier the
plan lists (requestId, traceId, companyId, userId, employeeId, workflowId, workflowVersionId,
workflowRunId, stepRunId, attemptId, skillExecutionId, externalRequestId, correlationId).

**Why ALS and not a threaded parameter.** Threading a context object through every signature is more
explicit, and it is also how correlation dies: it survives exactly as long as everyone remembers to
pass it, and the one place it gets dropped is the place you needed it. ALS follows async
continuations, so a log line five awaits deep inside a node handler still knows its run.

The trade is named in the file: ALS is implicit, and it does **not** cross a process boundary — a
BullMQ job starts with an empty store, which is why worker entry points must re-establish it from
the job payload rather than assume it survived.

Seeded by a **middleware, not an interceptor**: interceptors run after guards, so everything a guard
logs or audits — every authorization denial, exactly what you want correlated — would fall outside
the context.

`companyId`/`userId` are deliberately *not* set from headers. They are not known until the JWT guard
has run, and taking them from an unverified header would put attacker-controlled values into every
log line.

Inbound W3C `traceparent` is adopted so a customer's or a gateway's trace joins ours instead of
starting a second disconnected one. A malformed or all-zero id is rejected — a bad value is worse
than none, because it silently groups unrelated work.

---

## 4. §5.2 — structured logs

`LOG_FORMAT=json` switches to one JSON object per line with the ambient context spread in. Off by
default, so local development keeps the readable console output and this ships changing nothing.

Context fields are spread **last**, so a log call that happens to use the key `companyId` cannot
shadow the real one.

---

## 5. §5.3 — metrics

A hand-rolled registry (counters, gauges, histograms, Prometheus text exposition) at
`GET /admin/metrics`, with all 16 metric names from the plan centralised in one `METRIC` const.

**No `prom-client`, on purpose.** This process also runs on Vercel as a short-lived function, where
an in-process registry is nearly worthless (each invocation starts empty) and a library that spawns
default collectors and timers is actively unhelpful. Small and dependency-free is harmless in both
deployments, and swapping in a real client later is one file.

**Instrumented at `RunStateWriter`.** Every run and step transition already goes through that one
class by contract (WAVE 1 made it "THE only writer of run and step status"), so instrumenting it
covers the whole runtime without touching a single node handler. That earlier invariant paid for
itself here.

**Scrape-time collectors** for queue depth, outbox backlog and relay lag: these change on every
produce and consume, so instrumenting all of those would be invasive and would still drift — one
query per scrape is cheaper and always right. A collector that throws is swallowed, because a
metrics endpoint that 500s during an incident is exactly when you need it.

`audit_relay_lag` is the **age of the oldest unpublished row**, not a count. A count cannot tell a
busy system from a stuck one: a backlog of 100 that is 2 seconds old is healthy; a backlog of 3 that
is an hour old is an outage.

**The endpoint is gated** by the same shared secret as the cron routes, and disabled when no secret
is set. Metric names and label values describe the system's shape, its tenants' activity levels and
which providers it depends on — not a harmless thing to leave open on a public host.

---

## 6. §5.4 — alerts

The plan's rules expressed as data (`ALERT_RULES`) and evaluated at `GET /admin/alerts`.

Stated plainly in the code: **this is not a paging system** and does not replace Prometheus +
Alertmanager. It exists so an operator gets a straight answer during an incident without a
monitoring stack being wired up first, and so thresholds live next to the code emitting the metrics
instead of drifting apart in someone's dashboard.

---

## 7. §5.5 — realtime

`RunEventStreamService` finally implements the `RunEventSink` seam, and `GET /workflows/runs/:id/stream`
serves it over SSE, with `GET /workflows/runs/:id/events` as the catch-up read.

**SSE, not WebSockets.** Data flows one way; SSE is plain HTTP so it inherits the existing JWT guard,
tenant scoping, proxies and load balancers unchanged, and browsers reconnect on their own. A
WebSocket gateway would add a second authentication path and a second tenant-scoping path — two more
places for an isolation bug — to gain a channel back the execution view does not need.

Two correctness details:

- **Subscribe before replay.** The live subscription is created first and `concat`-ed after the
  history, so an event arriving *during* the replay is queued rather than dropped. Subscribing after
  the replay leaves a window where a step completes unseen — a bug the client cannot detect, because
  nothing tells it an event is missing.
- **`seq`-based resume.** `?after=` / `Last-Event-ID` means a dropped connection cannot silently
  lose a run's completion.

**Known limitation, stated in the file:** fan-out is in-process, so with several API instances a
client connected to instance A does not see events relayed by instance B *in real time*. Correctness
comes from the catch-up read; the stream is a latency optimisation on top of it. Making the live
path multi-instance needs Redis pub/sub.

---

## 8. WAVE 5 gate

| Gate item | Status | Evidence |
|---|---|---|
| Correlation chain works end-to-end | ⚠️ **partial** — see §9 | context survives awaits and nesting; request id echoed and adopted (e2e) |
| Logs searchable by workflowRunId | ✅ | `LOG_FORMAT=json` emits it as a field, not prose |
| Workflow/queue/provider metrics exist | ✅ | run/step/retry/duration instrumented; queue depth + outbox backlog as collectors |
| Critical alerts exist | ✅ | `ALERT_RULES` + `/admin/alerts` (not a pager — §6) |
| Realtime execution updates work | ✅ | `observability.e2e-spec.ts` — history replay then a live event, tenant-scoped |
| Outbox lag is observable | ✅ | `outbox_backlog` + `audit_relay_lag` (age, not count) |

### Test results (2026-08-12)

| Check | Result |
|---|---|
| `pnpm -w run typecheck` | **PASS** — 5/5 packages |
| Unit | **PASS — 487 tests, 58 suites** (was 473/57 after WAVE 4; +14) |
| `observability.e2e-spec.ts` | **PASS — 11 tests**, first run |

Full regression: §10.

---

## 9. Honestly NOT done in this wave

- **Correlation is plumbed, not fully populated.** The context exists and survives, and
  `RunStateWriter` enriches it with `workflowRunId`/`companyId`. But the JWT guard does not yet add
  `userId`/`companyId`, the BullMQ processors do not re-establish it from the job payload, and the
  skill executor does not set `skillExecutionId`/`externalRequestId`. So the chain is real
  end-to-end *within* an HTTP request, and breaks at the queue boundary. That is why the gate item
  is marked partial rather than green — and it is the same missing plumbing WAVE 3 and WAVE 4 both
  flagged.
- **Metrics are per-process and reset on restart.** Normal for Prometheus counters, but it means
  these answer "what is this worker doing", not "what has the platform done". Anything needing
  totals reads Postgres.
- **`llm_tokens_total` / `llm_cost_total` / `provider_latency_ms` / `oauth_refresh_failure_total` /
  `skill_failure_total` / `approval_wait_duration` are DEFINED but not yet emitted.** The names and
  the alert rules exist; the call sites in the LLM provider, skill executor and approval SLA sweep
  do not increment them. A metric that is defined and never emitted reads as "always zero", which is
  worse than absent — so this is the first thing to finish.
- **No traces.** §5.1 lists `traceId` and the gate mentions traces; a trace *id* is propagated, but
  there are no spans and no exporter. Real distributed tracing needs OpenTelemetry.
- **Realtime is single-instance** (§7).
- **No browser E2E.** Per WAVE 7's rule, none is claimed.

---

## 10. Full e2e regression

Run against the final WAVE 5 code:

```
Test Suites: 3 failed, 66 passed, 69 total
Tests:       6 failed, 422 passed, 428 total
```

**Zero regressions** — the same 6 tests in the same 3 pre-existing suites (`analytics` 3,
`auth-email-verification` 2, `e2e/engines-support` 1). WAVE 4's `auth-onboarding-hardening` flake
did not recur, consistent with it being order/timing dependent rather than a defect in the code
under test.

Programme-wide:

| Point | Suites | Tests passing | Pre-existing failures |
|---|---|---|---|
| WAVE 0 baseline | 66 | 388 | 6 (undiscovered at the time) |
| WAVE 1 | 66 | 390 | 6 |
| WAVE 2 | 67 | 402 | 6 |
| WAVE 3 | 67 | 402 | 6 |
| WAVE 4 | 68 | 411 | 6 |
| WAVE 5 | 69 | **422** | 6 |

Unit tests over the same span: 388 → **487**.

---

## WAVE 5 gate: **PASSED with the §9 exceptions recorded.** WAVE 6 (Existing Engine Refactor) may begin.
