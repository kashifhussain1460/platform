# Orlixa Production Cleanup + Gap Closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the verified P0/P1 gaps from the 2026-09-09 kill-critic audit and make the codebase honest
about what it actually supports — without redesigning the architecture, which was independently verified as
fundamentally correct.

**Architecture:** Unchanged. `AiEmployee` (identity) + `Workflow` (behaviour) + `Skill` (capability) remain
the primary abstractions; `AgentRuntimeService` stays the single shared runtime and is extended, never forked.
No new Agent subsystem, no second workflow engine, no second template system, no second provider-selection
mechanism.

**Tech Stack:** pnpm + Turborepo · `apps/api` (NestJS 11, Prisma, Postgres+pgvector, BullMQ/Redis) ·
`apps/web` (Next.js App Router, TanStack Query, Tailwind) · `packages/types` (`@vaep/types`, built CJS) ·
Jest (unit + e2e) · Playwright (browser).

**Spec:** `docs/audit/2026-09-08-kill-critic-audit/00-FINAL-REPORT.md` (the audit) plus the seven
verification passes, which carry the exact file:line facts, signatures and test cases each task needs:

| Task area | Detailed spec (read before implementing) |
|---|---|
| Employee lifecycle | `verify-02-employee-lifecycle.md` → "What the implementation plan must do" |
| AI Assist trigger + credits | `verify-03-assist-trigger-and-credits.md` → same section |
| Skill readiness honesty | `verify-04-skill-readiness.md` → same section |
| Credit safety ceiling | `verify-05-credit-rollout.md` → same section |
| Frontend fixes | `verify-06-frontend.md` → same section |
| Catalogs / dead code / comments | `verify-07-catalogs-config-cleanup.md` → same section |
| Legacy engine retirement | `verify-01-legacy-engine.md` → same section |

Those documents are the task detail. This plan supplies what they deliberately left open: **sequencing, file
ownership, and the decisions on every question they flagged rather than guessed.**

---

## Global Constraints

- **Never fork a working abstraction.** Extend `AgentRuntimeService`, the `NodeRegistry`, the provider-adapter
  registry, `checkSeatFor()`, `collectDefinitionIssues`. Do not add a parallel implementation of any of them.
- **Prove a thing is dead before deleting it.** A narrow regex already produced 5 false "unused" verdicts in
  this repo (cluster 01 §C). Re-run every "no matches" with a broader pattern before concluding.
- **Silent success is the defect class this codebase keeps re-creating.** A missing/unresolvable resource must
  fail loudly, never fall through to a default, a mock, or a wider scope.
- **`ready === (publish would succeed)`** is a documented invariant pinned by
  `workflow-ux-simplification.e2e-spec.ts`. Any new readiness BLOCKER must be matched by the same rule in
  publish/activate, or it must be a WARNING instead.
- **Rebuild `@vaep/types` before running API tests** (`pnpm --filter @vaep/types build`) — `nest` resolves it
  from `dist`, not source.
- **Pin providers on every test run** or expect ~78 configuration-only failures:
  `LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local SKILL_EXECUTOR=mock BILLING_PROVIDER=mock ENCRYPTION_KEY=<64 hex>`
- **Run e2e in both engine modes** until Task 2.x retires one (`WORKFLOW_ENGINE_MODE=state_machine` and
  `legacy_walk`). A single-mode run proves half the product.
- **Credit flags read raw `process.env`** (so a test `beforeAll` mutation works), but
  `COMPANY_MAX_CONCURRENT_EXECUTIONS` is a `ConfigService` constructor read and **must** be set in
  `test/setup-e2e-env.ts`.
- **Never assert a global count** against the shared dev DB (44+ tenants), and never call a retention/SLA/
  reservation `sweep()` from a test. Scope every assertion by `companyId`. Clean up credit tables explicitly
  (Convention B — `Company.delete` does not cascade to them).
- **Use a throwaway company in every test.** Never the real tenant.
- Git: branch `chore/production-cleanup-gap-closure`, one commit per task, nothing pushed.

---

## Decisions Register

The verification passes flagged 17 questions rather than guessing. Resolved here, with reasoning, so no task
has to re-litigate them. **Six are marked 🧑 — they are business calls I have made a defensible default for,
and are the ones worth a human overriding.**

### Employee lifecycle (verify-02)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | `fireWebhook` on an inactive employee: 409 or 200-and-drop? | **409 Conflict**, loud | A 200-and-drop is a silent success — the defect class this whole plan exists to remove. A provider retry is harmless; no run is created either way. |
| D2 | Should PAUSED and DISABLED differ at run creation? | **Identical — both refuse** | Nothing in the run state machine supports "held until the employee resumes" (`run-state.ts:64`); building that is a much larger change. Refusing both is honest today. |
| D3 | Is the AI generator's unfiltered employee query deliberate? | **Treat as a miss; fix it** | No comment or ledger entry justifies it, and the newer assist path fixed exactly this (G37, `assist-read-tools.ts:190-199`). Consistency wins. |
| D4 | New `FailureClass` value or reuse? | **Reuse `AUTHORIZATION_DENIED`** | Already non-retryable, already rendered by `RunFailureCard`. A new value buys only a metric label. |
| D5 | In-flight run when the employee is paused mid-run? | **Do not cancel** | House rule is established: archive throws 409 rather than interrupt; runs deliberately snapshot their world at creation; `cancelRun` is reserved for a human. |
| D6 | Enforce in readiness as BLOCKER? | **WARNING only** | Employee status is mutable after publish, so a blocker would go stale instantly and break the `ready === publish` invariant. |

### AI Assist (verify-03)

| # | Question | Decision | Why |
|---|---|---|---|
| D7 | `NEW_EMAIL_REPLY` vs `EMAIL_REPLIED` | **Use `NEW_EMAIL_REPLY`** (what actually fires); log the canonical-list inconsistency as a separate cleanup item | Correctness beats tidiness. `EMAIL_REPLIED` is in the canonical list but has no producer — emitting it would build a workflow that never fires. |
| D8 | Which `eventType`s may Assist emit? | **An explicit `ASSIST_ALLOWED_EVENT_TYPES` allow-list containing only types with a verified live producer**: `NEW_EMAIL`, `NEW_EMAIL_REPLY`, `NEW_GITHUB_PR`, `NEW_GITHUB_ISSUE`, `NEW_TICKET`, `TICKET_REPLIED`, `ASSIGNMENT_CHANGED`, `STATUS_CHANGED`. Reject everything else with a corrective message. | Emitting a producer-less event type rebuilds the same silent-success defect one layer up. The allow-list must be spec-guarded so it can't drift from the producers. |
| D9 | Assist reservation idempotency anchor | **`assist:<sessionId>:<userAssistMessageId>`**, and `AssistService.turn` must return that id. On the `repeatsUnanswered` path (no new USER message), reuse the last USER message's id — which is correct, because it is the same turn being retried. | Avoids the `"<companyId>:null:null"` collision trap that would silently stop billing after the first turn in a company. |
| D10 | Readiness severity for MANUAL-but-expects-payload | **WARNING** + `TRIGGER: 'WARN'` | The workflow genuinely is publishable; it just won't do what was asked. A BLOCKER would need `activate()` to enforce the same rule and would break the `ready === publish` invariant. |
| D11 | Add `assistSessionId` ledger columns? | **No — Option 1, no migration.** Anchor on `messageIdempotencyKey`, attribute via `reason`. | Closes the enforcement + visibility gap with zero schema churn. Revisit only if filterable assist spend is wanted on `/billing/usage`. |
| D12 | `connectorId` on an assist-built EVENT trigger | **Leave unset** | Back-compat default (unscoped triggers match every connector), and the agent has no tool that returns `InstalledSkill.id`s. Stated explicitly rather than silently omitted. |

### Skills / readiness (verify-04)

| # | Question | Decision | Why |
|---|---|---|---|
| D13 🧑 | Should `postiz` block publish as `SUPPORTED_BUT_NOT_CONFIGURED`? | **Yes, block** | A workflow that cannot run should not be publishable. Honest failure at publish beats a green publish and a broken first run. The message names the support step rather than offering a dead Connect button. |
| D14 | `CONNECTION_REQUIRED_AND_AVAILABLE` as a 4th status? | **Map onto the existing `READY`** | `READY` already means exactly that, and 6 call sites plus `isBlocking` key off it. Renaming churns every consumer for no information gain. |
| D15 | Derive provisioning availability, or declare it? | **Declare the field, guard the one direction a regex can decide** (an `UNAVAILABLE` skill must have no writer; a non-`UNAVAILABLE` one must have one) | Provisioning has no one-to-one syntactic artefact to grep, and "operator-only vs self-service" requires resolving a controller guard. An unguarded hand-maintained field is the pattern this repo has already been burned by. |
| D16 | WhatsApp fix: adapter, refuse-and-redirect, or prerequisite resolution? | **Refuse-and-redirect + prerequisite resolution now; a real provider adapter later** | Only prerequisite resolution closes F3-N1 (the auto-executor refusing a correctly-connected account). A real adapter needs a contract change and a new cross-module dependency — sequence it after the product is honest. |

### Credits (verify-05)

| # | Question | Decision | Why |
|---|---|---|---|
| D17 🧑 | Enable metering for new tenants, or a flag-independent ceiling? | **Ceiling only, this pass** (the user chose this explicitly) | Enabling ledger+enforcement with grants off causes an instant total AI outage on the first message; the grant path, the renewal cron and PAYG all have unresolved prerequisites. The ceiling needs none of them. |
| D18 | Does a per-run duration cap risk killing approval-parked runs? | **Yes — so the deadline must exclude time in `WAITING`/`RETRYING`** | A run parked on a human approval is working as designed and must never be reaped for being slow. |

**Corrections to the audit that these decisions rest on** (the audit overstated two things; both are being
fixed in `00-FINAL-REPORT.md` as part of Task 3.x):
1. "No ceiling at all on sequential spend" is **wrong** — a flag-independent per-employee monthly USD budget
   (`assertUnderBudget`, ~$5/employee stamped at hire) already bounds chat, `AI_STEP` and `AI_EMPLOYEE_STEP`.
   The real holes are `TOOL_ACTION`, AI Assist, the legacy generator, and the absent per-run duration cap.
2. Skills arithmetic: **43 tools / 31 real / 12 REAL skills**, not 45/30/11.

---

## File Ownership (parallel-safety)

Tasks in the same row-group touch overlapping files and **must not** run concurrently.

| Group | Owns | Tasks |
|---|---|---|
| **ENGINE** | `modules/workflows/engine/**`, `modules/workflow-runtime/**`, `workflows.service.ts` | 1.1, 2.1 |
| **ASSIST** | `modules/assist/**` | 1.2, 1.3 |
| **SKILLS** | `modules/skills/**`, `packages/types` skill DTOs | 1.4 |
| **CREDITS** | `modules/credits/**`, `common/config/credit-config.ts` | 1.5 |
| **WEB** | `apps/web/**` | 2.2–2.5 |
| **CATALOG** | `modules/{onboarding,marketplace,workflow-templates}/**`, marketing content | 2.6, 2.7 |
| **DOCS** | `docs/**`, `CLAUDE.md`, schema comments | 3.x |

`packages/types/src/index.ts` is touched by several groups — serialise those edits, and rebuild the package
after each.

---

## Phase 1 — P0: make every execution path real, authorized and honest

### Task 1.1 — Employee lifecycle enforcement 🔴 highest severity

**Spec:** `verify-02-employee-lifecycle.md` §"What the implementation plan must do", Steps 1–10.
**Decisions applied:** D1–D6.

Headline: pausing, disabling or archiving an AI Employee does not stop workflow execution today. `TOOL_ACTION`
— the node that sends email, posts publicly and charges cards — never loads the employee at all.

- [ ] **Step 1:** New pure `engine/employee-lifecycle.ts` (`EmployeeLifecycleState`, `NotWorkableReason`,
      `EmployeeNotWorkableError`, `employeeWorkableReason`, `assertEmployeeWorkable`) + its unit spec covering
      all five inputs (ACTIVE / PAUSED / DISABLED / ACTIVE-but-archived / null). Exact signatures in the spec.
- [ ] **Step 2:** Classify by type in `retry-policy.service.ts` — `instanceof EmployeeNotWorkableError` →
      `AUTHORIZATION_DENIED` (already non-retryable). Extend `retry-policy.service.spec.ts`.
- [ ] **Step 3:** Enforce at node execution across 8 sites, **including deleting the `ai-step.handler.ts`
      silent-degrade fallback** and fixing `skills.service.ts`'s `if (!employee) return null` (which currently
      means "allowed"). Add a lookup to `tool-action.handler.ts`, which has none.
- [ ] **Step 4:** Enforce at run creation in `enqueueRun` — the single chokepoint all four triggers funnel
      through — mirroring the existing User kill switch one line below. Add the per-workflow try/catch in
      `fireEvent` (D1: without it, one paused employee blocks every other workflow in the same call).
- [ ] **Step 5:** Readiness WARNING (D6), not a blocker.
- [ ] **Step 6:** Fix the two consistency misses (generator grounding query per D3; WhatsApp pinned-employee
      path).
- [ ] **Step 7:** Correct the false `EmployeeCard.tsx` copy ("It will stop working immediately") — land it
      with Steps 3–4, which make it true.
- [ ] **Step 8:** Add `status`/`archivedAt` to ~10 unit-spec mock employees **before** running anything.
- [ ] **Step 9:** New `employee-lifecycle-enforcement.e2e-spec.ts` — 11 cases, incl. the headline
      pause→409, the ACTIVE-but-archived split state a status-only check would miss, SCHEDULE stops firing,
      one paused employee not blocking others on EVENT, the templated-employeeId node-time case, exactly one
      attempt (proving non-retryable), and in-flight-not-cancelled (pinning D5).
- [ ] **Step 10:** Verify in both engine modes; commit.

### Task 1.2 — AI Assist trigger wiring

**Spec:** `verify-03` Part A (A-1…A-9). **Decisions:** D7, D8, D10, D12.

Headline: a user says "when a CV arrives by email", gets a validated, dry-run-tested, "ready" workflow — and
it is `MANUAL`, so it never fires, and nothing tells them.

- [ ] **Step 1:** New pure `engine/trigger-intent.ts` (`resolveTriggerIntent`, `collectTriggerIssues`) +
      `ASSIST_ALLOWED_EVENT_TYPES` (D8) with a spec guarding the allow-list against the real producer set.
      Make `WorkflowsService.validateTrigger` delegate to it — one rule, two callers.
- [ ] **Step 2:** Migration: `AssistSession.draftTriggerType TriggerType?` + `draftTriggerConfig Json?`.
      Author with `prisma:migrate:new`, strip any `DROP INDEX ..._embedding_idx`, apply with `prisma:migrate`.
- [ ] **Step 3:** `propose_graph` gains a required `trigger` JSON-string field, gated exactly like its five
      existing gates (return `ok:false` with a corrective sentence; never throw). Same for `patch_graph`.
- [ ] **Step 4:** Widen `CreateWorkflowDto` **and** the zod `createWorkflowSchema` with
      `triggerType`/`triggerConfig`; move `TriggerConfigDto` to a shared DTO file rather than duplicating it;
      add the missing `connectorId` to `triggerConfigSchema`. `create()` validates before writing.
- [ ] **Step 5:** `accept()` applies the persisted trigger and becomes idempotent (guarded `updateMany` claim
      on `createdWorkflowId: null`).
- [ ] **Step 6:** Prompt gains the trigger vocabulary + the server-timezone fact (there is no per-workflow
      timezone; never claim a zone we cannot set).
- [ ] **Step 7:** Readiness: MANUAL-but-references-`{{trigger.*}}` → WARNING (D10); make `describeTrigger` a
      total switch so a new trigger type is a compile error, not a silent "Manual".
- [ ] **Step 8:** Tests A-T1…A-T10, incl. the double-accept idempotency test and the end-to-end proof that an
      accepted EVENT/`NEW_EMAIL` workflow really switches inbound polling on. Commit.

### Task 1.3 — AI Assist credit metering

**Spec:** `verify-03` Part B (B-1…B-5). **Decisions:** D9, D11.

- [ ] **Step 1:** Add `CreditsModule` to `AssistModule` (verified cycle-safe) + assist token ceilings sized
      for a **whole turn** (up to 12 completions), or settlement exceeds the estimate and throws.
- [ ] **Step 2:** Reserve → run → settle/release around the turn, anchored per D9. Skip Layers 2 and 3
      deliberately (no employee, no run) **with a comment saying why**.
- [ ] **Step 3:** On insufficient credits, extend the existing graceful `stoppedBecause` union to `'credits'`
      — do not throw into an SSE stream mid-flight.
- [ ] **Step 4:** Leave the existing `UsageService.record` call untouched — ledger integration is additive.
- [ ] **Step 5:** Render `reason` in `UsageLedgerTable` so an assist row is legible instead of `— / —`.
- [ ] **Step 6:** Tests B-T1…B-T6, incl. B-T3 (two turns → two different idempotency keys), which is the test
      that catches the collision trap. Commit.

### Task 1.4 — Skill readiness honesty (Chatwoot/Plane/Postiz/WhatsApp/Gmail)

**Spec:** `verify-04` Steps 0–6. **Decisions:** D13, D14, D15, D16.

Headline: four independent surfaces all report Chatwoot/Plane as fine, and none of them ever mentions the
skill — then the first real run fails, because no code path can create the row their executors need.

- [ ] **Step 1:** Fix 2 first (smallest, isolated): `NOT_IMPLEMENTED_TOOLS` + `isNotImplemented()` +
      `ToolDefinitionDto.notImplemented`, and extend the drift guard so implementing the tool without moving
      lists fails the build. **Do not delete the executor `case`** — `default:` would delegate to the mock and
      re-introduce the silent success it was written to stop.
- [ ] **Step 2:** New `provisioning-support.ts` (`SKILL_PREREQUISITES`, all 17 keys) + the 5-assertion drift
      guard (D15) + the new types. No behaviour change yet.
- [ ] **Step 3:** New `skill-prerequisite.service.ts` (explicit `switch`, not a dynamic Prisma index — the
      dynamic form silently returns `undefined` on a typo). Wire the (A,B) projection table, the explicit
      `isBlocking` allow-list, the readiness blockers, **and the assist card filter** (without that last one,
      Chatwoot/Plane stay invisible in chat even after everything else is fixed).
- [ ] **Step 4:** Close both halves of the WhatsApp seam (D16): refuse-and-redirect on `connectSkill` **and**
      `configureSkill` (the one the UI actually reaches), plus `ctx.prerequisiteSatisfied` so the
      auto-executor stops refusing correctly-connected accounts (F3-N1).
- [ ] **Step 5:** Honest labelling where users actually look: `unsupportedTools` on the requirement DTO, one
      shared `SkillLimitationNotice`, and stop the wizard saying "ready to use" for any unverifiable skill.
- [ ] **Step 6:** Run at least one pass with `SKILL_EXECUTOR=auto` — Steps 3–4 change behaviour that is
      invisible in `mock`, which is exactly how this lie survived. Check the readiness↔publish invariant
      suite explicitly. Commit.

### Task 1.5 — Flag-independent spend ceiling

**Spec:** `verify-05` Phases 0–2. **Decisions:** D17, D18.

Close the real holes (not the overstated one): `TOOL_ACTION`, AI Assist and the legacy generator have no
flag-independent budget check; `MAX_INFLIGHT_ATTEMPTS_PER_COMPANY` is declared with zero readers; there is no
per-run wall-clock deadline.

- [ ] **Step 1:** Extend the always-on per-employee budget check to `TOOL_ACTION` and the generator.
- [ ] **Step 2:** Per-run wall-clock deadline that **excludes `WAITING`/`RETRYING`** (D18).
- [ ] **Step 3:** Either wire `MAX_INFLIGHT_ATTEMPTS_PER_COMPANY` or delete it — a declared limit with no
      reader is a false safety claim.
- [ ] **Step 4:** Add the credit/ceiling keys to `.env.example`, `turbo.json` `globalEnv` and preflight.
      Set `COMPANY_MAX_CONCURRENT_EXECUTIONS` in `setup-e2e-env.ts` (ConfigService snapshots at import).
- [ ] **Step 5:** Tests, then commit. Do not flip any `CREDIT_*` flag.

### Task 2.1 — Legacy engine: root-cause, then retire

**Spec:** `verify-01-legacy-engine.md` (pending at time of writing — **read it first**).

Two known facts: 4 e2e tests fail today under `legacy_walk` (an approved WORKFLOW approval never lets its run
complete), and `WORKFLOW_EXECUTION_MODE=inline` unconditionally forces that engine.

- [ ] **Step 1:** Read the verification report's answer to the blocking question: **can the durable state
      machine run inline?** If not, retiring `legacy_walk` also drops serverless support — that is a business
      decision to surface, not to absorb silently.
- [ ] **Step 2:** Fix the resume regression regardless of the retirement decision — it is live today.
- [ ] **Step 3:** Retire per the report's inventory, or (if inline blocks it) keep the engine and eliminate the
      *duplication* instead by making both engines share one approval gate.
- [ ] **Step 4:** Full e2e; commit.

---

## Phase 2 — P1: the honesty and reachability gaps

Each task's detail is in the referenced verify doc. Ordered by user-visible impact.

- [ ] **Task 2.2 — Product-context cache invalidation.** 22 mutation hooks need it; the house pattern already
      exists in `features/handoffs`. The already-failing `06-plan-seats-journey.spec.ts:58` **is** the
      regression test. (`verify-06` §1)
- [ ] **Task 2.3 — Marketing claim honesty.** 🧑 Includes the **"SOC 2 Compliant" / "GDPR Ready"** assertion
      that the `/security` page simultaneously contradicts with "certification, not yet held" as indexed
      schema.org — a false compliance claim on a public page, and the highest-ranked item in this group.
      Also: a second plan catalog selling 50 seats where the server allows 4; `/integrations` claiming all 14
      are shipped when 4 are simulated; the three retired `exampleWorkflow` blocks; `500+`/`12+`/`98.6%`
      figures in four files **plus an already-recorded video**; and Sales mislabelled "Coming soon" though 2
      templates shipped. Copy changes need human sign-off — prepare them, do not publish unilaterally.
      (`verify-06` §6)
- [ ] **Task 2.4 — Delete safety.** Wire both orphaned dependency endpoints into real confirmation dialogs;
      `DeleteDepartmentDialog.tsx` is the precedent with a test file to copy. Note there is no employee
      hard-delete UI at all, and no workflow dependency endpoint exists. (`verify-06` §2)
- [ ] **Task 2.5 — Employee → workflows view.** Expose the existing private query; must apply
      `authz.filter(actor, 'workflow:read', …)` or it re-opens the WAVE-2 name leak. Reconcile the backend
      substring match with the frontend `deriveEmployees`, which disagree on which node types bind an
      employee. (`verify-06` §3)
- [ ] **Task 2.6 — RECRUITER/HR template mapping.** Widen the candidate-facing HR templates to accept
      `RECRUITER`, and check every other role for the same latent mismatch. (`verify-07` §2)
- [ ] **Task 2.7 — Employee runtime config audit.** 🧑 Wire or honestly demote `workingHours`, `timezone`,
      `language`. A field whose UI copy promises behaviour the runtime doesn't implement is a misleading
      setting; the choice between implementing and demoting each is a product call. (`verify-07` §3)
- [ ] **Task 2.8 — AI Employee catalog consolidation.** First settle whether `@vaep/types` is importable from
      both sides (it almost certainly is, which would make the "unavoidable duplication" comment false and the
      fix small). (`verify-07` §1)
- [ ] **Task 2.9 — `MarketingConsent` write path.** 🧑 Either wire it or deprecate the tool — today
      `check_consent` can never report "consented", in any environment. (`verify-07` §6)
- [ ] **Task 2.10 — Postiz provisioning honesty.** Keep the operator prerequisite, but stop the UI implying
      self-service. (`verify-04` §1.4)

---

## Phase 3 — Cleanup, guards, and documentation truth

- [ ] **Task 3.1 — Provider boot guards** for `EMBEDDINGS_PROVIDER` and `STORAGE_PROVIDER`, the only 2 of 5
      seams with neither a boot guard nor a preflight check. 🧑 Decide hard-fail vs warn: a hard fail could
      break a deployment running fine on `hash` today. Recommended: **warn in preflight, hard-fail only for
      `STORAGE_PROVIDER=local` on serverless**, where blobs silently vanish between invocations.
- [ ] **Task 3.2 — Delete proven-dead code.** `BrandAsset` (needs a migration), `FaceMesh.tsx`, and
      `DisabledControl.tsx` (delete-or-narrow: three hand-rolled implementations of its doctrine exist, but
      four of five candidate sites are menu items, not controls). Keep the self-documented `DemoPlayer`.
- [ ] **Task 3.3 — Reserved queues.** Give `wf-compensate`/`wf-dlq` the same explicit "RESERVED, NOT WIRED"
      comment block `engines/support` already uses, or remove them.
- [ ] **Task 3.4 — Documentation truth.** Delete/replace the six stale "not yet enforced" comments (all six
      describe already-shipped enforcement); fix CLAUDE.md's "22 templates" (it is 24), its stale RETRIEVE-node
      claim, and its "both modes 465/465" testing claim; correct the two audit errors named in the Decisions
      Register; and remove the stale `/marketplace` "Workflow Templates" empty section.
- [ ] **Task 3.5 — Final verification + regression matrix + report** per the request's §32–§34.

---

## Verification Protocol (every task)

1. `pnpm --filter @vaep/types build` if types changed.
2. `pnpm typecheck && pnpm -w run lint`.
3. Affected unit specs, then the full unit suite (`pnpm run test:unit --maxWorkers=2` from `apps/api`).
4. Affected e2e, then the full pinned e2e suite — **both engine modes** until Task 2.1 lands.
5. One `SKILL_EXECUTOR=auto` pass for Task 1.4.
6. Playwright for anything user-visible; check for and kill leftover dev servers first (they consume BullMQ
   jobs with stale code), and `git checkout -- e2e/test-results/` afterwards.
7. Baseline to beat: **110/110 unit suites (1139 tests)**, **103/103 e2e suites (767 tests) in
   `state_machine`**, **99/103 in `legacy_walk` (4 known failures — Task 2.1 must fix these)**, **13/14
   Playwright (1 known failure — Task 2.2 must fix it)**.

## Explicitly out of scope

Not required by any verified P0/P1, and excluded to keep the change set reviewable: semantic memory ranking;
a real WhatsApp provider adapter (D16 sequences it later); implementing Chatwoot/Plane provisioning;
multi-origin CORS; durable/resumable WAIT; enabling credit enforcement (D17); connector webhook
timestamp/nonce replay bounds.
