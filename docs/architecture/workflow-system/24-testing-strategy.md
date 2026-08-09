# 24 — Testing Strategy (L2)

> **Level:** L2.
> **Why this document exists:** a sweep of all sixteen L1 documents (`00`–`15`) found **zero testing
> sections**. Every phase doc specifies Security, Performance, Scalability and Edge Cases; none says
> how any of it is verified. This is the largest single gap in the architecture set, and it blocks the
> Definition of Done of every other specification.
> **Extends:** all L1 docs. **Redefines:** none.

---

## 1. Purpose

Define what "tested" means for the workflow system, concretely enough that a reviewer can reject a PR
against it. Every other L2 spec's §27/§28 defers here for the *how*.

## 2. Scope

Test levels, the fixture and tenancy model, what each layer must cover, flaky-test policy, CI gating,
coverage targets, and the specific test suites the workflow rewrite requires.

## 3. Responsibilities

Own the taxonomy, the harness contracts, the quality gates. Provide the regression net that makes the
W3 engine cutover (`00 §0.10`) safe.

## 4. Non-responsibilities

Not the assertions for any individual feature — those live in each phase doc's §27. Not load-testing
infrastructure procurement. Not manual QA scripts.

## 5. Dependencies

Jest (`test/jest-e2e.json`, `test/jest-unit.json`); real Postgres + Redis via
`infra/docker-compose.yml` (Postgres **5433**, Redis **6380** — not the defaults); `supertest`;
Vitest + Testing Library on the web side.

---

## 6. Current baseline (measured, not assumed)

| Layer | Today |
|---|---|
| API e2e | 188 tests / 28 suites, serial (`maxWorkers: 1`) |
| API unit | 80 tests / 15 suites |
| Web | Vitest + RTL, 2 feature suites (`auth`, `onboarding`) |
| Contract tests | **none** |
| Load tests | **none** |
| Chaos tests | **none** |

Web coverage is the weakest layer by a wide margin: two suites for sixteen features.

## 7. The test pyramid, and the deliberate inversion

This system is **integration-heavy on purpose**. Its risk is not in pure functions — it is in
transactions, leases, queue semantics and tenant scoping, none of which a mocked test can prove. A
mocked BullMQ test that "passes" while the real queue dedupes differently is worse than no test.

| Level | Target share | Runs against | Speed |
|---|---|---|---|
| Unit | 40% | Nothing external | < 5s total |
| Integration | 45% | **Real** Postgres + Redis | < 5 min |
| E2E (API) | 12% | Full Nest app | < 15 min |
| E2E (browser) | 3% | Running web + api | < 10 min |

Mocking Postgres or Redis for workflow-runtime tests is **prohibited**. Mock only third-party network
egress.

---

## 8. What each level must cover

### 8.1 Unit
Pure logic only: state-transition matrix, retry classification and backoff bounds, idempotency key
derivation, template resolution (`{{a.b.c}}`), condition operators, variable scoping, DTO mappers,
`toolRequiresApproval`.

The transition matrix (doc 16 §7) deserves an exhaustive generated test — every `(from, to)` pair
asserted legal or throwing. It is cheap and it is the safety net for the whole state machine.

### 8.2 Integration (real infra)
Lease claim under contention; advisory-lock serialisation; outbox written in the same transaction;
join-state atomic increment; timer fire and dedup; DLQ routing; reaper sweeps; pgvector retrieval;
BullMQ `jobId` dedup.

**Pattern for concurrency tests** — the shape that actually catches races:

```ts
it('serialises concurrent advances on one run', async () => {
  const results = await Promise.all(
    Array.from({ length: 100 }, () => engine.advance(runId)),
  );
  expect(results.filter((r) => r === 'ADVANCED')).toHaveLength(1);
  expect(results.filter((r) => r === 'LOCK_NOT_ACQUIRED')).toHaveLength(99);
});
```

`Promise.all` on the real service against real Postgres. A mocked lock proves nothing.

### 8.3 E2E (API)
One suite per user-visible capability, through HTTP with a real JWT. Must cover the full lifecycle:
create → publish → run → pause → approve → resume → complete, plus cancel, timeout, retry-to-DLQ, and
compensation.

### 8.4 Browser E2E
Only the flows worth the cost: login, hire an employee, build and run a workflow, decide an approval.
Playwright, against a throwaway tenant.

### 8.5 Contract tests (NEW — currently missing)
`packages/types` is the shared contract between api and web, and nothing verifies the API actually
returns what the type claims. Add a suite asserting every response DTO parses against a zod schema
derived from `@vaep/types`. This is where silent drift like `seq` vs `sequence` (doc 14 §14.B.7 vs the
old doc 15 draft) gets caught mechanically.

### 8.6 Tenant-isolation tests (NEW — mandatory)
For **every** endpoint that takes an id: create two companies, request A's resource with B's token,
assert `404` (not `403` — a `403` confirms the resource exists). This must be table-driven so adding a
route without a test is a visible omission.

```ts
describe.each(TENANT_SCOPED_ROUTES)('%s is tenant-isolated', (method, path) => {
  it('returns 404 for another company\'s resource', async () => {
    await request(app).…(path.replace(':id', otherCompanyResourceId))
      .set(authAsCompanyB()).expect(404);
  });
});
```

---

## 9. Fixtures and tenancy

**Every test creates its own company.** No shared fixture tenant, no cross-test ordering dependence.
Registration is the cheapest correct setup and exercises the real path.

```ts
const email = `suite_name_${Date.now()}@example.com`;
```

**Never run tests against the live Kashif Recruiting tenant.** Throwaway companies only.

Teardown: rely on per-test unique companies rather than truncation. Truncating shared tables makes
parallel runs impossible and hides ordering bugs.

## 10. Environment contract

```
LLM_PROVIDER=mock  EMBEDDINGS_PROVIDER=hash  STORAGE_PROVIDER=local
SKILL_EXECUTOR=mock  BILLING_PROVIDER=mock
ENCRYPTION_KEY=<64 hex>  DATABASE_URL=…5433…  REDIS_URL=…6380…
JWT_ACCESS_SECRET=…  JWT_REFRESH_SECRET=…
```

Two traps, both previously hit and both costly:

1. **`LLM_PROVIDER` must be `mock`.** With `openai`, tool selection is non-deterministic and suites
   fail intermittently for reasons unrelated to the code.
2. **`SKILL_EXECUTOR=auto` is not safe for tests.** `AutoSkillExecutor` routes tools whose
   `connection.type === 'none'` to the **real** executor. Use `mock` explicitly.

A leftover `pnpm dev` API on **:4000 steals BullMQ jobs from the test run**, producing failures that
reproduce nowhere else. CI must assert the port is free before starting; locally, kill it first.

## 11. Flaky-test policy

CLAUDE.md currently documents five suites that fail locally for environmental reasons. That list is a
liability: once "some failures are expected" is normal, real regressions hide in the noise.

**Policy:** a test is green, skipped with a linked issue, or deleted. No third state.

| Suite | Cause | Action |
|---|---|---|
| `integrations.e2e-spec.ts` | Real `OAUTH_GOOGLE_*` in local `.env` | Force-unset in the test env |
| `knowledge.e2e-spec.ts` | Embedding-score variance | Assert ordering, not absolute score |
| `analytics` / `approvals` / `workflow-generator` | Mock LLM branch sensitivity | Pin prompts, assert on the branch taken |

Fix these **before** the W3 cutover — they are the regression net it depends on.

## 12–18. Error, retry, idempotency, concurrency, DB, API, events

Testing requirements for each are specified in the owning doc's §27 and verified at the level given in
§8. Cross-cutting rules:

- Every error class in doc 16 §11 needs a test proving retryable vs terminal behaviour.
- Every idempotency key in doc 16 §13 needs a duplicate-invocation test asserting a single effect.
- Every outbox event type needs a test asserting it is written **in the same transaction** (assert by
  rolling back and confirming no row).

## 19–22. Security, tenant isolation, permissions, audit

| Requirement | Test |
|---|---|
| No secret in a job payload | Automated scan of enqueued payloads against secret-field names |
| Cross-tenant payload rejected | Forge `companyId`; assert throw + alert |
| RBAC on every guarded route | Table-driven, each role × route |
| Approval gate cannot be bypassed | `workflow-tool-approval-gate.e2e-spec.ts` (shipped) — must run in **both** engine modes |
| Audit row per privileged action | Assert `AuditLog` row exists with actor and entity |

The G25 suite is the template for security regression tests: assert the side effect **did not happen**
(count `SkillExecution` rows), not merely that a status changed.

## 23. Observability of the tests themselves

CI publishes: pass/fail per suite, duration trend, flake rate per test over 30 days. A test whose flake
rate exceeds 1% is quarantined automatically.

## 24. Performance testing

Not optional — §0.8 states numbers, and an unverified number is a guess.

| Target (§0.8) | Test |
|---|---|
| 500 attempts/s peak | k6 against a seeded tenant, 10 min |
| Node overhead p95 < 50ms | Measure runtime cost excluding node work |
| Run-start p95 < 2s | Sustained enqueue |
| Timer ±30s | 1,000 timers, measure drift |
| Orphan recovery < 60s | Kill worker, measure |

Run nightly, not per-PR. Fail the build on a >20% regression against the stored baseline.

## 25. Chaos testing

| Experiment | Expected |
|---|---|
| `kill -9` a worker mid-attempt | Lease expires; `outcomeUnknown`; **no duplicate effect** |
| `FLUSHALL` Redis mid-run | All runs reach terminal state |
| Pause Postgres 30s | Jobs retry; no data loss |
| Provider returns 500 for 5 min | Breaker opens; `CONNECTOR_UNAVAILABLE`; recovers |
| Clock skew +5 min on one worker | Timers still fire correctly (DB `now()`, doc 16 E6) |

## 26. Coverage targets

| Area | Line | Branch |
|---|---|---|
| Runtime (`modules/workflows/engine`) | 90% | 85% |
| Approvals, permissions, crypto | 90% | 85% |
| Other API modules | 75% | 65% |
| Web features | 60% | 50% |

Coverage is a floor, not a goal — the tenant-isolation and idempotency suites matter more than the
percentage.

## 27. CI gating

| Stage | Runs | Blocks merge |
|---|---|---|
| Lint + typecheck | Every push | Yes |
| Unit | Every push | Yes |
| Integration | Every PR | Yes |
| E2E API | Every PR | Yes |
| Contract | Every PR | Yes |
| Tenant isolation | Every PR | Yes |
| Browser E2E | Merge to main | Yes |
| Performance | Nightly | No (alerts) |
| Chaos | Weekly | No (alerts) |

There is **no CI today** (enterprise-readiness audit, 2026-07-12). Standing this up is a W0-adjacent
prerequisite, not a later nicety — without it none of the above is enforced.

## 28. Acceptance criteria

1. Zero known-flaky suites; the CLAUDE.md exception list is empty.
2. Tenant-isolation suite covers every id-taking route.
3. Contract suite covers every response DTO.
4. Runtime coverage ≥ 90% line / 85% branch.
5. All five chaos experiments pass.
6. Performance baselines recorded and enforced nightly.
7. CI blocks merge on every gate marked Yes.
8. Full e2e suite green in **both** engine modes.

## 29. Implementation notes

Order: (1) stand up CI; (2) fix the five flaky suites; (3) tenant-isolation table; (4) contract suite;
(5) runtime integration + chaos alongside W3; (6) performance baselines; (7) browser E2E last.

Steps 1–2 come before new test-writing. Adding tests to a suite that is already allowed to fail
teaches the team to ignore red.

## 30. Definition of Done

- [ ] CI pipeline live, all gates enforced
- [ ] Flaky list empty; CLAUDE.md exception paragraph deleted
- [ ] Tenant-isolation + contract suites merged and passing
- [ ] Runtime coverage thresholds enforced in CI config
- [ ] Chaos suite runnable with one command; weekly schedule live
- [ ] Performance baselines committed; nightly regression alerting
- [ ] Every L2 spec's §27 satisfied by a named, existing suite

---

**Next:** `17-node-library-spec.md`.
