# Cluster 12 — Duplicate/Legacy Architecture + Master Sweep (DB columns, queues/crons, dead components, config duplication, feature flags, TODO/stub scan)

Source: direct grep/read pass, 2026-09-09. Scope is explicitly the leftovers cluster 01 (monorepo/DB) and cluster 06 (frontend↔API) did not own. All paths relative to `d:/Vertical AI/platform` unless noted. Evidence hierarchy: executable code > test assertions > doc comments — several findings below exist *because* a doc comment was trusted instead of grepped.

---

## 0. Headline pattern: stale "not yet enforced" comments are a systemic hazard here

Before the section-by-section results: the single most repeated defect class found this pass was **a code comment or schema comment claiming a field is "stored only" / "enforcement is a TODO" when the enforcement code has since shipped elsewhere**. Found independently four times:

| Claim | File:line | Reality |
|---|---|---|
| "`mfaRequired`/`sessionTimeoutMinutes`/`allowedEmailDomains` beyond registration... enforcement-TODO" | `schema.prisma:1606-1607` | `sessionTimeoutMinutes` **is** enforced (`security-policy.service.ts:102-117`, called from `auth.service.ts:513`); `allowedEmailDomains` **is** enforced (`security-policy.service.ts:76-90`, called from `users.service.ts:280`). Only `mfaRequired` is genuinely inert (and is *actively blocked* from being turned on, see §1). |
| "mfaRequired / sessionTimeoutMinutes / dataRetentionDays are STORED only today (enforcement is a documented TODO)" | `organization/dto/update-security-policy.dto.ts:16-17` | Same as above — 2 of 3 named fields are enforced; `dataRetentionDays` is also enforced (HR retention sweep, confirmed by cluster 01 and `security-policy.service.ts`'s own doc table). |
| "Enforcement (`EmployeeCreditPeriodCounter`) lands in a later phase; these columns are inert until then" | `schema.prisma:709-713` (`AiEmployee.maxCreditsPerExecution/maxCreditsPerTask`) | Enforced by `credits/credit-limits.service.ts` (explicitly dated "Kill-critic audit gap fix 2026-08-20") and rendered/edited in `EmployeeSettings.tsx`/`EmployeeAbout.tsx`. |
| "Stored encrypted-at-rest (TODO)" for the Stripe skill's API key field | `skills/catalog.ts:220` | Encryption-at-rest for **all** `InstalledSkill.credentials` (Stripe included) has been live since the P0/P1 remediation wave — `skills.service.ts:1427` calls `sealCredentials`/`CryptoService` unconditionally for every skill. |

None of these are new defects on their own (the underlying feature works); the risk is a reader trusting the comment instead of the code and either re-building something that already exists, or shipping a customer-facing claim ("security policy X is enforced") based on stale self-documentation in the wrong direction. Recommend a pass that deletes/updates all four before the next audit cycle, since a future contributor has no way to distinguish these from a genuinely-still-TODO comment elsewhere in the same files.

---

## 1. Unused/suspicious DB columns — spot-check

| Field | Verdict | Evidence |
|---|---|---|
| `SecurityPolicy.mfaRequired` | **PLANNED ONLY, deliberately blocked** | `security-policy.service.ts:119-135` — `assertPolicyIsEnforceable` throws `BadRequestException` if anyone tries to set it `true` ("MFA is not implemented yet, so it cannot be required"). This is the *correct* honest behaviour, not a bug — flagging so it isn't mistaken for the stale-comment pattern above. |
| `SecurityPolicy.sessionTimeoutMinutes` | **FULLY IMPLEMENTED** (contradicts schema comment, see §0) | `security-policy.service.ts:92-117`, called at `auth.service.ts:513`. |
| `SecurityPolicy.allowedEmailDomains` | **FULLY IMPLEMENTED** (contradicts schema comment, see §0) | `security-policy.service.ts:76-90`, called at `users.service.ts:280`. |
| `Department.scopes` | **FULLY IMPLEMENTED** (cluster 01 flagged as "ships inert, empty=unrestricted" — that half is still true by design, but it is NOT unused) | Read in `authorization.policy.ts:148-165` (`decide()`), which is imported by `authorization.service.ts` and live in 8 real modules: `analytics.service.ts`, `employees.service.ts`, `hr/staff.service.ts`, `knowledge.service.ts`, `product-context/*`, `workflows.service.ts`. Frontend control exists and is self-documented as closing exactly this gap: `apps/web/src/features/organization/components/DepartmentScopeEditor.tsx:36-44` ("This control is the reason the whole WAVE-2 authorization layer existed but did nothing in production... had no input anywhere in the product"). |
| `AiEmployee.maxCreditsPerExecution` / `maxCreditsPerTask` | **FULLY IMPLEMENTED** (contradicts schema comment, see §0) | `credits/credit-limits.service.ts:113-121`; edited in `EmployeeSettings.tsx:328-358`, displayed in `EmployeeAbout.tsx:29-34`. |
| `BrandAsset` (whole model, incl. `structuredValue Json?`) | **UNUSED — genuinely dead table**, missed by cluster 01's bulk "marketing tables = ACTIVE" classification | `schema.prisma:2049-2060`, real `Company.brandAssets` relation (`:308`). Zero hits for `brandAsset`/`BrandAsset` anywhere in `apps/api/src`, `apps/web/src`, or `packages/types/src` outside the schema file itself. No controller, no service, no DTO. A migration created it and nothing ever wrote or read it. |
| `MarketingConsent.evidence` (and the model itself) | **BROKEN in practice — write path is unreachable** | `SuppressionService.recordConsent()` (`suppression.service.ts:149-171`) is the only writer of `MarketingConsent`, and it is **never called** anywhere in `apps/api/src` outside its own definition (confirmed by grep for `recordConsent`). Meanwhile `SuppressionService.latestConsent()` (the read side) **is** wired live into `real-skill-executor.ts:1156-1201` and gates the `marketing.check_consent` tool, which requires a `GRANTED` record before treating an address as consented. Net effect: `check_consent` will report **every address as missing consent, always**, in every environment, because nothing in the product can ever create a GRANTED row (no controller, no admin UI, no import flow reaches `recordConsent`). This is functionally a permanently-failing compliance gate, not a merely-unused column. |
| `ContentItem`/`MediaAsset` other `Json?` fields (`config`, `metadata`, `structuredValue` elsewhere) | Not individually re-verified beyond the above (effort budget) | — |

---

## 2. Workers, queues, cron jobs — producer/consumer cross-check

### 2.1 BullMQ queues: every `@Processor` found, cross-checked against `registerQueue`

16 processors exist (`grep -rl "@Processor(" apps/api/src`): `platform-sweeps`, `approval-sla`, `credit-reservation-sweep`, `marketing-sync`, `gmail-inbound`, `imap-inbound`, `event-normalize`, `connector-reconcile`, `hr-retention`, `knowledge-ingest`, `campaign-generation`, `connector-health`, `wf-node-attempt`, `wf-run-advance`, `wf-timer`, `workflow-run` (legacy engine). Every one of these has a matching `registerQueue` and at least one `@InjectQueue` producer. **No orphan processor found.**

### 2.2 Two queues registered with NEITHER a producer NOR a consumer

`workflow-runtime.module.ts:42-48` registers 5 queues, but only 3 (`WF_RUN_ADVANCE_QUEUE`, `WF_NODE_ATTEMPT_QUEUE`, `WF_TIMER_QUEUE`) have a `@Processor`. The other two:

| Queue | Registered | `@Processor`? | `@InjectQueue` anywhere? | Verdict |
|---|---|---|---|---|
| `WF_COMPENSATE_QUEUE` (`'wf-compensate'`) | `workflow-runtime.module.ts:46` | **No** | **No** (grep for `WF_COMPENSATE_QUEUE` finds only its own constant + registration) | **PLANNED ONLY** — matches the standing decision in memory that workflow compensation was "deliberately NOT implemented." Not a bug; the name is reserved (also pre-listed in `DLQ_KNOWN_QUEUES` via `...WORKFLOW_RUNTIME_QUEUES`, `dlq.constants.ts:29-30`, so `/admin/dlq` already tolerates it being empty). |
| `WF_DLQ_QUEUE` (`'wf-dlq'`) | `workflow-runtime.module.ts:47` | **No** | **No** | Same as above — reserved capacity, not wired, not a live gap. |

Contrast with `engines/support/support.constants.ts:18-31` — `SUPPORT_SYNC_QUEUE` is **explicitly self-documented** as "RESERVED, NOT WIRED... Nothing enqueues to it and nothing consumes it," with an explicit warning to add it to `DLQ_KNOWN_QUEUES` if ever wired. Good precedent that the codebase already has a pattern for declaring "reserved, not a bug" — `WF_COMPENSATE_QUEUE`/`WF_DLQ_QUEUE` should probably get the same explicit comment rather than being silently registered.

### 2.3 `/admin/cron/:job` ↔ scheduler coverage

All 18 `CronController.CRON_JOBS` (`cron.controller.ts:80-99`) are covered by **both** deployment shapes (HTTP sweep + BullMQ repeatable), enforced by `cron-schedule-coverage.spec.ts`. This was a real, now-fixed 2026-09-02 audit gap (8 jobs had no repeatable; 6 jobs had no scheduler entry) — already fully documented in CLAUDE.md and memory, not re-litigated here.

**Confirmed but not new:** `apps/api/vercel.json` has **no `crons` key at all today** — the 18-job schedule lives in the sidecar `apps/api/vercel.crons.json` (`_readme`: "Disabled 2026-08-28: the Vercel account is on the Hobby plan, which rejects any cron running more than once per day"). `cron-schedule-coverage.spec.ts:28-64` correctly reads whichever file holds `crons` and asserts they never both hold it. This means **in the current deployment shape, zero cron jobs run automatically** unless `WORKFLOW_EXECUTION_MODE=inline` covers workflow scheduling and someone external (or a Pro-plan upgrade) drives the rest — already flagged in memory (`deployment-pipeline-preflight.md`) as a known, parked, documented gap. Restating here only because task scope explicitly asked to check it; not counted as a new finding.

---

## 3. Orphan frontend components

Checked all 157 `.tsx` files under `apps/web/src/components/**` and `apps/web/src/features/*/components/**` for zero cross-file references. **3 of 157 are genuinely dead:**

| File | Verdict | Evidence |
|---|---|---|
| `apps/web/src/components/marketing-dark/demo/DemoPlayer.tsx` (+ its sibling `scenes.tsx`) | **LEGACY, self-documented as intentionally kept** | `app/demo/page.tsx:11-15`: "The recorded product-explainer video (`/how-it-works.mp4`) — the final output of the self-playing animation in `components/marketing-dark/demo/` (**kept there, unused now**, in case the video is ever re-recorded)." Zero imports anywhere; this is deliberate, not a defect. |
| `apps/web/src/components/marketing-dark/FaceMesh.tsx` | **UNUSED — genuinely dead, not documented as intentional** | Zero references anywhere in the repo, including from the demo scenes it might plausibly have illustrated. No page, no story, no export barrel references `FaceMesh`. Unlike `DemoPlayer`, there is no comment anywhere explaining why it's kept. |
| `apps/web/src/features/workflows/components/builder/DisabledControl.tsx` | **UNUSED — built, never adopted** | A well-designed, documented (doc 29 §2/§3.G) accessible wrapper for explaining *why* a control is disabled — but zero call sites. The workflow builder has since grown multiple ad-hoc disabled states (readiness gates, publish guards) that apparently didn't reuse this component when they were built. |

157-3 = 154 components (98%) have live call sites — this frontend is not carrying meaningful dead-component weight, consistent with cluster 06's "unusually well-wired" verdict.

---

## 4. Duplicate/legacy architecture scan (beyond the known workflow-template/marketplace split)

Checked: notification paths, approval-decision resolution, audit-logging writers, and config values resolved via two different mechanisms (the class of bug CLAUDE.md names for `LLM_MODEL`).

| Candidate duplicate | Verdict | Evidence |
|---|---|---|
| Notification delivery (workflow NOTIFY node vs. anything else sending mail) | **Clean — single path** | `workflows/engine/nodes/notify.handler.ts:50` calls `NotificationsService.workflowNotify` exclusively; no direct `MailService` bypass. |
| "Who can decide an approval" (workflow engine vs. approvals controller) | **Clean — single path, already consolidated in P3-05** | `approvals.controller.ts:24-30` explicitly documents the `@Roles('OWNER','ADMIN')` guard was *removed* and moved into `ApprovalRoutingService.canDecide`; `workflows/engine/approval-gate.service.ts` creates requests through the same `ApprovalService`, no parallel role check found. |
| Audit-log writes (dedicated `AuditLogService` vs. any direct `prisma.auditLog.create`) | **Clean — single writer** | The only other `prisma.auditLog` touch outside `audit-log.service.ts`/`audit-retention.service.ts` is `platform-admin-credits.controller.ts:56`, which is a `findFirst` (idempotency check), not a write — the actual write at `:95` goes through `this.auditLog.record(...)`, the real service. No bypass. |
| Model/pricing resolution (`LLM_MODEL`) — the bug CLAUDE.md names | **Confirmed FIXED, now single-sourced** | `resolve-model.ts` is the one shared `resolveModel()` function; all three providers (`openai-llm.provider.ts:4`, `anthropic-llm.provider.ts:4`, `mock-llm.provider.ts:33`) import it, and `llm.provider.ts:175-183`'s `modelForCall()` calls `provider.resolveModel()` first, only falling back to a raw `process.env.LLM_MODEL` read for a test-double provider that (per its own doc comment) is "never reachable in production." No live divergence remains. |
| Other provider-selection env vars (`SKILL_EXECUTOR`, `BILLING_PROVIDER`, `EMBEDDINGS_PROVIDER`, `STORAGE_PROVIDER`) | **Clean — one factory function per var** | Each is read via `config.get<string>(NAME) ?? default` in exactly one module factory (`skills.module.ts:85`, `billing.module.ts:29`, `knowledge.module.ts:36`, `knowledge.module.ts:56`); no second call site re-derives the same choice differently. |
| OAuth "connect" duplication (real PKCE flow vs. generic `connectSkill`) | **Minor defense-in-depth gap, not currently exploitable in the shipped UI** | `skills.service.ts:302-309`'s own doc comment: "for `oauth` skills this is a STUB that just marks the skill connected (accepting whatever token is passed)... TODO: real OAuth authorization-code flow." The generic `POST /skills/installed/:id/connect` (`skills.controller.ts:123-132`) has **no server-side guard rejecting `connection.type==='oauth'`** — it relies on (a) the frontend routing oauth-type skills through the real `authorizeOAuth`/PKCE redirect instead (confirmed: `ConnectSkillControl.tsx:36-47,95-105`), and (b) a per-provider adapter (`providers/gmail.adapter.ts`, `slack.adapter.ts`, `gdrive.adapter.ts`, `calendar.adapter.ts`) rejecting a bogus token at connect time for the oauth skills that have one. Not a live bug today, but the backend endpoint itself would accept a hand-crafted request marking an oauth skill CONNECTED with fabricated credentials for any oauth skill that lacks an adapter. |

**Net finding for this section:** the specific historical bug class CLAUDE.md warns about (two places resolving the same config value differently) has been properly fixed and is now guarded by shared functions, not re-introduced elsewhere. The one live "duplicate mechanism" gap that exists (§4 last row) is server-side-only and defense-in-depth, not a customer-visible defect.

---

## 5. Feature flag inventory (production-readiness master list)

Canonical source confirmed to exist and be current: `scripts/preflight-env.mjs` (root) — a genuinely thorough deploy-time gate, born from a real 2026-08-28 incident (5 silent misconfigurations found in the live Vercel project). Table below merges its checks with flags it does **not** check.

| Flag | Default | What's hidden/changed when OFF/default | Boot-time guard? |
|---|---|---|---|
| `MAIL_ENABLED` | unset/false | OTP fixed at `123456` (or `DEV_OTP_CODE`); `forgotPassword` reuses the same generator → account takeover by email address alone | **Yes** — refuses to boot in production if unset (`require-mail-enabled.ts:29,49`) + `preflight-env.mjs:177-184` |
| `WORKFLOW_EXECUTION_MODE` | `queue` | With `QUEUE_WORKERS_ENABLED=false` and mode≠`inline`, every workflow run is created and sits `PENDING` forever (gap G40) | Preflight only (`preflight-env.mjs:139-147`), no NestJS boot guard |
| `QUEUE_WORKERS_ENABLED` | `true` (`!== 'false'`) | `false` removes the BullMQ consumer; producers still enqueue | Preflight only, combined with the above |
| `CRON_SECRET` | unset | `/admin/cron/*` **disables itself** (not "open") — all scheduled sweeps silently never run | `cron.controller.ts:202-208` (runtime 403) + preflight |
| `SKILL_EXECUTOR` | `mock` | Every "tool call" is simulated, logged as if real | **Yes** — `requireRealProviderInProduction('SKILL_EXECUTOR', kind)` (`skills.module.ts:94`) + preflight |
| `BILLING_PROVIDER` | `mock` | Subscriptions/plan-changes are fake, no Stripe | **Yes** — `billing.module.ts:35` + preflight |
| `LLM_PROVIDER` | `mock` | AI Employee replies are deterministic canned text | **Yes** — `llm.module.ts:19` + preflight |
| `EMBEDDINGS_PROVIDER` | `hash` | Knowledge/RAG search runs on a bag-of-words hash-trick pseudo-embedding (`hash-embedding.provider.ts:4-9`, explicitly self-documented "good enough for local dev + e2e" — no synonym/paraphrase matching, i.e. NOT real semantic search) | **No boot guard, not in `preflight-env.mjs` either** — see §5.1 below |
| `STORAGE_PROVIDER` | `local` | Knowledge document blobs are written to local disk (`local-storage.provider.ts`) | **No boot guard, not in `preflight-env.mjs`** — see §5.1 |
| `CREDIT_LEDGER_ENABLED` | `false` | Every reserve/settle/release call is a no-op; AI usage is unmetered | No hard guard; `preflight-env.mjs:246-251` WARNs in production |
| `CREDIT_GRANTS_ENABLED` | `false` | No free-credit grant logic is reachable | Combined guard: `preflight-env.mjs:288-293` hard-fails if `true` with `MAIL_ENABLED` off (mirrors a runtime guard) |
| `CREDIT_ENFORCEMENT_ENABLED` | `false` (+ per-company `creditEnforcementEnabledAt` allowlist) | Spend is recorded (if ledger on) but never blocks; two-key design so the global flag alone changes nothing | `preflight-env.mjs:253-258` WARN + `:269-275` hard-fail if enforcement on without ledger |
| `CREDIT_PAYG_ENABLED` | `false` | Credit-purchase endpoint returns "not available yet" | `preflight-env.mjs:259-264` WARN + `:279-284` hard-fail if PAYG on without ledger |
| `WORKFLOW_ENGINE_MODE` / `WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES` | every company defaults to `legacy_walk` | Durable state-machine engine (approval-gate-aware, resumable) only runs for explicitly allowlisted company ids; everyone else runs the older graph-walk engine, which is documented elsewhere as missing at least one safety gate the durable engine has | No boot guard, not in `preflight-env.mjs` |
| `NEXT_PUBLIC_SIMPLIFIED_WORKFLOW_UX` (frontend) | ON (`!== 'false'`) | Legacy publish/activate controls are hidden; flipping to `false` restores them (still present in code) | N/A (frontend build-time flag, not part of `preflight-env.mjs`'s API-side scope) |
| `AUTH_THROTTLE_LIMIT` | `10`/minute | Auth endpoint rate limit | Not checked by preflight (low risk — has a safe default) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Tracing silently no-ops; metrics/logs still work | `preflight-env.mjs:301-306` WARN only |
| `ALERT_WEBHOOK_URL` | unset | Alert rules evaluate but nobody is paged | `preflight-env.mjs:307-311` WARN only |

### 5.1 New finding: the provider mock-in-production guard has a coverage gap

`requireRealProviderInProduction()` (`common/config/require-real-provider.ts`) is wired to exactly **3** of the platform's 5 swappable-provider seams: `LLM_PROVIDER`, `BILLING_PROVIDER`, `SKILL_EXECUTOR`. `EMBEDDINGS_PROVIDER` and `STORAGE_PROVIDER` have **no equivalent boot-time refusal**, and `preflight-env.mjs`'s own "mock providers in production" loop (`:203-214`) only iterates the same three names — it does not check these two either. Concretely, a production deploy with `EMBEDDINGS_PROVIDER` unset silently runs Knowledge/RAG search on a hash-bucket bag-of-words vector (no boot error, no preflight warning), and a deploy with `STORAGE_PROVIDER` unset writes uploaded knowledge-document blobs to local disk — which on a serverless/ephemeral-filesystem deployment (the same Vercel shape the rest of this codebase's docs are explicit about) risks blobs vanishing between invocations or across instances with a 200 OK response at upload time. This is the identical "silent success" defect class the codebase has fixed four other times (`MAIL_ENABLED`, `WORKFLOW_EXECUTION_MODE`, the 3 provider guards above, the 8-orphaned-cron-jobs fix) — just not yet closed for these two seams.

---

## 6. TODO/stub/NotImplementedException scan

`NotImplementedException`: **zero hits** in `apps/api/src`. `FIXME`: **zero hits** anywhere. `TODO`: 14 in `apps/api/src`, 1 in `apps/web/src` (excluding specs/tests) — a genuinely small, manageable count for a codebase this size.

| Location | On a real user-facing path? | Note |
|---|---|---|
| `skills/catalog.ts:183` — "Soft cap on emails per day (enforcement is a TODO)" | Yes — `dailyEmailLimit` config field is shown to the user in the SMTP skill's setup form | Genuinely unenforced; distinct from the stale-comment class in §0 (this one is accurately still-TODO — verified no rate-limit code references `dailyEmailLimit`). |
| `skills/executors/real-skill-executor.ts:173` — "Still TODO: real executors for [stripe/github/hubspot/jira]" | Yes, but already fully surfaced to the user | Matches memory/CLAUDE.md's own "SIMULATED" labeling and cluster 06's confirmed honest "Demo only" UI treatment — not a hidden gap. |
| `skills/skills.service.ts:309` — "TODO: real OAuth authorization-code flow" (on `connectSkill`) | Only reachable server-side, not via the shipped UI (see §4 last row) | |
| `workflows/workflows.constants.ts:131` — "resumable waits via delayed jobs are a TODO; for now WAIT is a bounded sleep" | Yes | Already documented in CLAUDE.md's module-status log ("WAIT is a bounded sleep (durable resume = TODO)"). |
| `apps/web/.../NodeList.tsx:117` — "visual drag-drop canvas for editing branch targets directly is a TODO" | Yes, minor UX gap | Branch targets are presumably still editable some other way (not independently re-verified — effort budget). |
| `billing/providers/stripe-billing.provider.ts:25`, `billing.controller.ts:50` | Yes | Proration/billing-portal-link/hosted-checkout gaps — already covered by the credit-billing-system memory entries. |
| `employees/employees.service.ts:203`, `marketplace/marketplace.catalog.ts:13`, `analytics/analytics.constants.ts:7`, `skills/connectors/health-probe.ts:17`, `skills/executors/mock-skill-executor.ts:26` | Mixed | All match already-documented deferred items in CLAUDE.md's "Deferred (not started)" list — no new gap. |

No `stub`/`not implemented` hit pointed to a previously-undocumented broken user path; all resolve to either (a) already-known, already-labeled-honest deferred work, or (b) the two genuinely new items called out above (email daily-limit soft cap, oauth-stub server endpoint).

---

## Top 5 most severe findings

1. **`MarketingConsent`'s write path is unreachable, so the `marketing.check_consent` compliance tool can never return "consented."** `SuppressionService.recordConsent()` (`suppression.service.ts:149`) has zero callers anywhere in the app, while the read side (`latestConsent`) is live-wired into `real-skill-executor.ts:1156-1201` as a hard gate requiring a `GRANTED` row. Every `check_consent` call will report every address as missing consent, in every environment, until someone builds a UI/API to actually grant consent — this is a compliance feature that looks wired end-to-end (it's in the tool catalog, has a real DB model, has real enforcement logic) but is structurally dead on the write side.

2. **`EMBEDDINGS_PROVIDER` and `STORAGE_PROVIDER` are the only 2 of 5 swappable-provider seams with no production boot guard and no `preflight-env.mjs` check**, despite the exact same "mock-in-production is silent success" pattern that got `LLM_PROVIDER`/`BILLING_PROVIDER`/`SKILL_EXECUTOR` a hard `requireRealProviderInProduction()` refusal. A production deploy can silently run Knowledge/RAG search on a non-semantic hash-bucket embedding and/or persist uploaded document blobs to a serverless instance's local disk, with zero warning anywhere in the deploy pipeline.

3. **`BrandAsset` is a fully dead table** — real Prisma model, real migration, real `Company.brandAssets` relation, zero application code (no service, controller, DTO, or frontend reference) anywhere in the monorepo. Cluster 01's bulk "marketing tables = ACTIVE" classification missed it because it grouped 9 marketing models together without checking each individually — a reminder that group-level dead-table sweeps can hide a fully dead member of an otherwise-live group.

4. **Four independent instances of stale "enforcement is a TODO / stored only" comments that are now factually wrong** (`schema.prisma:1606-1607` and `:709-713`, `update-security-policy.dto.ts:16-17`, `skills/catalog.ts:220`) — all four features they describe as unenforced are actually live in production code today. This is the same defect class as the previously-fixed `CreditLedger` "deliberately INERT" schema comment (cluster 01, finding #1) recurring — suggesting this codebase's habit of leaving a stale "not yet enforced" comment behind after shipping the enforcement is systemic, not a one-off, and worth a dedicated cleanup pass.

5. **`WF_COMPENSATE_QUEUE`/`WF_DLQ_QUEUE` are registered BullMQ queues with zero producer and zero consumer anywhere in the code** (`workflow-runtime.module.ts:46-47`). Almost certainly intentional (matches the standing "compensation deliberately NOT implemented" decision, and the queue names are pre-declared in the DLQ monitoring allowlist for when they're eventually wired) — but unlike the codebase's own precedent for this exact situation (`engines/support/support.constants.ts:18-31`'s explicit "RESERVED, NOT WIRED" comment block), these two carry no equivalent self-documentation, so a future engineer has no signal distinguishing "reserved on purpose" from "wired half-way and forgotten."
