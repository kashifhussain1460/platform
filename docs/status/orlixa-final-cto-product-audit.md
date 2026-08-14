# Orlixa — Final CTO / Product Forensic Audit

**Date:** 2026-08-14
**Type:** Forensic audit. Read-only. No code was changed, no dependency installed, no migration created.
**Repository state audited:** `d:\Vertical AI\platform`, working tree as-is (233 modified/untracked files), plus `master` @ `73b5937`, `origin/deployment` @ `3e7fa5c`.
**Engine freeze respected:** the 7 paused engines (n8n, Metabase, Meilisearch, Novu full, Listmonk, Keycloak, MinIO) are **not** counted against any score.

---

## 0. How to read this report

Documentation was treated as *intent*, not fact. Every claim below is backed by one of:

| Evidence class | What I did |
| --- | --- |
| **Ran it** | Executed the unit suite myself: **574 tests / 65 suites, all pass** (`jest --config test/jest-unit.json`, 37s). This is the only test evidence I produced first-hand. |
| **Read the code** | Traced the actual execution paths, guards, defaults and fallbacks in `apps/api/src` (438 files, ~46.5k lines) and `apps/web/src`. |
| **Compared git to disk** | Checked which files exist in the deployed commits versus only on disk. This produced the single largest finding. |
| **Read the docs** | The four named plans plus 30+ architecture/status/verification docs — used to find *claims to test*, never as proof. |

**What I could NOT verify first-hand, and am not claiming:**

- The 465-test API e2e suite. It needs Postgres + Redis and writes many rows to a shared dev database that holds ~44 real tenants. Running it would have been a side-effecting act during an audit-only mandate. I read the specs and CI config instead.
- The 7 Playwright browser journeys. Same reason. **Note:** `test-results/` on disk contains one *failed* browser run (`02-security-journey` → "a MEMBER cannot reach the HR area", failed 2026-08-14 00:20 with a `429 ThrottlerException` during login). The failure looks environmental (rate limit) rather than a product defect, but the last browser evidence on disk is a **failure**, not the claimed 7/7 pass.
- Any live production environment.

**One source document does not exist.** `orlixa-frontend-cto-implementation-plan.md` is named as a dependency by the UX simplification plan and by your audit brief. It is **not in the repository**. The nearest real documents are `docs/architecture/frontend/2026-08-01-frontend-architecture.md` and workflow-system docs 15 / 29 / 31. The frontend "authority" the plans point at is missing.

---

## 1. Direct answers to your twelve questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | How many gaps remain? | **47** in current scope (paused engines excluded): **8 P0**, **19 P1**, **14 P2**, **6 P3** |
| 2 | % production ready | **≈50%** (weighted, P0-capped) |
| 3 | % business logic correct | **≈63%** |
| 4 | % of original product goal achieved | **≈56%** |
| 5 | How much remaining | ~14% of *functionality*; ~50% of *production safety*; ~44% of the *mission* |
| 6 | Which missing functionality is necessary | The 8 P0s + P1-1, P1-2, P1-9, P1-10, P1-11 (see §10) |
| 7 | Which existing functionality is wrong | 6 items, §7 |
| 8 | Which is UI-only / mock / fake | 11 items, §8 |
| 9 | Implemented but unsafe for enterprise | 9 items, §9 |
| 10 | Exact P0 blockers | 8, §10 |

**Functional completeness** (does the planned thing exist at all?) is genuinely high: **≈86%**. The gap between 86% completeness and 50% production readiness is the whole story of this audit — Orlixa is a **well-built system that is not switched on**.

### The one-paragraph verdict

Orlixa is an unusually well-engineered codebase — the reasoning in the comments is better than most production systems I have read, the hash-chained audit log and the approval gate are genuinely enterprise-grade, and the self-audits in `docs/status/` are honest to the point of being uncomfortable. But **the version of Orlixa that a customer would actually touch is not the version described in those documents.** Everything Waves 1–9 delivered — the authorization layer, observability, tracing, retention, the audit hash chain, alerting, the Plane engine, the simplified workflow UX — exists **only as uncommitted files on one developer's disk**. On top of that, the shipping deployment shape (Vercel serverless) *refuses the durable runtime by construction*, and four provider defaults (`SKILL_EXECUTOR`, `MAIL_ENABLED`, `EMBEDDINGS_PROVIDER`, `STORAGE_PROVIDER`) fall back to offline/fake behaviour with **no production guard**, so a correctly deployed-looking Orlixa can report success while doing nothing at all — and, in the case of the mail default, while letting anyone take over any account.

---

## 2. Part 1 — What Orlixa is supposed to be, scored against itself

The goal is *"a company can safely delegate real business work to AI Employees, and Orlixa can execute that work reliably, securely, auditably and recoverably."*

| Pillar | Verdict |
| --- | --- |
| **Delegate** — create an employee, give it knowledge/skills, describe the work | ✅ Largely achieved. This is the strongest part of the product. |
| **Execute real work** | ⚠️ Partly. 9 of 14 skills have real executors; the other 5 silently fake success. Inside a workflow the AI Employee has **no tools at all** by design — it drafts, and a human-authored `TOOL_ACTION` node acts. |
| **Reliably** | ❌ Not in the shipping shape. The durable runtime is real, tested and unreachable on Vercel. A crash mid-run kills a half-executed workflow permanently. |
| **Securely** | ⚠️ Strong primitives (AES-GCM, PKCE, SSRF blocklist, tenant-aware throttling, hash-chained audit). Undermined by config defaults and the absence of MFA/SSO. |
| **Auditably** | ✅ Genuinely good — 40+ audited actions, tamper-evident chain, retention, legal hold. Weakest at *execution* audit. |
| **Recoverably** | ❌ Not in the shipping shape. No compensation, no step retry, no resume after crash. |

---

## 3. Part 3 — Product inventory

### Scale (measured)

| Metric | Count |
| --- | --- |
| Backend modules | 30 |
| Controllers | 40 |
| Prisma models | 61 |
| Migrations (working tree) | 52 |
| Workflow node types (all with real handlers) | 19 |
| Skills in catalog | 14 (~50 tools) |
| Skills with a real executor | 9 (23 tools) |
| First-party workflow templates | 22 (11 HR + 11 Marketing) |
| Frontend pages | 33 |
| Frontend features | 19 |
| Unit tests | **574 / 65 suites — verified green by me** |
| API e2e specs | 71 |
| Browser journeys | 3 |

### A–X capability matrix

Legend: ✅ real and wired · ⚠️ real but gated/partial/unwired · ❌ absent or fake

**A. Authentication** — Signup ✅ · Login ✅ (multi-tenant, ACTIVE-only) · Logout ✅ (real cookie-clearing endpoint) · Session ✅ (JWT + refresh rotation + revoke-all) · Password recovery ⚠️ **see P0-1** · Email verification ⚠️ **see P0-1** · MFA ❌ *(none — and honestly refused: `assertPolicyIsEnforceable` throws if you try to turn it on)* · Disabled users ✅ (kill switch tested) · Session expiry ⚠️ (`sessionTimeoutMinutes` stored, never read) · Auth audit ✅

**B. Organization** — Company ✅ · Departments ✅ · Teams ⚠️ (exist as grant subjects only; **team isolation formally NOT SUPPORTED** by decision) · Users/Roles ✅ · Permissions ⚠️ (two systems, §7) · Membership ✅ · Invitations ⚠️ (create user works; **email invites not built**) · Access policies ⚠️ (department isolation is **opt-in and configured for nobody**) · Tenant isolation ✅ (dedicated e2e suite; absolute first check in the policy)

**C. Onboarding** — Company setup ✅ · First user ✅ · Org setup ✅ · Department ⚠️ · Team ⚠️ · AI Employee setup ✅ · **Skill setup ❌** · **Knowledge setup ❌** · **First workflow ❌**
→ **Onboarding does NOT reach a first meaningful workflow.** The wizard is 3 steps: company profile → pick employee roles → business goals. A customer finishes onboarding holding an AI Employee with no connections, no knowledge and no automation. *(P1-11)*

**D. AI Employees** — Create/Read/Update/Delete ✅ · Pause/Resume ✅ (409 when paused) · Chat ✅ (plan → retrieve → memory → act → validate) · Knowledge ✅ (role-scoped) · Memory ✅ (recency-based; **no semantic recall**) · Skills ✅ (company-wide or per-employee) · Workflows ✅ · Permissions ⚠️ · Activity ✅ · Analytics ⚠️ (§8) · Audit ✅
→ **Is the AI Employee a real execution actor?** In **chat**: yes — it calls real tools through a bounded ACT loop with a high-risk approval gate. In a **workflow**: no. `ai-employee-step.handler.ts` runs with `disableTools: true` on purpose (doc 27 §0.3), so a prompt-injected instruction has no tool to abuse. Every side effect is an explicit human-authored `TOOL_ACTION`. This is a *good* safety decision, but it means "your AI Employee does the work autonomously" is only true of chat.

**E. Skills** — Catalog ✅ · Connection ✅ · **OAuth ✅ genuinely good** (HMAC-signed one-time state, PKCE per RFC 7636, nonce consumed atomically, open-redirect guard on `returnTo`) · Scopes ✅ (6 providers mapped) · Health ✅ (state machine + probes + single-flight refresh + auto-`markDisconnected`) · Reconnect/Disconnect ✅ · Employee & company assignment ✅ · Authorization ✅ · Credential security ✅ (AES-GCM, prod key guard, redaction) · **Execution ⚠️ — see P0-3 and P0-4**

**F. Knowledge** — Upload ✅ · Storage ⚠️ **see P0-5** · Ingestion ✅ (BullMQ extract→chunk→embed) · Indexing ✅ (pgvector 384-dim HNSW) · Retrieval ✅ · Search ✅ (tenant-scoped cosine) · Permissions ✅ (per-role category scoping) · Company/Dept/Team/Employee scope ⚠️ (role-based, not department/team) · Failure/Retry ✅ · Deletion ✅ · Retention ✅ (rows **and** blobs)
→ **Is knowledge used during real workflow execution?** Yes — `RETRIEVE` node and `AI_EMPLOYEE_STEP` both hit it. **But** the `RETRIEVE` node is *deliberately unscoped* (company-wide), so a Marketing workflow can retrieve HR documents. Documented, but it is a real cross-department leak path. And with the default `hash` embeddings the "semantic" search is bag-of-words (*P1-7*).

**G. Memory** — Storage ✅ · Retrieval ✅ · Employee isolation ✅ · Tenant isolation ✅ · Permissions ✅ · Retention ✅ · Deletion ✅ · Runtime usage ✅ (`MEMORY_READ`/`MEMORY_WRITE` nodes + chat recall)
→ **Does memory influence execution?** Yes, genuinely. Caveat: recall is recency-ordered, so learned FACTs get crowded out past the limit — semantic recall is still unbuilt.

**H. Workflows** — Create ✅ · AI Assist generation ✅ · Manual ✅ · Draft + autosave ✅ · Edit ✅ · Validation ✅ · Publish ✅ · **Immutable version ✅** · Activate ✅ · Pause ✅ · Archive ✅ · Version history ✅ · Compare ❌ · Restore ❌ · Run Now ✅ · Schedule ✅ · Webhook ✅ (signed, deduped) · External Event ⚠️ (Plane/Chatwoot/GitHub/generic yes; **Postiz no**)

**I. Workflow execution** — see §5. `WorkflowRun` ✅ · `WorkflowStepRun` ✅ · Attempt ⚠️ (durable-only) · Queue ✅ · Worker ⚠️ (absent on Vercel) · Lease ⚠️ · Retry ⚠️ · Timeout ✅ (now genuinely *aborts* the model call, not just abandons it) · Cancellation ✅ · Recovery ⚠️ · Reaper ⚠️ · Idempotency ✅ (run-level, unique on `companyId+idempotencyKey`) · Duplicate trigger protection ✅ · **Duplicate side-effect protection ⚠️** · Crash recovery ❌ *on the shipping path*

**J. AI Assist** — Prompt ✅ · Intent ✅ · Generation ✅ · Modification ⚠️ (new drafts only; **no diff-on-existing-workflow**) · Draft ✅ · Validation ✅ · Skill selection ✅ (+ in-chat connect card + OAuth `returnTo` auto-resume) · Schedule generation ✅ · Approval inference ✅ · Human review ✅ · Version creation ✅ · **Safety boundaries ✅ — verified**: the only write tools are `propose_graph`, `request_connection`, `patch_graph`, `finish`, and all of them write to `AssistSession.draftDefinition`. **Nothing in the Assist agent can reach a real `Workflow` row.** Dry-runs use throwaway `isAssistScratch` workflows excluded from every list. The chain `Assist → Draft → Review → Publish → Immutable Version → Activate` is intact.

**K. Workflow UX** — Against `orlixa-workflow-ux-simplification-cto-plan.md`: **implemented and correct.** All six ceremonies you asked me to look for are gone from the customer path: no "Accept AI Draft" (auto-creates on stream completion), no separate Validate (`GET /:id/readiness` runs the *same* validator publish uses), no Activate wizard (`publish { activate: true }`), no Schedule wizard (`ScheduleFields` inline, `/schedules` derived not stored), no manual version creation, no Save-Draft ceremony (autosave + status pill). Backend safety machinery is fully retained. The `ready === (publish would succeed)` invariant is pinned by a test that literally asserts readiness agrees with publish. **This is the best-executed plan in the repository.**

**L. Scheduling** — Trigger ✅ · Timezone ⚠️ (server-tz only; UI states the zone) · Next/Last run ✅ · Pause/Resume ✅ · Idempotency ✅ · Duplicate protection ✅ (the inline double-fire bug is fixed — `addSchedule` no-ops inline) · Schedule→Run ✅ · Durable Timer ⚠️ (durable-only) · Wait/Resume state ⚠️
→ **The critical distinction is correctly implemented.** `Workflow Schedule` creates a **new** `WorkflowRun` (`trigger()` → `workflowRun.create`). `Durable Timer` resumes an **existing** run (`timer.processor.ts` → advance). Two different queues, two different code paths, no confusion between them.

**M. Approval** — Request ✅ · Routing ✅ (USER/ROLE/DEPARTMENT/TEAM/EMPLOYEE_MANAGER/ANY_ADMIN) · Person/Team/Dept ✅ · Escalation ✅ · SLA ✅ (5-min sweep, `onTimeout` defaults to `NONE`, never auto-approve) · Waiting state ✅ · **Restart survival ✅** (DB row, not memory; proven by a recorded process-kill drill) · Approve/Reject/Resume ✅ · Audit ✅ · Authorization ✅ (`canDecide`, rule-specific, no OWNER override)
→ **Can a high-risk action bypass approval?** Not for the tools classified high-risk — and the gate is byte-compatible across both engines so an approval straddling a rollout still resumes. **But only 3 of ~50 tools are classified `highRisk`** (`stripe.create_payment_link`, `postiz.schedule_post`, `postiz.publish_now`). `gmail.send_email`, `slack.send_message`, `plane.create_issue`, `chatwoot.reply_to_conversation` and **`http.request` (arbitrary outbound egress)** run in a workflow with **no gate** unless the author placed an `APPROVAL` node or the employee has `requireApprovalForAllTools`. There is no company-level "require approval for all external actions" policy. *(P1-6)*

**N. External actions** — For every side effect: Authorization ✅ · **Idempotency ❌ except Postiz publish** · Retry ⚠️ · **External request ID ❌ (no such field anywhere)** · Reconciliation ⚠️ (Postiz only) · Audit ✅ (`SkillExecution` per call) · Failure classification ✅
→ **The scenario you asked about — provider succeeds, worker crashes before persisting:** On the **durable** path this is handled well: the expired lease is marked `outcomeUnknown` and deliberately **never auto-retried**, so no duplicate. On the **shipping** path (legacy walk, inline) there is no attempt row, no lease and no `outcomeUnknown`. The run-level atomic claim (`updateMany WHERE status='PENDING'`) stops the *whole run* re-running, so you do **not** get a duplicate — you get something arguably worse: the run sits `RUNNING` until a 10-minute watchdog marks it `FAILED` with *"Orphaned: likely a worker restart mid-execution"*. The three emails already sent stay sent, nothing records which steps completed externally, and there is no resume and no compensation.

**O. Events** — Webhook ✅ · Signature verification ✅ · Raw event ✅ · Deduplication ✅ (including the sharp case: a replay with a *mutated delivery header* is still deduped) · Tenant resolution ✅ · Canonical event ✅ · Trigger matching ✅ · Durable run creation ⚠️ (created, executed on the legacy walker) · Recovery ⚠️
→ **Per provider:** Plane ✅ through `CanonicalIngestService`. Chatwoot ✅ through `CanonicalIngestService`. **Postiz ❌ — it bypasses the spine entirely.** `MarketingWebhookController` is a *publicly reachable no-op* that logs and returns `{ok:true}`; the honest comment explains why (Postiz's webhook is unsigned, so a DB write there would let anyone flip any company's post status). The real source of truth is a 10-minute reconcile sweep. So a Marketing workflow **cannot be triggered by "post published/failed"** at all. *(P1-8)*

**P. Audit** — Coverage across auth, permission changes, employee lifecycle, skill lifecycle, connector lifecycle, workflow lifecycle, approval, knowledge, HR, billing, admin, security: ✅ 40+ actions. **Execution ⚠️** — only `workflow.run.cancel` reaches `AuditLog`; node-level execution lives in `WorkflowRun`/`StepRun`/`Attempt`, which are operational tables **outside the hash chain**. Fields WHO/WHAT/WHEN/WHERE/WHY/RESOURCE/CORRELATION ✅. **BEFORE/AFTER ⚠️** — captured for some actions (revoke reads the row before deleting it, which is the right instinct) but not systematically. Append-only ⚠️ *by convention* — nothing in the DB prevents an UPDATE; the hash chain makes it **detectable**, which the code honestly says is the achievable property. Tamper evidence ✅ (`GET /audit-log/verify`). Retention ✅. Export ✅. Legal hold ✅.

**Q. Observability** — Structured logs ✅ · Metrics ✅ (13 series, hand-rolled Prometheus registry) · Traces ✅ (OTel SDK imported *first* in `main.ts` so auto-instrumentation still has something to patch; inert without an OTLP endpoint) · Correlation IDs ✅ · Alerts ⚠️ · Queue/Provider/OAuth/Outbox monitoring ✅ · Execution tracing ⚠️
→ **Correlation chain:** `requestId` ✅ `traceId` ✅ (correctly bridged to the *OTel* trace id — an earlier version minted its own UUID so logs and spans could never find each other) `companyId` ✅ `userId` ✅ `employeeId` ✅ `workflowId` ✅ `workflowVersionId` ⚠️ `workflowRunId` ✅ `stepRunId` ✅ `attemptId` ✅ **`skillExecutionId` ❌ `externalRequestId` ❌** — neither exists in `ExecutionContext`.
→ **Can an operator trace a customer-visible failure to the exact provider failure?** To the failing **step and attempt**, yes. To the **exact provider request**, no — there is no external request id to correlate on. And in production nothing scrapes `/admin/metrics` and no OTLP endpoint is configured, so all of this is capability, not operation.

**R. Realtime** — Chain is `Worker → Outbox → Relay → SSE → Frontend`. Built: outbox table ✅, relay ✅, sink registered ✅ (`workflow-runtime.module.ts:96`), Redis pub/sub fan-out for multi-instance ✅, `@Sse(':id/stream')` ✅, `history()` + `seq` gap detection ✅. **Not delivered:**
  1. The outbox is written **only** by `RunStateWriter` — i.e. the durable path, which is off in production.
  2. `relayOnce()` is called from **exactly one place**: `timer.processor.ts`, a BullMQ processor. With `QUEUE_WORKERS_ENABLED=false` on Vercel, **the relay never runs.** There is no `/admin/cron/outbox-relay` route.
  3. `prunePublished()` is called from **nowhere** — dead code, so the outbox has no pruning path.
  4. No frontend code consumes the SSE stream. The UI polls at 1000ms (`features/workflows/hooks.ts:566`).
  → Realtime is **0% delivered end-to-end** despite the backend being ~90% built. *(P1-5)*

**S. Analytics** — Runs / success rate / failure rate / duration / retries ✅ from real `WorkflowRun` data. Approval wait ✅. Usage ✅. AI usage + cost ✅ (real token accounting via `UsageService`, and **per-employee `budgetLimit` is genuinely enforced** in both chat *and* `AI_STEP` — a workflow cannot be used to route around it). Reliability ✅. Employee performance ✅ (goals/KPI attainment). **"Value" tiles ❌ fabricated** — `MINUTES_SAVED_PER_TASK = 10`, `HOURLY_RATE_USD = 25`, hardcoded and multiplied into a dollar figure. *(P1-15)*

**T. Billing / entitlements** — Plans ✅ · Seats ❌ · AI Employees ❌ · Workflow runs ❌ · AI usage ❌ · Storage ❌ · Integrations ❌ · Entitlements ⚠️ · **Enforcement ❌**
→ The code says it plainly: *"Plan limits are SOFT — usage is informational only"* and *"`maxEmployees: null` means unlimited. Limits are informational — never enforced."* The only real enforcement anywhere is **plan-tier gating on 2 routes** (`@RequirePlan('BUSINESS','ENTERPRISE')` on AI Assist and `/workflows/generate`).
→ **Answer to Scenario 12:** a company doesn't need to bypass anything via the API — nothing is enforced in the UI either. A STARTER tenant can create unlimited employees, workflows and runs. *(P1-2)*

**U. Security** — Tenant isolation ✅ · Authorization ⚠️ (two systems) · OAuth state ✅ · Nonce ✅ · PKCE ✅ · Redirect validation ✅ · Scopes ✅ · Secret encryption ✅ · Secret redaction ✅ · Rate limits ✅ · **Tenant-aware rate limits ✅ and correctly reasoned** (fails *closed* to IP when the JWT is unverified, because an unverified `companyId` lets an attacker both escape their own bucket and exhaust a competitor's) · DNS rebinding ✅ (`assertUrlAllowed` re-resolves and blocks private/link-local/`169.254.169.254`) · Response size limits ✅ · High-risk action protection ⚠️ (3 tools) · Input validation ✅

**V. Data governance** — Workflow retention ✅ · Audit retention ✅ · Knowledge retention ✅ (rows **and** blobs) · Memory retention ✅ · HR retention ✅ (satellites only, roster never pruned) · Attachment retention ✅ · Deletion ✅ · Archive ✅ (terminal runs archived before delete) · Legal hold ✅ (generalised + scoped). **10 data classes covered. This is the most complete domain in the product.**

**W. DR / Recovery** — Database backup ✅ (`infra/backup/backup.sh` + `restore.sh` + `verify.sh`) · **Restore ✅ genuinely proven** (14 tables matched exactly, 664 objects, measured 2s/4s) · Redis recovery ⚠️ · Worker recovery ⚠️ · Workflow recovery ❌ *shipping path* · Lease recovery ⚠️ · Reaper ⚠️ · Duplicate job ✅ · Duplicate webhook ✅ · Provider timeout ✅ · OAuth expiry ✅ · **Deployment during execution ❌** (on Vercel a deploy mid-run orphans the run) · RPO ⚠️ (24h documented; 5-min needs PITR, **not enabled**) · RTO ✅ (1h from a measured restore)
→ Backup/restore is **not** just "backup code exists" — it was actually exercised. Credit where due. The gap is scheduling, PITR and secret custody.

**X. Frontend** — 33 pages. Per-feature:

| Feature | UI | API wired | Backend | Authz | Real data | Error | Loading | Empty | Runtime verified | Browser E2E |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Auth | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | ✅ | ✅ |
| Onboarding | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | ✅ | ✅ |
| AI Employees | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Skills / Connections | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Knowledge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Memory | ⚠️ (in employee page) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| Workflow Builder | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| AI Assist | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Workflow Versions | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| Workflow Runs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Approvals | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Activity | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Notifications** | **❌** | ❌ | ✅ | — | — | — | — | — | ❌ | ❌ |
| Audit | ⚠️ (a section inside `/organization`, no dedicated page) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| Analytics | ✅ (via `/dashboard`) | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Organization / RBAC | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Connector Health | ✅ (in Skills) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| System Health | ✅ (`/admin/health`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| Billing | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **HR (6 controllers, encrypted PII)** | **❌** | ❌ | ✅ | ✅ | — | — | — | — | ❌ | ⚠️ (a test asserts a MEMBER *cannot reach* it) |
| **Workflow Permissions** | **❌** | ❌ | ✅ | ✅ | — | — | — | — | ❌ | ❌ |
| **Retention / Legal hold** | **❌** | ❌ | ✅ | ✅ | — | — | — | — | ❌ | ❌ |
| Realtime | ❌ | ❌ | ⚠️ | — | — | — | — | — | ❌ | ❌ |

**Four whole backend domains have no user interface**: HR (6 controllers, encrypted special-category PII, retention sweep), Workflow Permissions (the enterprise access-control layer), Retention/Legal Hold, and Notifications. They are reachable only by hand-crafted API calls.

---

## 4. Part 2 — Engine freeze compliance

✅ **Fully respected, and I have not penalised the score for the paused engines.**

| Engine | State | Depends on it? |
| --- | --- | --- |
| Postiz | Active, real client, real reconcile loop, adapter | Marketing templates do |
| Chatwoot | Active, real client, signed webhook → canonical spine | Support templates do |
| Plane | Active, real client, signed webhook → canonical spine | PM tools do |
| n8n / Metabase / Meilisearch / Novu-full / Listmonk / Keycloak / MinIO | Paused | **No existing functionality depends on any of them** |

Two nuances worth stating:
- **Novu's carve-out was honoured correctly.** The `NOTIFY` capability was fixed for real (`NotificationsService.workflowNotify` genuinely sends and returns a reason when it can't) without building the engine.
- **Keycloak's early-exit condition has arguably been met.** The rule was "may move earlier for a real enterprise SAML/OIDC requirement." There is no MFA and no SSO anywhere in the product. If an enterprise deal is in play, that is the trigger — but it is a *product decision*, not a spine gap, so I am recording it as P1-1 rather than reopening the freeze.
- I make **no** recommendation to unfreeze anything. §12 sequences spine work only.

---

## 5. The execution-path question (your most important one)

I traced every entry point.

| Entry point | Path taken | Durable? |
| --- | --- | --- |
| Manual run (`POST /workflows/:id/run`) | `enqueueRun` → `dispatchRun` → **inline forces `legacy_walk`** | ❌ |
| Schedule fire | cron → `trigger()` → creates run → `execute()` → `usesStateMachine` re-checked → **inline forces `legacy_walk`** | ❌ |
| Webhook (public token) | `runFromWebhook` → `dispatchRun` | ❌ |
| External / canonical event | `fireEvent` → `dispatchRun` | ❌ |
| API invocation | same as manual | ❌ |
| AI Employee (chat) | `AgentRuntimeService` — a **separate** runtime, not the workflow engine at all | n/a |
| Approval resume | `resumeRun` → `RunStateWriter` → `dispatchRun` | ❌ |
| Retry | starts a **fresh run** (not a step retry) → `dispatchRun` | ❌ |

**`engine-mode.ts` now defaults to `state_machine`** — that was fixed and is genuinely the right default (a safety feature that is off by default is a feature nobody has). But:

```ts
modeFor(companyId) {
  if (isInlineExecution()) return 'legacy_walk';   // ← Vercel lands here, always
  ...
}
```

And the shipping deployment is Vercel serverless (`apps/api/vercel.json`, 10 cron entries, `maxDuration: 300`, HTTP-only entry at `api/index.ts`). `WORKFLOW_EXECUTION_MODE=inline` + `QUEUE_WORKERS_ENABLED=false` is the documented shape for it. The constructor logs a loud error about this, which is the honest thing to do — but a loud log is not a durable runtime.

**So: no production run anywhere uses the durable runtime. → P0-2.**

Consequences on the shipping path:
- No `WorkflowStepAttempt` rows → no attempt history, no per-step retry, no lease.
- The **reaper never fires** (`ReaperService` requires `attempts: { some: {} }`).
- The **watchdog kills** instead (`attempts: { none: {} }` → `FAILED`, *"Orphaned…"*). The two sweeps are correctly kept from fighting each other — but the one that runs is the one that destroys, not the one that recovers.
- `PARALLEL` and `LOOP` are walked by **recursive in-process calls**, so parallel lanes are actually **sequential** and a crash loses every lane. On the durable engine they are real independent attempts. **Two engines, two different semantics, and the customer gets the weaker one.** *(P1-14)*
- No outbox writes → the realtime chain has nothing to carry.

---

## 6. Part 4 — Business logic scorecard

| Domain | Expected | Actual | Verdict | Evidence | Business impact |
| --- | --- | --- | --- | --- | --- |
| AI Employee | An employee that does work | Real actor in chat; **recommend-only in workflows** (`disableTools:true`) | **Partial** | `ai-employee-step.handler.ts:108-116` | The core pitch is half-true; a human must author every action |
| Skill assignment | Assigned skill executes for real | Company + per-employee resolution correct; **execution defaults to mock** | **Incorrect (config)** | `skills.module.ts:57` | Workflows report success having done nothing |
| Knowledge access | Employee reads only what it may | Role scoping real and tested; **`RETRIEVE` node company-wide by design** | **Partial** | `retrieve.handler.ts`, CLAUDE.md | Marketing workflow can read HR docs |
| Memory | Influences behaviour | Yes, both nodes + chat recall | **Correct** | `memory.handlers.ts`, `memory.service.ts` | — |
| Workflow creation | Describe → working automation | Assist + manual both land on one model; safety chain intact | **Correct** | `assist-write-tools.ts` | — |
| Workflow scheduling | Schedule creates a NEW run | Correct, and distinct from timers | **Correct** | `trigger()` vs `timer.processor.ts` | — |
| Workflow versioning | Runs pinned to a frozen version | `workflowVersionId` pinned at enqueue; engine reads the version's definition | **Correct** | `workflows.service.ts:943`, `workflow-engine.service.ts:380` | — |
| Workflow execution | Durable, recoverable | Durable engine correct but **unreachable**; legacy walker ships | **Incorrect (deployment)** | `engine-mode.ts:74` | Half-executed workflows die permanently |
| Approval | Risky work needs a human | Routing, SLA, escalation, restart-survival all correct; **only 3 tools auto-classified risky** | **Partial** | `tool-approval-policy.ts`, catalog | Email/Slack/arbitrary HTTP ungated by default |
| External action | Exactly once, reconcilable | Idempotency **only** on Postiz publish; no external request id anywhere | **Partial** | `real-skill-executor.ts:814` | Cannot prove what happened at the provider |
| Retry | Safe, targeted | Run-level only, starts fresh — the UI does say so | **Partial** | `POST /workflows/runs/:id/retry` | Re-running a partly-done workflow can double side effects |
| Failure | Classified and explained | `failureClass`, `RunFailureCard`, timeline all real | **Correct** | `features/workflows` | — |
| Reconciliation | Local truth matches provider | Postiz only | **Partial** | `marketing-sync.service.ts` | Other providers can drift silently |
| Audit | Who/what/when, tamper-evident | 40+ actions, hash chain verified live | **Correct** (execution partial) | `audit-chain.ts` | — |
| Permissions | Enforced at the right layer | RUN at enqueue ✅; **per-attempt node PDP deferred**; two overlapping systems | **Partial** | `authorization.policy.ts`, `workflow-permissions` | Divergent floors invite privilege escalation |
| Organization | Departments/teams safely separated | Department isolation **opt-in, configured for nobody**; team isolation **NOT SUPPORTED** | **Partial** | `authorization.policy.ts:20-28` | "Enterprise multi-department" is capability, not state |
| Billing | Plan limits hold | Tier gate on 2 routes; **nothing else enforced** | **Missing** | `billing.plans.ts:74` | Unbounded cost exposure per tenant |
| Analytics | Real execution data | Counts/rates/durations/cost real; **ROI tiles fabricated** | **Partial** | `analytics.constants.ts:9-10` | Made-up savings shown to a customer |
| Notifications | Reach a person | `workflowNotify` really sends and reports why not; **no UI** | **Partial** | `notifications.service.ts:214` | In-app notification centre doesn't exist |

---

## 7. Part 5 — The twelve business scenarios

| # | Scenario | Verdict |
| --- | --- | --- |
| 1 | MarketingAI + Postiz + knowledge + workflow — can it do the work? | **Partly.** Postiz has a real client and real publish/schedule with an idempotency key, and both are `highRisk` so they gate for approval. Marketing knowledge is retrievable. **But** `SKILL_EXECUTOR` must be set to `real`/`auto` or nothing happens; the AI Employee cannot publish itself (recommend-only); Postiz emits no events so nothing can react to "published"; and post status arrives via a 10-minute sweep. |
| 2 | *"Every Monday publish a social campaign after manager approval"* | **Mostly yes.** Assist generates SCHEDULE + employee + skill + action + approval, validates against the frozen node vocabulary and the tenant's real skills/employees, and dry-runs. Execution: the schedule fires via Vercel cron, `postiz.schedule_post` gates on `highRisk`, routing finds the manager, SLA escalates. **Caveats:** server timezone only, and the run executes on the legacy walker with no durability. |
| 3 | Active v12, user edits — is the in-flight run pinned? | **✅ Correct.** In-flight run keeps `workflowVersionId` = v12 and the engine reads *that version's* definition. A new run after publish gets v13. Versions are frozen `PUBLISHED`. |
| 4 | Worker crashes while waiting for approval | **✅ Correct.** Approval state is a DB row, not memory. Proven by a chaos test *and* a recorded real process-kill drill; resumed exactly once. The gate writes byte-compatible rows in both engines so an approval can straddle an engine rollout. |
| 5 | Provider succeeds, worker dies before local persistence | **⚠️ Split.** Durable: `outcomeUnknown`, never auto-retried — correct. **Shipping path: no duplicate, but no recovery either.** Run hangs `RUNNING`, watchdog marks it `FAILED` after 10 minutes, the already-sent emails stay sent, and nothing records which steps completed externally. |
| 6 | Marketing user attempts an HR workflow | **⚠️ Only if configured.** The check is real, backend-side, and applies to the *list* as well as the detail read (a name is itself a leak). **But department isolation is opt-in per department and no tenant has scopes set**, so out of the box it allows. |
| 7 | AI Employee attempts a high-risk action without approval | **✅ For classified tools** — and this was the exact bug that turning the durable engine on exposed (`stripe.create_payment_link` ran ungated). Now fixed *in the gate*, not the handler, using the shared pure policy so chat / legacy / durable cannot drift. **❌ For unclassified tools** — and only 3 of ~50 are classified. |
| 8 | Scheduled trigger fires twice | **✅ One run.** Idempotency key + unique `(companyId, idempotencyKey)`; `addSchedule` no-ops inline so the cron sweep is the only driver (the double-fire bug is fixed and regression-tested). |
| 9 | Webhook arrives twice | **✅ Deduped** — including a replay of the signed body with a *mutated delivery header*. |
| 10 | Connection expires — truthful health? | **✅ Yes, and unusually good.** Decrypt failure / 401 / `invalid_grant` → `markDisconnected`, the connector leaves the poll sweep, health shows DEGRADED/DISCONNECTED, single-flight refresh, `oauth_refresh_failure_total` metric, and the UI surfaces it. |
| 11 | Workflow fails — can the customer understand it? | **⚠️ Mostly.** What failed ✅ (timeline + `RunFailureCard` + `failureClass`). Why ✅. What already happened ⚠️ (step rows only, no attempts on the shipping path, no external request ids). What can be retried ⚠️ — **retry restarts the whole run** and the UI honestly says so, which means the customer is told the truth but given a dangerous button. Whether retry is safe ❌ — nothing computes that. |
| 12 | Company exceeds entitlement | **❌ No limit to bypass.** Plan limits are informational by design. |

---

## 8. Which functionality is UI-only, mock, scaffold, or fake

1. **`SKILL_EXECUTOR=mock` is the default**, with no production guard → every tool call returns `{ok:true, sandbox:true}`. *(P0-3)*
2. **Silent mock fallthrough in `real` mode** — the `default:` branch of `RealSkillExecutor.execute` routes any unimplemented tool to the mock and returns success. Affects **stripe, github, jira, hubspot, generic email**. *(P0-4)*
3. **`MAIL_ENABLED` off by default** → OTPs are the fixed `123456`. *(P0-1)*
4. **`EMBEDDINGS_PROVIDER=hash` default** — FNV-1a bag-of-words dressed as semantic search. *(P1-7)*
5. **`STORAGE_PROVIDER=local` default** — filesystem writes on a serverless host. *(P0-5)*
6. **Postiz webhook** — publicly reachable, logs, returns `{ok:true}`, writes nothing. Honestly labelled a placeholder.
7. **`mfaRequired`** — a stored, never-read column. To its credit the API now *refuses* to set it rather than pretending.
8. **`sessionTimeoutMinutes`** — stored, never read.
9. **Analytics "value" tiles** — hardcoded 10 min/task × $25/hr.
10. **`prunePublished()`** — implemented, never called. Dead code.
11. **`health-probe.ts`** — real probes are a documented `TODO [TARGET]`; offline mode reports healthy.
12. **Two coexisting template systems** — `marketplace.catalog.ts` (code shim) and the DB-backed `WorkflowTemplate`. The shim is stale but live.

**Deliberately and correctly NOT faked** — worth saying, because it is rarer than the opposite: `MailService` returns a real reason when disabled; `NotificationsService.workflowNotify` reports `notified:false` with a reason rather than lying (this was a real P0 that got fixed); `EngineAdapter.capabilities()` declares what an engine *cannot* do and `connect()` throws instead of returning cheerful success; the alert sweep returns `delivered:false` **with a reason** and logs `ALERTS ARE FIRING AND NOBODY IS BEING NOTIFIED`.

---

## 9. Implemented but unsafe for enterprise production

1. **Provider defaults fail *open* into fake behaviour.** The `requireRealProviderInProduction` guard exists and works — but it is wired to only **two** of six providers (`LLM_PROVIDER`, `BILLING_PROVIDER`). `SKILL_EXECUTOR`, `MAIL_ENABLED`, `EMBEDDINGS_PROVIDER`, `STORAGE_PROVIDER` have no guard. The pattern is right; the coverage is not.
2. **`http.request` is an ungated egress channel.** SSRF-blocklisted (good) but not `highRisk`, so a workflow can POST tenant data to any public URL with no approval.
3. **Two authorization systems with divergent floors.** `MIN_ROLE` puts `workflow:update|publish|delete` and `knowledge:manage` at **MEMBER** while the live `@Roles` routes require OWNER/ADMIN. The audit doc records this rather than doing it, which is the right call — but the divergence is loaded and pointed at the product.
4. **Department isolation is opt-in and switched on for nobody.** Shipping it inert was the responsible way to introduce it; leaving it inert means the enterprise story is unproven in practice.
5. **Team isolation is NOT SUPPORTED by decision.** Defensible (a half-built permission layer is worse than none) but it must be said out loud in any enterprise conversation.
6. **No secret manager, no rotation runbook.** `ENCRYPTION_KEY` loss = permanent loss of all encrypted PII and all stored credentials, documented only inside a DR doc.
7. **Alerting hangs on one unset variable.** `ALERT_WEBHOOK_URL` unset → nobody is paged. The failure path is honest, but honesty isn't a pager.
8. **Nothing scrapes production.** Metrics, traces and health endpoints all exist; no Prometheus, no OTLP endpoint, no APM is configured for the deployed environment.
9. **A deploy during execution orphans runs.** On a serverless host with inline execution, a redeploy mid-run leaves the run for the watchdog to kill.

---

## 10. Part 10/11 — Gap register

**47 gaps in current scope.** Paused engines excluded. A gap is a missing/incorrect/incomplete/unsafe/unverified capability that matters *now*; TODO comments are not counted unless they gate a capability.

### P0 — production blockers (8)

| ID | Domain | Capability | Expected | Actual | Evidence | Business impact | Production impact | Required resolution | Blocking? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **P0-1** | Security / Auth | Password reset + email verification | Emailed random OTP | `MAIL_ENABLED` unset (the default; `.env.example` ships `false`) → `generateOtp()` returns `DEV_OTP_CODE`, default **`123456`**. No boot guard. Chain: `forgot-password` → `verify-reset-otp` with `123456` → reset token → `reset-password`. Rate limit is 10/min. | `mail.service.ts:36`, `auth.service.ts:262,310`; no `requireRealProviderInProduction` call | **Total account takeover of any user, including OWNER, from an email address alone** | Full tenant compromise | Refuse to boot in production unless `MAIL_ENABLED=true`; never emit a fixed OTP outside development | **YES** |
| **P0-2** | Durable execution | Production runs on the durable runtime | Attempts, leases, reaper recovery | Vercel = `WORKFLOW_EXECUTION_MODE=inline` → `modeFor()` returns `legacy_walk` unconditionally. **No run anywhere is durable.** Crash mid-run → run hangs `RUNNING` → watchdog marks `FAILED`; no resume, no compensation, no record of which steps completed externally | `engine-mode.ts:74-88`, `apps/api/vercel.json`, `workflow-engine.service.ts:288-320` | Half-executed business processes with no recovery | No durability, no recovery, no attempt history | Deploy `main.ts` as one always-on worker (`QUEUE_WORKERS_ENABLED` unset), set `WORKFLOW_EXECUTION_MODE=queue` — the exit ramp is documented and rehearsed | **YES** |
| **P0-3** | External actions | Real tool execution in production | Real network calls | `SKILL_EXECUTOR` defaults to **`mock`**, no production guard. Every tool returns `{ok:true, sandbox:true}` | `skills.module.ts:57`, `mock-skill-executor.ts` | Customer's workflows report success having done nothing | Silent total failure that looks like success | Add `requireRealProviderInProduction('SKILL_EXECUTOR', kind)` | **YES** |
| **P0-4** | External actions | Honest failure for unimplemented tools | Fail loudly | `default:` case of `RealSkillExecutor.execute` routes to the mock and returns success. **stripe, github, jira, hubspot, email** are all affected even in `real` mode | `real-skill-executor.ts` (~line 165) | "Create the Jira ticket" succeeds; no ticket exists | Undetectable data/process loss | Throw `NOT_IMPLEMENTED` for unimplemented tools; never fall back to mock outside `auto`-with-no-credentials | **YES** |
| **P0-5** | Knowledge / HR docs | Durable blob storage | Object storage | `STORAGE_PROVIDER` defaults to **`local`** — filesystem under `STORAGE_DIR`. On Vercel the bundle path is read-only and `/tmp` is ephemeral | `knowledge.module.ts:56`, `local-storage.provider.ts:15-16` | Knowledge and HR documents fail to upload or vanish between invocations | Data loss / hard 500s | Guard the default in production; require `s3` | **YES** |
| **P0-6** | Security / Ops | Secret custody | Managed secrets + rotation | No secret manager, no rotation runbook. `ENCRYPTION_KEY` loss = irrecoverable loss of all encrypted PII and credentials | wave9 "Production secrets ❌"; verified still absent | Unrecoverable data loss; fails any security review | No key rotation possible | Managed secret store + documented rotation + re-encryption path | **YES** |
| **P0-7** | E2E verification | The shipping shape is tested | Full suite in the production configuration | CI runs e2e in `queue` mode only (matrix is over `WORKFLOW_ENGINE_MODE`, not `WORKFLOW_EXECUTION_MODE`) with `SKILL_EXECUTOR=mock`. The production shape (inline + no workers + forced `legacy_walk`) is covered by **one** spec, 11 tests. **No test anywhere exercises a real external side effect.** | `.github/workflows/api-ci.yml:95-145`, `test/inline-execution.e2e-spec.ts` | The configuration customers use has never been fully tested | Unknown regressions ship | Add an `inline` axis to the CI matrix; add a gated live-integration suite | **YES** |
| **P0-8** | Release / Ops | Deployed code = audited code | Hardening is deployed | **Waves 1–9 are entirely uncommitted.** `master` @ `73b5937` (2026-08-09) has **no** `AuthorizationModule`, `ObservabilityModule`, `RetentionModule`, `PmModule`, `audit-chain.ts`, `alert-dispatch.service.ts`, `tracing.ts`, or `workflow-readiness.ts`, and **45 of 52 migrations**. `origin/deployment` @ `3e7fa5c` (2026-07-27) has **29 of 52**. 233 modified/untracked files, 90 untracked, including 7 migrations and 5 whole modules. | `git show HEAD:apps/api/src/app.module.ts` vs working tree; `git ls-tree -r` migration counts | **Everything this audit found *good* — the authorization layer, tracing, retention, the audit hash chain, alerting, the simplified UX — is not in any deployed branch.** A `git checkout` destroys it. Nothing in CI or review has ever seen it. | The deployed product is 5 days to 3 weeks behind and pre-hardening | Commit Waves 1–9 to a branch, let CI run both engine modes, review, merge, confirm which branch Vercel builds | **YES** |

### P1 — enterprise blockers (19)

| ID | Domain | Gap | Evidence | Impact |
| --- | --- | --- | --- | --- |
| P1-1 | Security | No MFA (honestly refused) and no SSO/SAML/OIDC | `security-policy.service.ts:128` | Enterprise procurement stops here |
| P1-2 | Billing | Entitlements informational only — no seat/employee/run/usage/storage caps | `billing.plans.ts:74`, `billing.service.ts:26` | Unbounded cost exposure; plans unmonetisable |
| P1-3 | Authorization | Two systems (`@Roles` + `@RequirePermission`) with divergent floors; `MIN_ROLE` = MEMBER for `workflow:update|publish|delete`, `knowledge:manage` | `authorization.policy.ts:35-55` | A migration becomes a privilege escalation |
| P1-4 | Authorization | Department isolation opt-in and configured for nobody; team isolation NOT SUPPORTED | `authorization.policy.ts:20-28`, wave9 B2 | Multi-department safety is capability, not state |
| P1-5 | Realtime | Chain built but not delivered: outbox written only by the durable path; `relayOnce()` driven only by a BullMQ processor (absent on Vercel); `prunePublished()` never called; UI polls at 1s | `outbox-relay.service.ts:52,96`, `timer.processor.ts:62`, `hooks.ts:566` | No live execution view; unbounded outbox growth |
| P1-6 | Approval / Governance | Only 3 of ~50 tools are `highRisk`. `gmail.send_email`, `slack.send_message`, `plane.create_issue`, `chatwoot.reply_to_conversation`, `http.request` ungated in workflows. No company-level "gate all external actions" policy | `catalog.ts:121,554,568`, `tool-approval-policy.ts:54` | An AI Employee emails customers / egresses data with no human in the loop |
| P1-7 | Knowledge | `EMBEDDINGS_PROVIDER=hash` default, no guard — bag-of-words, not semantic | `hash-embedding.provider.ts` | Retrieval quality silently poor; RAG answers wrong |
| P1-8 | Events | Postiz bypasses the canonical spine; webhook is a public no-op; status only via a 10-min sweep | `marketing-webhook.controller.ts:8-18` | Marketing workflows can't be event-driven |
| P1-9 | Frontend / HR | HR domain — 6 controllers, encrypted special-category PII, retention sweep — has **no UI** | `ls apps/web/src/features` | A sold module is unusable without hand-crafted API calls |
| P1-10 | Frontend / Authz | Workflow permissions have **no UI** | no `permissions` feature in web | Enterprise access control is unreachable for a customer |
| P1-11 | Onboarding | 3 steps only (company → roles → goals). No skill connect, no knowledge, no first workflow | `OnboardingWizard.tsx`, `onboarding.service.ts` | Customer completes onboarding with a non-functional AI Employee |
| P1-12 | Ops | No PITR (RPO 24h); nothing scrapes metrics/traces in production; alerting depends on one unset `ALERT_WEBHOOK_URL` | wave9 Operations 6/10 | Incidents are found by customers |
| P1-13 | Audit | Execution audit partial — only `workflow.run.cancel` reaches `AuditLog`; run/step/attempt tables sit **outside** the hash chain | wave9 Audit row | "What did the AI actually do" is not tamper-evident |
| P1-14 | Execution semantics | `PARALLEL`/`LOOP` run **sequentially in-process** on the shipping engine, as real attempts on the durable one | `workflow-engine.service.ts:840-1060` | Customers get the weaker semantics; timing bugs differ per environment |
| P1-15 | Analytics | ROI tiles hardcoded (10 min/task × $25/hr) | `analytics.constants.ts:9-10` | Fabricated business value shown to customers |
| P1-16 | External actions | No `externalRequestId` anywhere; idempotency only on Postiz publish; reconciliation only Postiz | grep across `src` | Cannot prove or reconcile what happened at a provider |
| P1-17 | Frontend | Notifications module has **no UI**; no in-app notification centre | no `notifications` feature in web | Approval requests and failures rely on email/webhook alone |
| P1-18 | Data governance | Retention preview / legal-hold placement has **no UI** | no `retention` feature in web | A compliance officer cannot operate compliance features |
| P1-19 | Process | The `orlixa-frontend-cto-implementation-plan.md` authority document referenced by the other plans **does not exist** | `find docs -iname "*frontend*"` | Frontend decisions have no traceable authority |

### P2 — important (14)

| ID | Gap |
| --- | --- |
| P2-1 | AI Assist cannot modify an existing workflow (no diff mode, §9) |
| P2-2 | No step-level retry — `retry` starts a fresh run (UI is honest about it, but it's the wrong primitive) |
| P2-3 | No compensation / rollback (deliberately not implemented) |
| P2-4 | `/runs/:id/{timeline,attempts,tool-calls}` endpoints deferred (P5-02/03) |
| P2-5 | No version diff / rollback / clone |
| P2-6 | No per-workflow timezone (server-tz only) |
| P2-7 | No global DLQ view (tenant-scoped only) |
| P2-8 | No email invites |
| P2-9 | No semantic memory recall — learned FACTs crowded out by recency |
| P2-10 | Two coexisting template systems (marketplace shim vs `WorkflowTemplate`) |
| P2-11 | `ExecutionContext` lacks `skillExecutionId` / `externalRequestId` / `workflowVersionId` |
| P2-12 | No dedicated audit page (a section inside `/organization`) |
| P2-13 | `sessionTimeoutMinutes` stored but never enforced |
| P2-14 | Skills / Knowledge / AI Assist / Analytics have **no browser E2E coverage**; the only browser evidence on disk is a **failure** |

### P3 — enhancement (6)

`P3-1` per-attempt node-permission PDP (doc 09) · `P3-2` third-party publisher marketplace + commission · `P3-3` company logo upload · `P3-4` analytics charts / trend snapshots · `P3-5` Kafka event backbone · `P3-6` voice/token metering beyond current cost tracking

---

## 11. Parts 6–9 — Scores

### A. Product functional completeness — **≈86%**
Almost everything planned exists in code. This is a large, coherent, well-factored system.

### B. Production readiness — **≈50%**

| Domain | Weight | Score | Weighted | Why |
| --- | --- | --- | --- | --- |
| Durable Execution | 20% | 25% | 5.0 | Built, tested, **unreachable in the shipping shape** |
| Authorization / Tenant Isolation | 15% | 70% | 10.5 | Tenant isolation solid; department isolation off; team unsupported; two systems |
| Reliability / Recovery | 10% | 25% | 2.5 | Shipping path kills instead of recovering; no compensation |
| Security | 10% | 45% | 4.5 | Excellent primitives; dev-OTP takeover, no secret manager, no MFA |
| Approval / Governance | 8% | 75% | 6.0 | Correct and restart-safe; risk classification far too narrow |
| Auditability | 8% | 80% | 6.4 | Genuinely strong; execution coverage partial |
| Observability | 7% | 60% | 4.2 | All built and correct; nothing operates it in production |
| E2E Verification | 8% | 60% | 4.8 | 574 unit verified green; both engine modes in CI; never the shipping shape, never a real executor |
| External Side Effects | 5% | 20% | 1.0 | Mock default, silent mock fallthrough, idempotency on one tool |
| Data Governance / Retention | 4% | 85% | 3.4 | Best domain in the product; restore actually proven |
| Realtime / Operations | 2% | 30% | 0.6 | Backend built, nothing drives it, UI polls |
| Billing Enforcement | 3% | 20% | 0.6 | Tier gate on 2 routes only |
| **Total** | **100%** | | **49.5 → ≈50%** | 8 P0s cap this independently |

### C. Business logic correctness — **≈63%**

| Domain | Weight | Score | Weighted |
| --- | --- | --- | --- |
| AI Employee model | 15% | 70% | 10.5 |
| Skill / Connection behaviour | 10% | 45% | 4.5 |
| Knowledge / Memory | 10% | 60% | 6.0 |
| Workflow semantics | 15% | 85% | 12.8 |
| Scheduling | 8% | 80% | 6.4 |
| Durable execution | 12% | 35% | 4.2 |
| Approval | 8% | 85% | 6.8 |
| External actions | 8% | 30% | 2.4 |
| Authorization | 7% | 70% | 4.9 |
| Audit / governance | 3% | 90% | 2.7 |
| Billing / entitlements | 2% | 20% | 0.4 |
| Analytics / feedback | 2% | 60% | 1.2 |
| **Total** | **100%** | | **62.8 → ≈63%** |

### D. Product goal achievement — **≈56%**

| # | Outcome | Score |
| --- | --- | --- |
| 1 | AI Employees can be created and managed | 1.00 |
| 2 | AI Employees can use skills | 0.50 |
| 3 | AI Employees can access authorized knowledge | 0.60 |
| 4 | AI Employees can execute real business actions | 0.30 |
| 5 | Users can create workflows using AI Assist | 0.90 |
| 6 | Users can manually refine workflows | 0.85 |
| 7 | Workflows can be scheduled | 0.80 |
| 8 | Workflows can react to events | 0.60 |
| 9 | Workflows execute durably | 0.20 |
| 10 | Human approval can control risky work | 0.70 |
| 11 | Work is observable | 0.55 |
| 12 | Work is auditable | 0.80 |
| 13 | Failures can recover | 0.20 |
| 14 | Enterprise permissions work | 0.50 |
| 15 | Multiple departments/teams can safely operate | 0.40 |
| 16 | Customers can understand AI Employee activity | 0.70 |
| 17 | Real external systems can be operated | 0.35 |
| 18 | The system can support business-critical workloads | 0.15 |
| | **10.10 / 18** | **≈56%** |

### How much is remaining

- **Functionality:** ~14%
- **Production safety:** ~50% — and most of it is *configuration, deployment and release discipline*, not code
- **Mission:** ~44%

**The single most useful thing about these numbers:** the distance between 86% built and 50% safe is dominated by six things that are **days of work, not months** — commit the code (P0-8), host one always-on worker (P0-2), extend an existing guard function to four more providers (P0-1, P0-3, P0-5), and make one executor throw instead of lying (P0-4). None of those is architecture. They are the last mile, and the last mile is currently the whole problem.

---

## 12. Recommended sequence (spine only — no engine unfreeze)

**Week 1 — stop the bleeding**
1. **P0-8**: commit Waves 1–9 to a branch; CI both engine modes; review; merge. Confirm which branch Vercel builds. *Nothing else on this list matters until the code is somewhere other than one disk.*
2. **P0-1**: refuse to boot in production without `MAIL_ENABLED=true`. This is an active account-takeover path.
3. **P0-3 / P0-5**: extend `requireRealProviderInProduction` to `SKILL_EXECUTOR`, `STORAGE_PROVIDER` (and `EMBEDDINGS_PROVIDER` for P1-7).
4. **P0-4**: make the executor's `default:` branch throw.

**Week 2–3 — make execution real**
5. **P0-2**: one always-on worker (~$5–10/month per the docs), `WORKFLOW_EXECUTION_MODE=queue`, then the rehearsed one-company durable pilot. This single change flips P0-2, most of P1-5, P1-14 and the reaper/lease/attempt items together.
6. **P0-7**: add the `inline` axis to CI; add a credentialed live-integration suite behind a flag.
7. **P0-6**: managed secret store + rotation runbook.

**Week 4–6 — make it sellable to an enterprise**
8. **P1-6**: widen `highRisk` and add a company-level "gate all external actions" policy.
9. **P1-2**: enforce entitlements at the service layer.
10. **P1-9 / P1-10 / P1-17 / P1-18**: build the four missing UIs.
11. **P1-11**: extend onboarding to reach one working workflow.
12. **P1-3 / P1-4**: converge on one authorization system; turn department isolation on for a pilot tenant.
13. **P1-1**: MFA, then scope SSO — this is where Keycloak's early-exit condition legitimately triggers.

**Do not start any paused engine until P0-1 … P0-8 are closed.**

---

## 13. What deserves explicit credit

Because a forensic audit that only lists faults misrepresents the system:

- **The self-audits are honest.** `cto-gap-closure-wave9.md` says **DO NOT PASS** and explains why. Addendum 2 says *"This document previously said the durable runtime was 'real, tested code' that merely needed switching on. It was not fully tested."* That is a rare and valuable habit.
- **Turning the durable engine on and running the suite found a real approval bypass** before it shipped. The two-engine-mode CI matrix now prevents its recurrence.
- **The approval gate lives in the gate, not the handler** — with the reasoning written down — precisely because a handler cannot pause a run.
- **Rows written by one engine are byte-compatible with the other**, because an approval is exactly the long-lived state that straddles a rollout.
- **Failure paths report reasons instead of cheerful successes**: `notified:false` with a reason, `delivered:false` with a reason, `EngineAdapter.capabilities()` declaring what it cannot do, readiness that must agree with publish.
- **Restore was actually performed**, not just scripted — 14 tables, 664 objects, measured.
- **The tenant-aware throttler's reasoning** (an unverified `companyId` lets an attacker both escape their own limit *and* exhaust a competitor's) is better security thinking than most production code contains.
- **The workflow UX simplification was executed exactly as planned**, with the customer-facing ceremony removed and every backend guarantee retained.

The engineering is not the problem. **Release discipline and deployment configuration are the problem** — and that is a far better position to be in.
