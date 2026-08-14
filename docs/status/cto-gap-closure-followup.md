# CTO Gap Closure — Follow-up Pass: closing the "NOT done" items

**Date:** 2026-08-12
**Scope:** every item recorded as *not done* or *partial* in the WAVE 1–5 status docs
**Predecessors:** `cto-gap-closure-baseline.md`, `-wave1` … `-wave5`

---

## 1. Headline

**The e2e suite is green for the first time in this programme: 428 passed, 69 suites, 0 failed.**
It had carried 6 failures since before WAVE 1, and every wave document had to caveat its result
around them. They are fixed — and neither was what the docs assumed.

The keystone item is also closed: correlation now survives the queue hop, which was blocking
WAVE 3, WAVE 4 and WAVE 5 items simultaneously.

---

## 2. The six "pre-existing failures" — what they actually were

Every wave doc recorded these as unexplained and unrelated. Both root causes turned out to be
worth knowing.

### `auth-email-verification` (2 tests) — production mail config leaking into tests

`apps/api/.env` carries `MAIL_ENABLED=true` with **live Hostinger SMTP credentials**. With the file
value in force, `MailService.generateOtp()` returns a cryptographically random code instead of the
fixed dev `123456`, so the test's hard-coded code was always wrong.

The second-order problem is the serious one: **the e2e suite could deliver real email to the
addresses tests invent.** `test/setup-e2e-env.ts` already existed to neutralise real OAuth
credentials for exactly this class of bug; mail simply had not been added to it. It now forces
`MAIL_ENABLED=false` and blanks `SMTP_PASS`.

### `analytics` (3) + `e2e/engines-support` (1) — tests asserting behaviour the platform deliberately removed

Both expected an autonomous chat turn to execute an external tool and write a `SkillExecution` row.
It doesn't, and shouldn't: `slack:send_message` and `chatwoot:reply_to_conversation` are in
`EXTERNAL_ACTION_TOOLS` (`tool-approval-policy.ts`), so the agent loop opens an `ApprovalRequest`
instead — untrusted content (a pasted CV, a customer message) must not be able to drive an
unapproved external send.

The database told the story immediately: 0 `SkillExecution` rows and **2 `ApprovalRequest` rows**.
Nothing was broken; the tests predated the gate.

Fixed by making the tests approve the gate, which runs the tool for real — so they now cover *both*
the gate and the execution, rather than asserting the pre-gate world.

**Worth stating plainly:** these were red for months and were repeatedly (including by me, in five
consecutive wave documents) classified as "pre-existing, unrelated". Two of them were a
production-config leak with real-email blast radius, and the other four were the suite telling the
truth about a security control nobody had reconciled. "Known failing" is where real signal goes to
die.

---

## 3. Correlation — the keystone (WAVE 3 §8, WAVE 4 §7, WAVE 5 §9)

Three waves each deferred the same missing plumbing. All of it is now in place:

| Hop | Before | Now |
|---|---|---|
| HTTP → services | requestId/traceId only | `JwtStrategy.validate` enriches the context with the **verified** `userId`/`companyId` |
| HTTP → audit | `ip`/`userAgent`/`correlationId` columns existed, nothing populated them | the middleware records ip + user-agent; `AuditLogService.record` auto-fills every correlation field from the ambient context |
| API → worker | **broken** — a BullMQ job starts with an empty `AsyncLocalStorage` store | `runInJobContext(job, …)` re-establishes it from the job payload, applied to **all 10 processors** |
| tool call → provider | nothing | `SkillsService.runTool` enriches with `skillExecutionId` after writing the row |

The audit auto-fill is the highest-leverage part: all 35+ existing `record(...)` call sites gained
ip, user-agent, correlation and run linkage **without being edited**. An audit trail whose
enrichment depends on every author remembering to pass a field is an audit trail that is enriched
almost nowhere.

---

## 4. Metrics that were defined but never emitted (WAVE 5 §9)

WAVE 5 flagged this as "the first thing to finish" — a metric that is defined and always reads zero
is worse than an absent one, because it looks like a healthy signal. All six now emit:

| Metric | Emitted at | Why there |
|---|---|---|
| `provider_latency_ms` | `SkillsService.runTool` | the one choke point every tool call passes through — covers mock, real and every future executor |
| `skill_failure_total` | same | |
| `llm_tokens_total` / `llm_cost_total` | `UsageService.record` | emitted **before** the DB write and outside its try: the row is for billing (must be exact), the metric is for watching spend (must simply exist) — they should not fail together |
| `oauth_refresh_failure_total` | `ConnectorTokenService` | labelled `revoked` separately: a revoked grant needs a human, a transient failure resolves itself |
| `approval_wait_duration` | `ApprovalService.claim` | the one metric here that measures **people**, and the one that explains a "slow" automation: a 4-hour p95 approval wait is not a platform performance problem, and without it looks exactly like one |

---

## 5. Other closed items

- **WAVE 1 §8 — `resumeRun`/`cancelRun` bypassing `RunStateWriter`.** Both now go through the
  guarded, outbox-emitting path, so a resumed run emits `run.resumed` and the WAVE 5 realtime
  stream no longer shows it frozen at WAITING. Required forking `RunStateWriter` into a leaf
  `RunStateModule` — the third time this programme has needed that pattern (after `EngineModeModule`
  and `CanonicalIngestModule`), because `WorkflowRuntimeModule` imports `WorkflowsModule`.
- **WAVE 2 §7 — Knowledge department scoping.** `KnowledgeDocument.category` already carried the
  right axis, so this was adoption of the existing layer: delete is now scoped and audited.
- **WAVE 4 §7 — audit coverage.** Added `auth.login`, `auth.logout`, **`auth.login_failed`**, and
  knowledge upload/delete. The failed-login event is the important one: a burst against one account
  is what credential stuffing looks like, and it is invisible if only successes are recorded.
- **WAVE 4 §7 — archive tier.** Retention now archives to the configured `StorageProvider` as
  verifiable NDJSON (hashes included) **before** deleting, so the retention window bounds what is
  *online*, not what exists. Archiving is required, not best-effort: if the write fails, the
  deletion is skipped and retried — deleting evidence because storage blipped is not an acceptable
  failure mode.

### Two wave-doc claims that were simply wrong

Verified against the code rather than trusted:

- **WAVE 2 §7 "Encryption-key validation — `CryptoService` only warns."** It does not. It has
  thrown on a missing `ENCRYPTION_KEY` under `NODE_ENV=production` since before this programme.
- **WAVE 3 §8 "Chatwoot signature replay window — none."** There is one:
  `SIGNATURE_MAX_AGE_MS = 5 minutes`, enforced in `verifyWebhookSignature`. The residual gap is on
  the *generic connector* driver, which binds no timestamp — though its body-hash dedup already
  makes an identical replay a no-op.

---

## 6. A performance bug I introduced and fixed

The first cut of the archive tier loaded **every expiring row for every company** in one query, and
the sweep iterated **all** companies doing three queries each regardless of whether they had
anything to delete. On the dev database (3,665 companies from accumulated test runs) that stalled
the suite for 25+ minutes and looked like a hang.

Both are real production defects, not test-only ones — a tenant with a year of audit is millions of
rows. Fixed by (a) one `groupBy` to find companies that actually have expirable entries, and
(b) archiving/deleting in 1,000-row batches so memory is bounded and an interrupted sweep keeps its
progress.

Caught only because the suite got slow. Worth noting as the failure mode: a nightly job that is
merely *inefficient* shows no error anywhere.

---

## 7. Verification

| Check | Result |
|---|---|
| `pnpm -w run typecheck` | **PASS** — 5/5 packages |
| Unit | **PASS — 487 tests, 58 suites** |
| Full e2e | **PASS — 428 tests, 69 suites, 0 failed** |

Suite runtime also dropped from ~9 minutes to **3 minutes**, mostly from the retention-sweep fix.

| Point | Suites | Passing | Failing |
|---|---|---|---|
| WAVE 0 baseline | 66 | 388 | 6 |
| WAVE 5 | 69 | 422 | 6 |
| **This pass** | **69** | **428** | **0** |

---

## 8. Second pass — control flow and HR scoping (2026-08-12, later)

Continuing through §9's list, in order.

### W1 — PARALLEL / LOOP durable coverage: **closed, and it found three real bugs**

The wave doc called this "wired and unblocked but not yet covered". Covering it showed that
*wired* and *working* were again different things. `workflow-durable-parallel-loop.e2e-spec.ts`
(6 tests) now pins all of it:

1. **A JOIN always reported `arrived: 0`.** The legacy walk sets `context.__lanes = laneOutputs`
   before handing control to the JOIN; the durable path never did. Fan-out worked and fan-**in**
   silently lost every lane's result. Now collected in the advance worker, via the atomic jsonb
   merge so two lanes arriving together cannot erase each other.

2. **A LOOP ran exactly ONE iteration.** `startIteration` dispatched the first pass and nothing ever
   advanced the cursor — `readLoopCursor` existed with **no caller at all**. A 3-item loop executed
   its body once and silently skipped the rest, which is the worst shape of bug: it looks like it
   worked. A completed body now advances its own loop, and the loop jumps to its `done` target
   rather than re-entering itself.

3. **A concurrent advance was DROPPED.** `withRunLock` returning `LOCK_NOT_ACQUIRED` caused the
   processor to return, on the reasoning that "another worker is advancing this run and will enqueue
   what comes next". True for a linear run; **false for fan-in** — two lanes finishing together
   produce two advances carrying *different* `fromNodeId`s, and the loser's lane arrival was never
   recorded, so `arrived` stalled one short of `expected` and the JOIN waited for ever. Now
   re-enqueued with a short delay: an advance is cheap and idempotent, so retrying is always safe
   and dropping it never is.

A fourth bug fell out of the same test, in **both** engines: `SET_VARIABLE` documents that it binds
under the variable's own name, and neither engine did — both bound `contextValue` only when the
author had *also* set an unrelated `outputKey`, so a RUNTIME variable was silently discarded and the
next node saw nothing. `NodeResult.contextKey` makes the documented contract real.

### W2 — HR department scoping: **closed**

`StaffMember` carries a real `departmentId`, so scope-name matching was the wrong tool. The policy
gained a **direct department-ownership rule** (5a): when a resource names its own department and the
actor is placed in a different one, deny. Stronger than scope names — it needs no configuration to
be meaningful — and still inert for an unplaced actor, preserving the ships-inert property.

Adopted on `StaffService.list`/`get`, list filtered by the same rule as the detail read.

### W5 — multi-instance realtime: **closed**

`RunEventStreamService` now publishes every run event to one Redis channel
(`orlixa:run-events`) and subscribes to it, so a client connected to instance A sees events relayed
by instance B. Messages carry the publishing instance's id and each instance ignores its own echo —
exact, where leaning on the stream's `seq` de-duplication would only work by accident.

Two things this exposed, both worth keeping:

- **The subscribe must not be awaited in `onModuleInit`.** The resilience Redis client is configured
  to fail fast rather than queue while disconnected, so awaiting a SUBSCRIBE against an unreachable
  Redis hung application boot — the API would not come up because a *realtime optimisation* could not
  reach its broker. Now fire-and-forget with a logged failure.
- **Local delivery must be unconditional.** The first cut delivered locally only when the Redis
  publish *failed*. That reads as symmetrical and is a trap: if SUBSCRIBE had quietly failed while
  PUBLISH still succeeded, the event went to a channel nobody was listening on *and* the local
  fallback was skipped — delivered nowhere, with no error. Local delivery now happens first and
  always; the publish is purely additive, and its failure costs cross-instance latency rather than a
  locally-connected subscriber.

### W3 — Postiz consent/suppression: **closed** (reconciliation was already there)

Two halves, and only one was actually missing.

**Reconciliation already existed.** `MarketingSyncService` sweeps SCHEDULED posts against Postiz and
resolves them to PUBLISHED or FAILED, driven by both the BullMQ repeatable and the Vercel cron
route. The WAVE 3 doc listed it as outstanding; checking the code first was cheaper than rebuilding
it.

**Consent and suppression did not exist at all** — no model, no list, no check anywhere. Nothing
stopped an AI Employee emailing someone who had unsubscribed. Built:

- `MarketingSuppression` — the operational answer to "may we send here right now?", unique per
  `(company, channel, address)` and normalised so `Alice@Example.COM` cannot slip past a list
  holding `alice@example.com`. A list that misses on casing reports a protection it does not
  provide.
- `MarketingConsent` — append-only EVIDENCE. Kept separate from suppression because the two answer
  different questions and diverge in both directions: a bounce suppresses an address that never gave
  consent, and a withdrawal must *create* a suppression rather than delete an old record. In a
  dispute the question is never "is the flag true" but "what did they agree to, when, and how do you
  know" — which a boolean cannot answer.

**Enforced at `SkillsService.runTool`**, the one choke point every tool call passes through, so it
covers the chat loop, workflow TOOL_ACTION nodes, templates and any executor added later. A rule
enforced inside one executor is a rule the next executor forgets.

Three decisions worth recording:

- **Hard block, not a warning.** Once the message is sent, "review it later" has no meaning — that
  single send *is* the breach.
- **Recipients are extracted from DECLARED argument keys, never by scanning args for anything
  email-shaped.** The heuristic would block a legitimate send whose *body* quotes a suppressed
  customer's address, and would still miss a recipient in a field it did not anticipate.
- **The check fails OPEN on an infrastructure error**, logged at error level. Blocking every
  outbound message platform-wide because one table was briefly unreadable turns a database blip into
  a total communications outage. It is the one place here that prefers availability, and it is
  stated rather than hidden.

Re-consenting lifts a `CONSENT_WITHDRAWN` suppression and **only** that: a bounce is a
deliverability fact, not a permission one, and clearing it would mail a dead address and damage the
sending domain.

### Verification after this pass

| Check | Result |
|---|---|
| `pnpm -w run typecheck` | **PASS** — 5/5 |
| Unit | **PASS — 494 tests, 59 suites** |
| Full e2e | **PASS — 445 tests, 71 suites, 0 failed** |

---

## 9. Still NOT done — and why

These remain open. Each is either genuinely blocked, a whole feature, or an infrastructure decision
that is not mine to make unilaterally.

**Needs an external dependency or decision:**
- **Production secret manager** (W2). Secrets are env vars encrypted at rest. Choosing Vault vs AWS
  Secrets Manager vs Doppler is a platform decision with cost and ops implications.
- **External audit anchor** (W4). The chain is self-anchored, so an attacker who can run our code
  could rewrite a suffix and re-chain it. Defeating that needs a digest published somewhere we do
  not control.
- **OpenTelemetry traces** (W5). A trace *id* propagates; spans and an exporter need a collector.
- **MFA** (W2). A whole feature. WAVE 2 made the platform honest about its absence by rejecting
  `mfaRequired: true`; that remains the correct interim state.
- **Plane outbound provisioning** (W3). Still throws `NOT YET IMPLEMENTED` — needs a live Plane
  instance to verify the session-based sequence against.

**Substantial remaining work:**
- **`@RequirePermission` adoption** across the remaining `@Roles` sites (W2). **NOT STARTED.**
- **OAuth browser-session binding** (W2). **NOT STARTED.** PKCE + one-time state already defeat
  interception and replay; this needs a `SameSite=None; Secure` cookie decision because API and web
  are separate origins.

### Known nit

Single-suite e2e runs print "Jest did not exit one second after the test run has completed". It
predates and is unrelated to the Redis subscriber (an unrelated suite shows it too), the full suite
exits cleanly, and the subscriber is now closed with `disconnect()` rather than `quit()` — a
connection in subscriber mode will not process QUIT while subscribed, which would have held a
worker open on a rolling deploy. The remaining open handle is elsewhere and worth tracking down.

**Deliberately deferred by the plan itself:**
- Traversal duplicated between engines until the legacy engine is removed (plan §21 / WAVE 10).
- Per-attempt node-permission PDP (doc 09), scoped out in P3-06.
