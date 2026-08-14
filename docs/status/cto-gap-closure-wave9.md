# WAVE 9 — Production Readiness Gate

Verification record for `orlixa-cto-master-gap-closure-plan(1).md` WAVE 9.
Date: 2026-08-13.

A gate is only worth something if it can fail. Every item below was checked
against code or a test that was actually run; anything I could not evidence is
marked ❌ or ⚠️ rather than assumed from an earlier wave's status doc.

**Verdict: DO NOT PASS.** 38 of 50 met at first verification.

Four findings were blocking. Three are now resolved:

- **B3** (privilege + connector events unaudited) — **fixed**, Audit is 7/7
- **B4** (alerts reached nobody) — **fixed**, delivery + 5 tests
- **B2** (team isolation) — **de-scoped by decision**, recorded as NOT SUPPORTED
- **B1** (durable runtime off) — **still open**: decided as a one-company pilot,
  rehearsed for real locally, but blocked on an always-on worker host

**Revised: 40/49 in scope. B1 is the only thing between here and a pass**, and
it is now an ops/hosting task with a rehearsed plan rather than an open question.

---

## 🔴 Blocking findings

### B1 — The durable runtime is OFF. Production runs on the legacy walker.

The whole point of WAVE 1 was to move execution onto the durable state machine.
It was built, it works, and it is **not switched on**:

```ts
// modules/workflow-runtime/engine-mode.ts
this.globalMode = raw === 'state_machine' ? 'state_machine' : 'legacy_walk';
...
if (isInlineExecution()) return 'legacy_walk';
if (this.optedIn.has(companyId)) return 'state_machine';
return this.globalMode;
```

- `WORKFLOW_ENGINE_MODE` is **not set** in `.env` or `.env.example` → default
  `legacy_walk`.
- `WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES` is **not set** → nobody opted in.
- On the Vercel deployment (`WORKFLOW_EXECUTION_MODE=inline`, gap G40) the
  durable runtime is **refused by construction** — inline always returns
  `legacy_walk`, because an advance job would be enqueued with no worker to
  consume it.

So today: **no run anywhere uses the durable runtime.** Durable attempts,
durable leases, lease-based recovery and the reaper are all real, tested code
that no production run reaches. This is the same "wired but never driven"
pattern found repeatedly in earlier waves — this time at the top of the gate.

The gate item "All production workflow runs use durable runtime" is ❌, and
"Durable attempts", "Durable leases" and "Recovery" are ⚠️ **capability proven,
not in force**.

**Decision taken (2026-08-13): pilot one company first**, not a global flip.
Plan + rehearsal: `docs/ops/durable-engine-rollout.md`.

The rollout was **rehearsed for real** rather than only written down — local
stack, workers enabled, exactly one company opted in:

- opted-in company → `WorkflowStepAttempt` rows written ⇒ **durable engine ran it**
- control company on the same server, same moment → **0 attempt rows** ⇒ still
  the old engine ⇒ **the pilot is contained**
- approved and resumed → run `COMPLETED`, side-effecting AI step ran **exactly
  once** (the APPROVAL node shows 2 attempts because a durable gate is
  re-entrant: park, then resume)

**Still ❌ for the gate**, and deliberately so: the rehearsal was local. Nothing
is opted in on any deployed environment, and the durable engine needs an
always-on worker, which the current Vercel-only hosting does not provide. Until
that exists, execution must not be described to a customer as durable,
self-healing or auto-recovering.

### B2 — Team isolation does not exist → **DE-SCOPED (decision taken)**

Precisely what is and is not there, because the first draft of this finding was
too broad:

- **Exists:** a per-workflow `WorkflowPermission` grant whose subject is a TEAM.
  Grant RUN to team `t1` and only members of `t1` (plus OWNER/ADMIN) can run
  that workflow. Real, and now tested — that branch had **no test at all**
  before this wave; three were added, including "a user with no team must not
  match a team grant", which would otherwise be a silent grant-to-everyone.
- **Does not exist:** team-level *isolation* — the department-style default
  where one team cannot see another team's resources. `authorization.policy.ts`
  resolves tenant → user status → role floor → OWNER → department → scope name
  and has **no team dimension at all**.

**Decision: de-scoped, and recorded as NOT SUPPORTED.** Department isolation
covers the need today and is proven in a real browser; no customer has asked for
team-level walls. A half-built permission layer is more dangerous than an absent
one, because people trust it and it leaks quietly.

**If anyone asks "can we wall teams off from each other?", the answer is no** —
you can grant a specific workflow to a specific team, and that is all. Build it
properly when a customer actually needs it.

### B3 — Permission changes and connector lifecycle are not audited

Two of the seven Audit items are simply absent:

- `modules/workflow-permissions/` contains **no audit call**. Granting or
  revoking who may run a workflow — a privilege change — leaves no trace.
- No connector connect / disconnect / OAuth-refresh / `markDisconnected` event
  is audited either.

Both are exactly the class of act an audit trail exists to record: quiet,
privileged, and disputed later.

### B4 — Alert rules fire into the void

`GET /admin/alerts` evaluates real rules and returns what is firing. **Nothing
polls it.** There is no cron entry in `vercel.json`, no call in
`cron.controller.ts`, and no delivery channel. That is monitoring, not alerting:
an alert nobody receives is a log line with ambition.

---

## Execution — 6/10

| Item | Verdict | Evidence |
| --- | --- | --- |
| All production runs use durable runtime | ❌ | **B1** — default `legacy_walk`, nobody opted in, inline refuses it |
| Immutable version pinning | ✅ | `workflowVersionId` pinned at enqueue; versions frozen `PUBLISHED` |
| Durable attempts | ⚠️ | `WorkflowStepAttempt` + tests exist; no production run reaches them (B1) |
| Durable leases | ⚠️ | `attempt-lease.service.ts` (SQL `leaseOwner`/`leaseExpiresAt`); same caveat |
| Retry | ✅ | `retry-policy.service.ts` + classifier tests |
| Timeout | ✅ | `DEFAULT_NODE_TIMEOUT_MS`, `failureClass: 'TIMEOUT'` |
| Recovery | ⚠️ | Reaper: 4 sweeps, tested; only acts on state-machine runs (B1) |
| Idempotency | ✅ | Run `idempotencyKey` + webhook dedup; chaos-tested |
| No duplicate side effects | ✅ | Expired lease → `outcomeUnknown`, never auto-retried (chaos suite) |
| Approval survives restart | ✅ | Chaos test + **real process-kill drill**, exactly one execution |

## Authorization — 6/8

| Item | Verdict | Evidence |
| --- | --- | --- |
| Tenant isolation | ✅ | `tenant-isolation.e2e-spec.ts`; chaos suite asserts sweeps don't cross tenants |
| Department isolation | ✅ | `authorization-scope.e2e-spec.ts` + verified in a real browser (WAVE 7) |
| Team isolation | ⛔ **de-scoped** | **B2** — no team dimension in the policy. Per-workflow TEAM grants work and are now tested. Recorded as NOT SUPPORTED by decision |
| Employee scope | ✅ | "scopes the AI Employee roster by the employee's role" |
| Workflow scope | ✅ | `workflow-permissions.e2e-spec.ts`; RUN authorised at enqueue |
| Knowledge scope | ✅ | `knowledge-role-scoping.e2e-spec.ts` |
| Skill scope | ✅ | Per-employee connections + role-scope guardrail |
| Approval scope | ✅ | `canDecide` + `approval-routing.e2e-spec.ts` |

## Events — 7/7 (with one caveat)

Signature verification, RawEvent, dedup, CanonicalEvent, tenant resolution,
workflow trigger and durable run are all covered by `event-ingestion.e2e-spec.ts`
— including the sharp one: *"a replay of the signed body with a MUTATED delivery
header is still deduped"*.

⚠️ "Durable run" here means a run is created and executed; on the legacy walker
per B1.

## Audit — 5/7

| Item | Verdict | Evidence |
| --- | --- | --- |
| Critical actions audited | ✅ | 40+ actions: auth, users, roles, security policy, knowledge, HR, billing, workflows |
| Approval audited | ✅ | `approval.approved` / `approval.rejected` / `escalated` / `expired` |
| Permission changes audited | ❌ | **B3** — no audit in `workflow-permissions` |
| Connector lifecycle audited | ❌ | **B3** |
| Execution audited | ⚠️ | `WorkflowRun`/`StepRun`/`Attempt` are the record; only `workflow.run.cancel` reaches AuditLog. Defensible, but state it rather than claim full coverage |
| Audit chain validated | ✅ | `GET /audit-log/verify` → **run live this session: `{"checked":16,"valid":true}`** |
| Retention enforced | ✅ | WAVE 8, 10/10 tests |

## Observability — 6/9

| Item | Verdict | Evidence |
| --- | --- | --- |
| Structured logs | ✅ | `structured-logger.ts` + AsyncLocalStorage execution context |
| Metrics | ✅ | 13 metrics via hand-rolled Prometheus registry at `/admin/metrics` |
| Traces | ❌ | **No OpenTelemetry anywhere** (`grep -rln opentelemetry src` → empty) |
| Alerts | ❌ | **B4** — rules evaluate, nothing polls or delivers |
| Queue monitoring | ✅ | `queue_depth`, `queue_backlog`, `queue_lag` |
| Provider monitoring | ✅ | `provider_latency_ms` + connector health |
| OAuth monitoring | ✅ | `oauth_refresh_failure_total` |
| Outbox monitoring | ✅ | `outbox_backlog` |
| Realtime execution updates | ⚠️ | SSE + Redis fan-out shipped (`@Sse(':id/stream')`); the WS gateway (P5-01) is still deferred and the UI polls at 1s |

## E2E — 5/7

| Item | Verdict | Evidence |
| --- | --- | --- |
| Browser golden journey | ✅ | Driven end to end via Playwright MCP in WAVE 7: signup → onboarding → build → publish → run → approval → resume → audit |
| API golden journey | ✅ | `journey-hr-e2e.e2e-spec.ts` |
| Approval journey | ✅ | `approval-routing` + `approval-sla` suites |
| Failure journey | ✅ | Chaos suite + recorded process-kill drill |
| Permission journey | ✅ | `authorization-scope` + `workflow-permissions` |
| Engine journeys | ✅ | HR, Marketing, PM, Support engine suites |
| Regression suite | ⚠️ | API: **73 suites / 464 tests green**, in CI. Browser: `02-security-journey.spec.ts` exists but has **never been executed by the Playwright runner** — its assertions were verified by hand through MCP. Not the same claim, and CI does not run it |

## Operations — 6/10

| Item | Verdict | Evidence |
| --- | --- | --- |
| Backup | ✅ | `infra/backup/backup.sh` |
| Restore | ✅ | Proven: 14 tables matched exactly, 664 objects |
| RPO | ✅ | 24h documented; 5min needs PITR (**not enabled**) |
| RTO | ✅ | 1h, from a measured 4s restore |
| Retention | ✅ | WAVE 8 |
| Legal hold | ✅ | WAVE 8, scoped |
| Production secrets | ❌ | No secret manager, no rotation runbook. `ENCRYPTION_KEY` loss = total data loss and is documented only in the DR doc |
| Worker deployment | ⚠️ | `QUEUE_WORKERS_ENABLED` gate exists and is documented in CLAUDE.md; no deployment manifest, and B1 means no worker is running the durable engine |
| Monitoring | ⚠️ | Endpoints exist; nothing scrapes them (no Prometheus/APM configured) |
| Alerting | ❌ | **B4** |

---

## What must happen before this gate can pass

1. **Turn the durable runtime on** (B1). Decided: one-company pilot. The plan
   and a real rehearsal are in `docs/ops/durable-engine-rollout.md`; what
   remains is an always-on worker host (not Vercel) and setting the variables
   there. Until then, execution is not durable in any deployed environment.
2. ~~Implement team isolation~~ — **decided: de-scoped**, recorded as not
   supported (B2). No longer blocking.
3. **Audit permission changes and connector lifecycle** (B3) — small, and both
   are privilege/trust events.
4. **Deliver alerts somewhere** (B4): poll `/admin/alerts` on a cron and route
   firing rules to a real channel.

Non-blocking but open, carried from WAVE 8 and earlier: OpenTelemetry traces,
production secret manager, PITR, the LLM-timeout chaos test, the WS realtime
gateway, and running `02-security-journey.spec.ts` in CI.

---

## Addendum — B3 and B4 closed (same day)

Both were small, unambiguous and needed no product decision, so they were fixed
rather than merely filed.

### B3 — privilege and connector events are now audited

| New action | Written by |
| --- | --- |
| `workflow.permission.granted` | `WorkflowPermissionService.grant` |
| `workflow.permission.revoked` | `WorkflowPermissionService.revoke` |
| `connector.connected` | `SkillsService.connectSkill` |
| `connector.disconnected` | `SkillsService.disconnectSkill` |

Two details worth keeping:

- **Revoke reads the row before deleting it.** `deleteMany` destroys the only
  record of *what* was revoked; an entry saying "a grant was revoked" without
  naming the subject and action answers nothing.
- **Connector metadata never contains credentials** — it records that a
  connection happened and to which skill, not what authenticates it.

Audit item "Permission changes audited" and "Connector lifecycle audited" move
❌ → ✅. **Audit is now 7/7.**

### B4 — alerts are delivered

New `AlertDispatchService` + `/admin/cron/alerts` (every 15 min in
`vercel.json`). `GET /admin/alerts` now shares the same evaluation, so the view
and the notifier can never disagree about what is firing.

Delivery goes to `ALERT_WEBHOOK_URL` (any JSON-accepting incoming webhook). The
design point is the failure path: the sweep returns `delivered:false` **with a
reason** when the URL is unset, when the receiver answers non-2xx, or when the
request throws — and logs `ALERTS ARE FIRING AND NOBODY IS BEING NOTIFIED` at
error level. A cron that returns a cheerful 200 while nobody is paged is the
exact failure this was meant to fix.

Covered by `alert-dispatch.service.spec.ts` (5 tests, all four failure paths).

Observability item "Alerts" moves ❌ → ✅ **with one caveat**: there is no
flap/cooldown suppression, so a rule that stays above threshold re-notifies
every 15 minutes. Deliberate — under-notifying is the worse failure — but it
should get a cooldown before the alert volume trains anyone to ignore it.

**Revised score: 40/50**, plus B2 de-scoped by decision (so 40/49 in scope).

Remaining blocker: **B1** only — and it is now a hosting/ops task with a
rehearsed plan, not an unknown. B2 is recorded as NOT SUPPORTED.

---

## Addendum 2 — turning the durable engine on exposed a safety bypass (2026-08-13)

`engine-mode.ts` was flipped so the durable engine is the DEFAULT and
`legacy_walk` is the opt-out. Running the full e2e suite against that default —
which had not been done — failed **13 tests**. Six were an unrelated environment
bug (below). The other seven were durable-engine gaps, and the first one is
serious.

### 🔴 High-risk TOOL_ACTION was not gated at all on the durable path

`ApprovalGateService.evaluate` only handled `APPROVAL` nodes. The legacy walk's
equivalent check lives in its run loop (`pauseIfToolNeedsApproval`) and had **no
durable counterpart**, so with the durable engine active
`stripe.create_payment_link` and `postiz.publish_now` executed with no human
approval. That is precisely the G25 bypass — reintroduced by the *second engine*
rather than by any change to the first, which is the failure mode a dual-engine
architecture makes easy and §19 warns about.

Fixed in `ApprovalGateService.evaluateToolAction`:

- It lives in the **gate**, not the handler. A handler cannot pause a run, and
  moving the check there would recreate the bypass — the same reasoning already
  written on `tool-action.handler.ts`.
- It uses the shared pure `toolRequiresApproval` policy, so chat, legacy walk and
  durable runtime cannot drift apart again.
- The rows it writes are **byte-compatible** with the legacy walk's (same
  `kind:'WORKFLOW'`, `skillKey`/`tool`, `[node:<id>]` marker). A run paused by
  one engine and approved while the flag flips still resumes under the other —
  an approval is exactly the long-lived state that will straddle a rollout.

### The other four

| Gap | Consequence |
| --- | --- |
| A **disabled node was executed**, not skipped | A deactivated "email the candidate" step really sent the email. Now writes a real `SKIPPED` row (a silent hop makes the timeline gap read as a bug) and routes down the first outgoing edge |
| Two tests assumed `execute()` runs inline | Not a product bug: on the durable engine it only ENQUEUES. Tests now wait for a terminal status, which is what every real client does |
| A test asserting the OLD default | Inverted rather than deleted — "which engine runs by default" must never change silently. It still honours an explicit `legacy_walk` override so the rollback path stays exercisable |

### The six that were not the engine

`CronController`/`MetricsController` compare against `config.get('CRON_SECRET')`,
and ConfigService **snapshots the environment when `config.module.ts` is
imported**. Two suites set `process.env.CRON_SECRET` in their own `beforeAll` —
far too late — so on any machine whose `.env` carries one, ConfigService held the
developer's value and the request carried the test's: six 403s with nothing to do
with the behaviour under test. Green in CI, red locally; the exact "known flaky"
shape §2 of the follow-up pass was written about. Pinned in
`test/setup-e2e-env.ts`, which exists for this class of bug.

### Verification

Both engines, full suite, after the fixes:

| Mode | Result |
| --- | --- |
| default (`state_machine`) | **465 passed, 73 suites, 0 failed** |
| `WORKFLOW_ENGINE_MODE=legacy_walk` | **465 passed, 73 suites, 0 failed** |
| Unit | 519 passed, 60 suites |
| `pnpm -w run typecheck` | PASS, 5/5 |

**This is the first time the suite has been green in both modes.** Running only
one mode is how all five gaps hid: every one of them passed under `legacy_walk`.
Treat a two-mode run as mandatory for any workflow-engine change while both
engines exist.

### What this changes about B1

B1 still needs an always-on worker host — that part is unchanged. What changed is
the claim underneath it. This document previously said the durable runtime was
"real, tested code" that merely needed switching on. It was not fully tested: it
had been switched on by default and **no one had run the suite against it**. Had
that shipped, high-risk actions would have executed without approval.

### Also closed this session

- **LLM-timeout chaos test** (WAVE 8 §8.1's one uncovered scenario). Writing it
  found that the node timeout **abandoned** a hung model call rather than
  cancelling it: the request kept running against the provider's own longer
  timeout, spending tokens on an answer nobody would read, and writing no usage
  row because the code that would have was already unwound. `withTimeout` now
  aborts, and the signal is threaded to the AI_STEP / AI_EMPLOYEE_STEP paths.
  Proven by removing the fix and watching the test fail.
- **Alert cooldown** (the caveat left open in Addendum 1). Per-rule and
  per-severity, so an escalation warning → critical pages immediately. A **failed
  delivery does not start the window** — otherwise a webhook outage silences the
  alert about it. Suppressed rules are named in the response rather than dropped.
- **Observability, both ❌ items** (see Addendum 3).
- **First `@RequirePermission` adoption** — a deliberately safe slice (audit,
  organization, employees, skills; 9 controllers) where the capability's floor is
  already identical to the `@Roles` it replaces, so no answer changes. The rest is
  **not** a mechanical swap: `MIN_ROLE` floors `workflow:update|publish|delete`
  and `knowledge:manage` at MEMBER while those routes require OWNER/ADMIN, so a
  blind migration would be a privilege escalation. Recorded rather than done.

---

## Addendum 3 — Traces, monitoring and browser E2E (2026-08-13)

Three gate items moved, and all three were blocked on infrastructure rather than
on anything hard.

### Traces ❌ → ✅

`@opentelemetry/sdk-node` + auto-instrumentations + an OTLP/HTTP exporter, in
`common/observability/tracing.ts`. Two decisions worth keeping:

- **Imported first in `main.ts`, and not a Nest provider.** Auto-instrumentation
  patches modules as they are required; a provider is constructed long after
  `http`, `pg` and `ioredis` have loaded, so there would be nothing left to
  patch. The failure would be silent — traces appear, with the interesting spans
  missing.
- **Inert without `OTEL_EXPORTER_OTLP_ENDPOINT`.** An exporter pointed at nothing
  retries for the life of the process, and "observability made it slower" is how
  observability gets switched off permanently.

**The bridge was the part that was nearly wrong.** `ExecutionContextMiddleware`
built its own `traceId`, so logs carried a UUID while spans carried a 32-hex OTel
id: two correlation ids for one request, neither able to find the other, and
everything *looking* correlated because the logs agreed with each other. The unit
tests passed. Only running it caught it. `activeTraceId()` now sits third in the
middleware's priority — after an inbound `traceparent` and an explicit
`x-trace-id`, both of which represent a chain that began elsewhere.

Verified end to end rather than asserted: a `traceId` taken from a JSON log line
was fetched from Jaeger by id and returned an 11-span trace.

### Monitoring ⚠️ → ✅

`infra/docker-compose.yml` gains Jaeger, Prometheus and Grafana behind a
`--profile observability`, so nobody running the app pays for a metrics stack
they did not ask for. Prometheus scrapes `/admin/metrics` with the operator
secret as a bearer token (the endpoint is not public — series names and label
values describe the system's shape and its tenants' activity).

Proven with a matching secret: target **UP**, 13 app series flowing, including
the per-queue `queue_depth_wf_node_attempt` / `queue_depth_wf_run_advance` /
`queue_depth_workflow_run`, `outbox_backlog` and `audit_relay_lag`. The committed
config carries a placeholder credential, so out of the box the target reports 403
— honest about being unauthorised rather than silently empty.

### Regression suite ⚠️ → ✅

`.github/workflows/browser-e2e.yml` runs the Playwright journeys against a real
stack, and uploads the report (and traces/screenshots on failure) as artifacts —
the "record evidence" half of this wave.

Running `02-security-journey.spec.ts` through the real runner for the first time
found two things that hand-verification could not:

1. **`pnpm exec playwright test` resolves to the workspace ROOT**, not the
   invoking directory. With no `package.json` in `e2e/` it found no config, fell
   back to scanning the whole repo, and died on `apps/web`'s vitest files. `-c`
   does not save it — that path resolves from the root too. `e2e/` is now a
   workspace package (`@vaep/e2e`).
2. **The suite rate-limited itself.** `/auth/*` allows 10 requests/minute per IP;
   the journeys sign up and log in a dozen times a minute from one address, so
   the seventh failed with a 429 that had nothing to do with what it asserted. A
   hard-coded limit was therefore a ceiling on how much of the product a browser
   test could ever cover. `AUTH_THROTTLE_LIMIT` now exists for harnesses; the
   production default is unchanged at 10 and no browser test asserts throttling.

**7/7 journeys pass** through the runner, including the one that had never been
executed.

### api-ci now runs e2e in BOTH engine modes

A matrix over `WORKFLOW_ENGINE_MODE`. One extra job, and it is the thing that
would have caught every gap in Addendum 2 — all five passed under `legacy_walk`.

### Verification

| Check | Result |
| --- | --- |
| `pnpm -w run typecheck` | PASS, 5/5 |
| `pnpm --filter @vaep/api run lint` | 0 errors (3 pre-existing unused-import errors fixed on the way) |
| Unit | 523 passed, 61 suites |
| e2e — durable (default) | 465 passed, 73 suites |
| e2e — `legacy_walk` | 465 passed, 73 suites |
| Browser (Playwright runner) | 7 passed |
