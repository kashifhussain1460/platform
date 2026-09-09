# Cluster 11 — Configuration-Driven Architecture + Testing Audit

Source: this pass actually EXECUTED the test suites (unit, e2e ×2 engine modes, Playwright browser)
against the live local stack (`docker ps` confirmed Postgres on 5433, Redis on 6380, plus a running
but untested Postiz/Chatwoot/Plane/Temporal set already up) rather than trusting `CLAUDE.md`'s
"745 e2e (101 suites) + 1058 unit (105 suites) + 13 browser, all green" claim. One research subagent
traced the config-driven capability pipeline file-by-file; every diff it cited was independently
re-read and spot-checked below. All paths relative to `d:/Vertical AI/platform`.

**Repo state note (relevant to both parts):** `git status` shows 37 modified + 1 new untracked file —
an in-flight, uncommitted "role-based hiring plans" feature slice (`docs/product/2026-09-04-role-based-hiring-plans.md`)
touching `capability-resolver.ts`, `product-context.service.ts`, `billing.plans.ts`, `billing.service.ts`,
`employees.service.ts`, `onboarding.service.ts`/`.module.ts`, `packages/types/src/index.ts`, and the web
`product-context/hooks.ts`. This is exactly the system Part B was asked to trace, and it is the same
tree the test runs below actually executed against (uncommitted code, not HEAD).

---

## Part A — Testing + Browser E2E

### A.1 Unit tests — real run

Ran `pnpm run test:unit --maxWorkers=2` from `apps/api` to completion (no infra needed — pure Jest,
no DB/Redis):

```
Test Suites: 110 passed, 110 total
Tests:       1139 passed, 1139 total
Time:        13.232 s
```

**Real, observed result: 110/110 suites, 1139/1139 tests, exit 0.** This is HIGHER than CLAUDE.md's
"1058 unit (105 suites)" claim — consistent with tests added since 2026-09-03/04 for the in-flight
role-based-hiring diff (`billing.plans.spec.ts` gained 129 lines, `capability-resolver.spec.ts` gained
8, per `git diff --stat`). **Classification: FULLY IMPLEMENTED / PASS, verified firsthand.** No
discrepancy with the "all green" claim for this layer — if anything the doc undercounts.

### A.2 E2E (Jest) — both engine modes, real run

Infra was live (`vaep-postgres-1` on 5433 healthy, `vaep-redis-1` on 6380, `Company` row count 4086
before any run of mine — this is a busy, long-lived shared dev DB, not a fresh fixture). Ran the exact
pinned command from `CLAUDE.md` twice, once per engine mode, generating a fresh 64-hex `ENCRYPTION_KEY`
each time:

```
LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local SKILL_EXECUTOR=mock \
BILLING_PROVIDER=mock ENCRYPTION_KEY=<64 hex> WORKFLOW_ENGINE_MODE=state_machine|legacy_walk \
npx jest --config ./test/jest-e2e.json --forceExit
```

| Engine mode | Suites | Tests | Result | Time |
|---|---|---|---|---|
| `state_machine` (default) | 103 passed / 103 | 767 passed / 767 | **exit 0, all green** | 251 s |
| `legacy_walk` | **99 passed, 4 failed / 103** | **763 passed, 4 failed / 767** | **exit 1, NOT green** | 362 s |

Both numbers (103 suites / 767 tests) are higher than CLAUDE.md's "745 e2e (101 suites)" — again
consistent with ongoing work. The `state_machine` result matches the doc's "all green" claim. **The
`legacy_walk` result contradicts it.** CLAUDE.md's own dual-mode gotcha says *"Both are 465/465 as of
2026-08-13"* — that was true on that date; it is stale today, and nothing currently re-asserts it. This
is a live regression, not a doc-staleness nitpick: it was caught only because this audit followed
CLAUDE.md's own instruction to run both modes rather than trusting the "green" claim.

**The 4 `legacy_walk`-only failures, all the same symptom** (a `WORKFLOW`-kind `ApprovalRequest` is
correctly auto-approved/approved, but the underlying `WorkflowRun` never advances past `WAITING` to
`COMPLETED`):

| Suite | Assertion that failed | Evidence |
|---|---|---|
| `test/approval-sla.e2e-spec.ts` | `'AUTO_APPROVE on timeout resumes the run'` — `ApprovalRequest.status` correctly flips to `APPROVED`/`autoDecided:true`, but `runStatus(runId)` stays `WAITING` instead of `COMPLETED` | `apps/api/test/approval-sla.e2e-spec.ts:159` |
| `test/business-lifecycle.e2e-spec.ts` | Same shape: approve → poll run → expected `COMPLETED`, got not-`COMPLETED` | `apps/api/test/business-lifecycle.e2e-spec.ts:230` |
| `test/workflow-approval.e2e-spec.ts` | Same shape | `apps/api/test/workflow-approval.e2e-spec.ts:223` |
| `test/journey-hr-e2e.e2e-spec.ts` | Same shape | `apps/api/test/journey-hr-e2e.e2e-spec.ts:223` |

Root-cause was not required by this task's scope (read-only audit — not a fix pass), but the mechanism
is visible in `apps/api/src/modules/workflows/workflows.service.ts:760-784` (`resumeRun`) →
`dispatchRun` (`:128-165`): under `legacy_walk` + queue mode (not `inline`), a resume enqueues
`{runId, resume:true}` onto the legacy BullMQ `workflow-run` queue for `workflow.processor.ts` to pick
up (`apps/api/src/modules/workflows/engine/workflow.processor.ts:86-88`) — this path is the one that
silently fails to bring the run to `COMPLETED` within the tests' poll windows (20-30s). Notably,
`test/workflow-tool-approval-gate.e2e-spec.ts` (a **`TOOL`**-kind approval, which resumes the agent
loop directly rather than via this BullMQ dispatch) passed — consistent with the bug being specific to
the `WORKFLOW`-kind resume path under `legacy_walk`. Confirmed this was not an artifact of leftover
processes stealing jobs (the exact CLAUDE.md "stale process" gotcha): checked for orphaned
`nest start`/`next dev` processes before and during the run — none existed.

**Classification: `legacy_walk` WORKFLOW-approval-resume = BROKEN** (real, reproducible, currently
unfixed regression, distinct from the durable-engine-only gaps CLAUDE.md already documents from
2026-08-13 — this is the reverse: a legacy-only defect). **`state_machine` WORKFLOW-approval-resume =
FULLY IMPLEMENTED / PASS.**

### A.3 PASS / FAIL / BLOCKED / NOT TESTED / FALSE POSITIVE — and what "green" actually proves

| Area | Verdict | Basis |
|---|---|---|
| Unit suite (110/110) | **PASS** | Run to completion, observed |
| E2E, `state_machine` engine (103/103) | **PASS** | Run to completion, observed |
| E2E, `legacy_walk` engine (99/103) | **FAIL** | Run to completion, observed; 4 real failures, same root symptom |
| Playwright browser suite (13/14) | **FAIL** | Run to completion, observed (§A.4) |
| Real OpenAI/Anthropic LLM calls | **NOT TESTED anywhere in CI or local e2e/unit** | `apps/api/test/setup-e2e-env.ts:59-65` forcibly blanks `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` to `''` in a `setupFiles` hook that runs before `ConfigModule` import — by design, so no test can ever reach a real vendor. All 3 GitHub workflows (`api-ci.yml:108`, `deploy.yml:190`, `browser-e2e.yml:69`) pin `LLM_PROVIDER=mock` unconditionally |
| Real Stripe billing | **NOT TESTED** | `.env` carries a real Stripe **test-mode** secret key (`STRIPE_SECRET_KEY=sk_test_...`), but `BILLING_PROVIDER=mock` is pinned in all 3 CI workflows and in the pinned local e2e command; no automated path ever calls Stripe |
| Real OAuth (Google/Microsoft/Slack/HubSpot) | **NOT TESTED, deliberately** | Same `setup-e2e-env.ts:35-44` blanks all 4 client id/secret pairs before every test file loads, specifically so a developer's real `.env` credentials can never leak into a test run |
| Real Twilio (WhatsApp) | **NOT TESTED** | No Twilio credential appears in any CI workflow or e2e setup file; `SKILL_EXECUTOR=mock` is pinned everywhere automated |
| Postiz / Chatwoot / Plane (marketing/support/PM engines) | **NOT TESTED against the real service, though containers are running** | `docker ps` shows `vaep-postiz-1`, and `apps/api/.env` sets `POSTIZ_BASE_URL=http://postiz:3000` / `CHATWOOT_BASE_URL=http://chatwoot:3000` / `PLANE_BASE_URL=http://plane:8000` — all **docker-internal hostnames**, unreachable from the host or from a test process running outside that compose network. `PostizClientService.baseUrl()` (`apps/api/src/modules/engines/marketing/postiz-client.service.ts:82-83`) throws if unset, and it is never set in `setup-e2e-env.ts` or CI, so `test/e2e/engines-marketing.e2e-spec.ts` only exercises `PrismaClient` writes to `SocialAccount`/`ScheduledPost` — schema-only, zero real Postiz HTTP calls. `CHATWOOT_PLATFORM_API_TOKEN=` is blank in `.env` too, so even a manual developer call would fail auth |
| Credit-billing enforcement (real money math) | **PASS under mock, but flag-gated off by default in prod** (see Cluster 1) — not re-verified this pass, cross-referenced only |

**The single most important fact for anyone reading "745/1058/13, all green" at face value:** every one
of those numbers, past and present, was produced with every real external provider forcibly disabled.
A 100% pass rate says the mock-provider code paths, DB writes, and internal state machines are correct.
It says **nothing** about whether a real OpenAI call, a real Stripe charge, a real Twilio send, or a
real Postiz post would work — those integrations have **zero automated coverage**, not "coverage with
some flakiness." This is the intended, explicitly-documented design (`setup-e2e-env.ts`'s own comments
make the same point) — the risk is not that anyone is hiding this, it's that the "all green" framing
in `CLAUDE.md` doesn't repeat the caveat every time, and it's easy to read "745 e2e, all green" as
stronger evidence than it is.

### A.4 Playwright browser E2E

**Coverage — read every spec file, not just counted them:**

| File | Lines | What it actually proves |
|---|---|---|
| `01-auth-journey.spec.ts` | 68 | Signup→authenticated; logout/re-login; wrong password rejected; unauthed visitor blocked from an app route |
| `02-security-journey.spec.ts` | 240 | Department isolation both directions; a `DISABLED` user is fully locked out; a `MEMBER` cannot reach `/hr` |
| `03-golden-journey.spec.ts` | 332 | The full "Golden Enterprise Journey (§23)": signup → hire employee → connect skill → upload knowledge → build workflow → approval → execution → audit trail, one continuous browser session |
| `04-tenant-isolation-journey.spec.ts` | 214 | Two real companies; company A cannot see/touch company B's data via API or UI |
| `05-failure-journeys.spec.ts` | 368 | Rejected approval executes nothing; a disabled user's pre-issued token can't trigger a run; a demo-only (simulated) skill refuses OAuth; duplicate submission produces exactly one run |
| `06-plan-seats-journey.spec.ts` | 106 | **New, uncommitted** (untracked in git) — role-based hiring seat/role UI limits, upgrade prompts, billing page copy |

14 `test()` blocks total (confirmed by direct grep), matching CLAUDE.md's "13 browser" plus the one new
untracked spec added since. `playwright.config.ts` is written deliberately against the real stack (real
Next.js + real Nest + real Postgres/Redis, not mocks) — its own header comments call this out as the
whole point of the wave (§7 there: *"Record evidence. Do not equate 'harness exists' with 'E2E
passed.'"*).

**Actually running it took three attempts, and all three are evidence, not just noise:**

1. **First attempt: `Error: Timed out waiting 180000ms from config.webServer`.** This was NOT a product
   defect — I was concurrently running the full Jest e2e suite on the same machine at the time, and the
   resulting CPU/DB contention meant `nest start --watch`'s first-time compile didn't finish within the
   configured 180s. Confirmed after the fact: the orphaned `nest`/`next` processes it had spawned came up
   healthy several minutes later, well past Playwright's own timeout, and Playwright had already killed
   its wait and exited 1. **This one is on my test methodology, not the codebase — flagged explicitly
   rather than silently omitted.**
2. **Second attempt (after confirming ports were free): failed differently, and usefully.** The leftover
   dev servers from attempt 1 were still alive and now healthy, so Playwright's `reuseExistingServer`
   reused them — but they'd been started with `apps/api/.env`'s real `MAIL_ENABLED=true`, not
   Playwright's own override. The suite's `global-setup.ts:71` (`assertDevOtpActive`) **caught this and
   refused to run**, with a message naming the exact cause and fix: *"an API is already running on
   :4000 with MAIL_ENABLED=true... every address these tests invent would be emailed for real."* This is
   the live, first-hand reproduction of the exact gotcha CLAUDE.md documents (*"Playwright reuses YOUR
   dev server... skips Playwright's env overrides"*) — and a genuinely good finding: **the harness
   has a proactive, named guard against silently spamming real inboxes**, not just a docs warning.
3. **Third attempt, clean** (killed the stale `nest`/`next` processes first, let Playwright spawn its
   own): **13 passed, 1 failed, in 2.2 minutes.**

**The one real, reproducible failure:**

```
[chromium] › 06-plan-seats-journey.spec.ts:26 › the hire form greys the full role, then all
seats, and billing shows the rule

Error: expect(locator).toBeVisible() failed
Locator: getByText(/2 of 2 seats/).first()
Timeout: 30000ms — element(s) not found
  at e2e/tests/06-plan-seats-journey.spec.ts:57
```

The test hires a second employee through the real UI, then expects the seat counter to update from
"1 of 2 seats" to "2 of 2 seats" — it never does, within 30s. **This is not a flake; it is the exact
staleness bug independently found by static analysis in Part B §B.4 below** (`useProductContext()`'s
60s `staleTime` with no mutation ever calling `invalidateQueries` on `productContextKeys.all`) — now
confirmed end-to-end in a real browser against the real running app, not just by code inspection. This
is a rare case where a code-reading finding and a live browser failure independently converge on the
same root cause, which is strong evidence it's real rather than a reasoning artifact.

**`e2e/test-results` churn — confirmed live, not just read about.** Before this run, `git status`
showed 21 tracked files under `e2e/test-results/` (artifacts from a previously-committed failing run of
specs 01/02) plus one untracked leftover from a manual run of the new spec 06. After this clean run,
`git status` showed all 21 previously-tracked files as **deleted** (`D`) — because this run passed
those tests and Playwright only writes failure artifacts — plus one **new untracked** directory for the
one real failure this run produced (`06-plan-seats-journey-...-chromium/`). This is exactly the
CLAUDE.md-documented gotcha (*"`e2e/test-results/` is tracked and rewritten every run"*) reproduced
live. Per this task's read-only instructions, this was left as-is (not `git checkout`'d back) — a
normal contributor would run that command before committing anything else.

**Classification:** Auth/security/golden/tenant-isolation/failure journeys (specs 01-05, 13 tests) =
**FULLY IMPLEMENTED / PRODUCTION READY**, proven in a real browser against a real stack. The new plan-
seats journey (spec 06) = **BROKEN** — not the seat-enforcement logic itself (server-side `checkSeatFor`
is real and 403s correctly, confirmed later in the same test up to the point of failure), but the
**UI's reflection of a state change it just caused**, i.e. a real, live, reproduced instance of the
frontend cache-invalidation gap documented next.

---

## Part B — Configuration-driven architecture

Traced by a dedicated research pass, then independently spot-checked against the actual current
(uncommitted) diffs for `capability-resolver.ts`, `product-context.service.ts`, `billing.plans.ts`,
`employees.service.ts`, `onboarding.service.ts`, `hooks.ts`, and `OnboardingWizard.tsx` — every citation
below marked "(confirmed)" was read directly in this pass, not merely taken from the research pass.

### B.1 Verdict

**This is real, dynamic, per-company resolution — not a static shell**, with one honestly-scoped
exception and one live bug.

`resolveRelevantCapabilities()`/`resolveRelevantAreas()` in
`apps/api/src/modules/product-context/capability-resolver.ts:130-208` union output from **four
independent, differentiated lookup tables** in `relevance.map.ts`: `INDUSTRY_CAPABILITIES` (9 distinct
industry keys), `GOAL_CAPABILITIES` (13 goal keys), `DEPARTMENT_EMPLOYEE_ROLES` (10 department keys),
and per-hired-role `EMPLOYEE_ROLE_CAPABILITIES`/`EMPLOYEE_ROLE_AREAS` (e.g. `HR` unlocks
`INTERVIEW_SCHEDULING`+`HR`; `MARKETING` unlocks only `MARKETING`). None of this is a single catch-all —
each table branches on the actual stored value. This is backed by an exhaustive A-H scenario matrix in
`capability-resolver.spec.ts` that asserts genuinely different companies get genuinely different output
(HR company unlocks `INTERVIEW_SCHEDULING`; Marketing company doesn't; STARTER/PRO don't unlock `ASSIST`,
BUSINESS/ENTERPRISE do; department-scoped authorization narrows the set further), plus a determinism
test (same input twice → byte-identical output; reordered input → same output).

**Confirmed (this pass):** read the uncommitted diff for `capability-resolver.ts` — it adds
`resolveSeats()` (a new function, `:233-256`), wired into `resolveEntitlements()`, consuming three new
`CompanyContext.subscription` fields (`maxRoles`/`maxPerRole`/`creditsPerEmployeePerMonth`) that
`product-context.service.ts`'s diff populates from three new `billing.plans.ts` functions
(`maxRolesFor`/`maxPerRoleFor`/`creditsPerEmployeeFor`). The types line up end-to-end with no drift.

### B.2 Onboarding-captured fields → downstream consumption

| Field | Captured | Consumed downstream? |
|---|---|---|
| `industry` | Onboarding wizard step 1 | **CONSUMED** — drives `INDUSTRY_CAPABILITIES` branching (`capability-resolver.ts:150-154`) |
| `businessGoals` | Wizard step 3 | **CONSUMED** — drives `GOAL_CAPABILITIES` (`:145-149`); the resolver spec literally has a test titled "reads business goals — the column nothing consumed before" |
| `departments` | Wizard step 4 | **CONSUMED** — drives `DEPARTMENT_EMPLOYEE_ROLES` → role → area/capability (`:157-163`, `191-197`) |
| Hired employee roles | Wizard step 2 | **CONSUMED** — drives `EMPLOYEE_ROLE_CAPABILITIES`/`AREAS` and, per the new diff, seat/role checks |
| `plan` (subscription) | Registration/billing | **CONSUMED** — gates `ASSIST` area; now also gates seats/roles (see §B.5) |
| `Company.size` | Wizard step 1 | **Read outside the resolver** (AI Assist system prompt, `assist-agent.service.ts`) but **not branched on inside `capability-resolver.ts`/`relevance.map.ts`** — present on `CompanyContext` and echoed in the output DTO, never in a lookup table or conditional. Cosmetic with respect to capability resolution specifically |
| `Company.description` | Onboarding `complete()` | **STORED-ONLY** — persisted, returned via `CompanyDto` passthrough, no branching consumer found anywhere in `apps/api/src` |
| `onboardingStep` | Wizard bookkeeping | Stored-only by design (resume marker, not a product-behavior field) |

### B.3 Caching and invalidation — a real, live-confirmed gap

Server side: **no cache** — `ProductContextService.resolve()` issues a fresh `Promise.all` of Prisma
queries on every call. Always correct, just not memoized.

Client side: `useProductContext()` sets `staleTime: 60_000` and its own docstring explicitly claims
*"it changes when someone hires an employee, installs a skill, changes plan or is moved between
departments... all of which invalidate through their own mutations."* **This claim does not hold.**
Grepping every `invalidateQueries` call across `apps/web/src` for the key `productContextKeys.all`
(`['product-context']`) returns **zero matches**. Confirmed the specific mutations by name:
`useCreateEmployee` invalidates only `employeeKeys.list`; the plan-change mutation invalidates only
`billingKeys.subscription`/`billingKeys.usage`; `useCompleteOnboarding` invalidates five other keys but
not this one. The global `QueryClient` also disables `refetchOnWindowFocus`, so there's no focus-driven
self-heal either — only the 60s `staleTime` eventually clearing it.

**This is not a theoretical finding** — §A.4 above reproduced it live: hiring a second employee through
the real browser UI left the seat counter showing the stale count for the full 30s the Playwright test
waited. **Classification: BROKEN** (bounded — self-heals after 60s on next mount — but a real, now
twice-confirmed defect, not a hypothetical).

### B.4 Enforcement boundary — deliberately advisory, and honestly labeled as such

`capability-resolver.ts`'s own header states: *"It is not an authorization layer... Nothing here can
grant a user access to anything, and the endpoints being navigated to keep their own guards."*
Confirmed structurally: zero imports of `ProductContextService`/`resolveProductContext` anywhere inside
`apps/api/src/modules/skills`, `apps/api/src/modules/employees`, or `apps/api/src/modules/workflow-templates`
— the resolver has exactly one consumer, `ProductContextController`, feeding the frontend nav/dashboard
only. The web hook's own docstring says the same thing (*"a display hint, not a security control...
hiding a link has never stopped anyone typing a URL"*) and fails open (`true`) on load/error.

Real enforcement is separate and independently verified:
- `AssistController` carries a real `@RequirePlan('BUSINESS','ENTERPRISE')` guard mirroring (not driven
  by) `AREA_MIN_PLAN.ASSIST`.
- **Confirmed directly (this pass):** `EmployeesService.create()`'s diff wraps the new
  `checkSeatFor(plan, roster, dto.role)` check inside the existing `pg_advisory_xact_lock`-protected
  transaction, throwing a real `ForbiddenException` on violation — this is the same pure function
  (`billing.plans.ts`) the resolver calls to compute `entitlements.seats`, so the two cannot silently
  diverge by construction, not by convention.
- **Confirmed directly (this pass):** `onboarding.service.ts`'s diff adds a pre-flight check in
  `complete()` using the identical `checkSeatFor()` against a simulated roster, returning a single 422
  naming every problem role rather than partially hiring then failing mid-way.

**Classification: nav/dashboard gating = correctly-labeled advisory (not a defect); seat/plan
enforcement = FULLY IMPLEMENTED, PRODUCTION READY, and genuinely shared with the display layer.**

### B.5 Plan tier ↔ product-context intersection

Two independent, both-real mechanisms:
1. **Area gating (pre-existing):** `AREA_MIN_PLAN.ASSIST = 'BUSINESS'` removes `ASSIST` from
   `productAreas` for STARTER/PRO, test-proven.
2. **Seat/role gating (the in-flight diff):** **Confirmed directly (this pass)** by reading
   `billing.plans.ts`'s full diff — `PLAN_CATALOG` now encodes `maxRoles`/`maxPerRole` per plan (Free
   2×1, Starter $20 2×1, Growth $40 2×2, Enterprise unlimited), and the new pure `checkSeatFor()` is the
   single rule shared by `EmployeesService.create()` (real 403), `BillingService.usage()` (display),
   `product-context`'s `resolveSeats()` (display), and the onboarding pre-flight (real 422) — one rule,
   four call sites, not four copies. **Confirmed directly** in `OnboardingWizard.tsx`'s diff: the wizard
   greys out a role before submission using this same `seats` data via the new `useSeatAvailability()`
   hook, so the UI and the server enforce the identical rule.

### B.6 Test coverage of the new behavior — asymmetric

Backend (`capability-resolver.spec.ts`): genuinely rigorous, differentiation-asserting, not smoke
tests — but its own diff (8 lines) only updated an existing fixture's shape, it did **not** add a new
scenario asserting seat-based differentiation.

Frontend (`hooks.test.tsx`): diff (5 lines) only extends an existing fixture builder for type
compatibility. Grepped for `useSeatAvailability` across `apps/web/src` — used only in production
components (`SeatSummary.tsx`, `OnboardingWizard.tsx`, `EmployeeSettings.tsx`, `EmployeeForm.tsx`),
**never in a test file**. Its three-branch `reasonBlocked()` logic (TOTAL/PER_ROLE/NEW_ROLE messages)
has zero unit-test coverage today — the only thing that actually exercised it end-to-end was the
Playwright run in §A.4, and that run failed (on the adjacent staleness bug, not this logic itself).

### B.7 Is the uncommitted diff a finished feature or a broken partial edit?

**Complete and internally consistent.** Traced all 8 touched files end-to-end: shared DTO
(`packages/types/src/index.ts`) → plan catalog (`billing.plans.ts`) → resolver (`capability-resolver.ts`)
→ resolver's I/O shell (`product-context.service.ts`) → real enforcement
(`employees.service.ts`, `onboarding.service.ts`) → display (`billing.service.ts`'s `seatUsageFor`) →
frontend hook (`hooks.ts`) → frontend UI (`OnboardingWizard.tsx`, confirmed). No type drift, no
orphaned field, no dangling import found in any file read. The unit suite (§A.1) passing 1139/1139
against this exact working tree corroborates it. The one loose end is the pre-existing §B.3 cache gap,
which this feature exposes more visibly (a customer hiring their last seat now sees a stale "still have
room" state for up to 60s) but did not introduce.

---

## Classification summary

| Item | Classification |
|---|---|
| Unit test suite | FULLY IMPLEMENTED / PRODUCTION READY (verified: 1139/1139) |
| E2E, `state_machine` engine | FULLY IMPLEMENTED / PRODUCTION READY (verified: 767/767) |
| E2E, `legacy_walk` engine, WORKFLOW-approval-resume | **BROKEN** (verified: 4/767 failing, reproducible) |
| E2E, `legacy_walk` engine, everything else | FULLY IMPLEMENTED (verified: 763/763 of the rest) |
| Real-provider (OpenAI/Anthropic/Stripe/Twilio/Postiz/Chatwoot/Plane) automated coverage | **UNREACHABLE / NOT TESTED by design** — zero automated exercise anywhere in CI or local e2e |
| Playwright specs 01-05 (13 tests) | FULLY IMPLEMENTED / PRODUCTION READY (verified live in a real browser) |
| Playwright spec 06 (plan-seats) | **BROKEN** (verified live: UI doesn't reflect its own mutation within 30s) |
| `capability-resolver.ts` capability/area resolution | FULLY IMPLEMENTED / PRODUCTION READY |
| Onboarding→product-context propagation (industry/goals/departments/roles) | FULLY IMPLEMENTED |
| `Company.size` in capability resolution | **UNUSED** (cosmetic w.r.t. this pipeline; used elsewhere) |
| `Company.description` | **UNUSED** (stored-only, no consumer found) |
| Product-context server-side freshness | FULLY IMPLEMENTED (no cache = always correct) |
| Product-context client-side cache invalidation | **BROKEN** (confirmed live + by code) |
| Nav/dashboard capability gating | PARTIALLY IMPLEMENTED, but **correctly self-labeled as advisory** — not a defect |
| Seat/role/plan enforcement (server) | FULLY IMPLEMENTED / PRODUCTION READY |
| `useSeatAvailability()` frontend logic | PARTIALLY IMPLEMENTED — correct, but zero dedicated test coverage |
| Uncommitted role-based-hiring diff overall | FULLY IMPLEMENTED, not yet committed |

---

## Top 5 most severe findings

1. **`WORKFLOW_ENGINE_MODE=legacy_walk` is currently broken for every `WORKFLOW`-kind approval resume**
   (4 real e2e failures reproduced firsthand: `approval-sla`, `business-lifecycle`, `workflow-approval`,
   `journey-hr-e2e` — all "approve → run should complete → run stays WAITING forever"). CLAUDE.md's
   "both modes 465/465" claim is stale and nothing currently re-verifies it; this contradicts the
   platform's own explicit rule that a single-mode green run proves nothing.
2. **The product-context frontend cache is never invalidated by the mutations its own docstring claims
   invalidate it** (`productContextKeys.all` has zero `invalidateQueries` callers anywhere in
   `apps/web/src`) — and this is not theoretical: a live Playwright run of the new plan-seats journey
   failed for exactly this reason, the seat counter not updating within 30s of a real hire.
3. **"745/1058/13, all green" is true but proves far less than it implies** — every real external
   provider (OpenAI, Anthropic, Stripe, Twilio, Postiz, Chatwoot, Plane) is forcibly disabled in every
   automated test path, by design, with zero exceptions found. Real containers for Postiz et al. are
   running in docker but are configured with internal-network-only hostnames unreachable from any test
   process, so even a manual dev call would need extra setup.
4. **The capability-resolver pipeline is genuinely dynamic** (industry/goals/departments/roles/plan all
   drive real, tested, differentiated output) — this is a positive finding worth stating plainly, since
   audits skew toward finding problems: this is not a static shell, and the seat/role enforcement added
   in the current uncommitted diff is real, shared, and 403/422-enforced server-side, not cosmetic.
5. **Running the suite surfaced its own operational gotchas as live bugs, confirming CLAUDE.md's
   warnings are accurate but incomplete**: a webServer timeout caused by my own concurrent test run
   (methodology artifact, disclosed), and a stale dev server serving real `MAIL_ENABLED=true` that the
   harness's own `assertDevOtpActive` guard correctly refused to run against — a good defensive control,
   but one that only exists because the failure mode it guards against is real and has apparently
   happened before.
