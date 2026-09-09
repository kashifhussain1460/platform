# Orlixa (V-AEP) — Final CTO / Kill-Critic / Production Ground-Truth Audit

**Date:** 2026-09-09. **Scope:** full monorepo at `d:/Vertical AI/platform` (apps/api NestJS, apps/web Next.js,
packages/types, infra). **Method:** 12 independent evidence passes (2 from 2026-09-08, 10 from this session),
each reading actual code/schema/tests rather than trusting docs, cross-checked against each other. Two clusters
(A.2, A.3) actually **ran** the test suites and a real browser against the live stack rather than quoting
numbers. Full backing evidence with exact file:line citations lives in the 12 cluster files in this folder
(`01`–`12`); this document is the synthesis.

**How to read this:** every claim below is graded the same way the clusters graded it — FULLY IMPLEMENTED,
PARTIALLY IMPLEMENTED, BROKEN, UNREACHABLE, MOCK/FAKE, UNUSED, LEGACY, DUPLICATE, PLANNED ONLY, or PRODUCTION
READY. Nothing here is inferred from a table existing, an API existing, or a comment claiming something works —
`platform/CLAUDE.md` itself was treated as a hypothesis throughout and is shown to be wrong or stale in at
least 9 separate places below.

---

## 1. Executive Verdict

**What is Orlixa today?** A real **AI Employee platform**, not a demo. A company hires named AI Employees
(HR, Sales, Marketing, Support, Recruiter, Finance, PM, Custom), each backed by one real, shared agent runtime
(plan → retrieve knowledge → recall memory → act with tools → validate) that is genuinely reused — not
duplicated — between live chat and workflow steps. On top of that sits a real workflow engine (two
implementations, one default) and a genuinely AI-assisted workflow builder, both far more complete than a
typical MVP. Underneath, roughly a third of the "advanced" surface (credits/billing enforcement, three
self-hosted engine integrations, semantic knowledge search, multi-workflow employee ownership) is either
switched off by default, unreachable in production, or was never wired past the schema — and several places
where the codebase's own documentation claims something is fixed or enforced are now stale.

**The single most important meta-finding:** this codebase has a **recurring, systemic habit of leaving a
"not yet enforced" comment in place after the enforcement actually ships.** Found independently, in unrelated
subsystems, **six separate times** this pass (credit-system schema comments, `maxCreditsPerExecution`,
`sessionTimeoutMinutes`, `allowedEmailDomains`, Stripe-credential encryption, the workflow RETRIEVE-node scope
claim in CLAUDE.md itself). Every one of the six actually turned out to be *already fixed* — good news for the
product, bad news for anyone (including a future auditor, or you) who trusts a comment instead of the code.

**Second most important meta-finding, the opposite direction:** `platform/CLAUDE.md`'s testing section claims
"745 e2e (101 suites) + 1058 unit (105 suites) + 13 browser, all green, both engine modes 465/465." This audit
actually ran all of it. The real numbers are higher (110/110 unit, 767/767 e2e in the default engine) — but
running the **second** engine mode, exactly as CLAUDE.md itself instructs, surfaced **4 real, currently-broken
e2e failures** (a `WORKFLOW`-kind approval never lets its run complete under `legacy_walk`) that no one has
caught since the "465/465" claim was made. This is a live regression, not a stale doc — see §37.

| Area | Completion | Production Readiness | Status |
|---|---|---|---|
| Product Concept | High | — | AI Employee platform is coherent and real, not aspirational marketing |
| Backend | High | Mostly ready | NestJS modules are real, tested, mostly enforced; gaps are specific and named below |
| Frontend | High | Mostly ready | Unusually well-wired for an MVP-stage product; near-zero hardcoded/fake data found |
| Database | High | Ready | Schema is large but mostly ACTIVE; only 1 fully dead table (`BrandAsset`) found out of ~90+ models |
| AI Employee | High | Ready | Real runtime, no fake execution anywhere; catalog fragmentation and 2 dead-end roles are the gaps |
| Agent Architecture | High | Ready | No separate "Agent" concept needed or missing; AiEmployee+Workflow+Skill already cover it cleanly |
| AI Assist | High | Ready with one serious gap | Real, validated, safe — except it never wires the trigger it was asked for |
| Workflow Engine | Medium-High | Ready in default mode only | Two engines exist; the non-default one has a live broken approval-resume bug and no retry story |
| Skills | High | Ready, with named exceptions | 11/17 skills fully real; 4 honestly mocked; 2 (Chatwoot/Plane) are real code with no way to ever connect |
| Connections | High | Mostly ready | OAuth/PKCE is solid; one skill (WhatsApp) has a misleading "Connected" badge on the generic connect page |
| Knowledge | Medium-High | Ready only if reconfigured | Real RAG pipeline end to end, but the *default* embedding is lexical, not semantic |
| Memory | Medium | Partially ready | Real and used, but silently caps at ~5 recent items with no ranking; UI doesn't reflect this |
| Permissions | High | Mostly ready | RBAC + department scoping + workflow RUN-gating are real; RUN-gating is enqueue-time only |
| Approvals | High | Ready (default engine) | Routing, SLA, chains all real and race-safe; broken specifically under `legacy_walk` (see above) |
| Credits/Billing | Medium | Off by default | Fully built and correctly attributed once enabled — but shipped default is unmetered AI spend |
| Integrations | Low-Medium | Not production-usable (3 of 4) | Only Twilio WhatsApp is usable by a real customer today; Postiz/Chatwoot/Plane all have deployment or provisioning gaps |
| Security | High | Ready | Every historically-flagged critical regression was re-verified closed; nothing currently exploitable found |
| E2E | High, with one exception | Mostly ready | Verified by actually running it; one real regression found in the non-default engine mode |
| Business Flow | High | Ready | Signup → onboarding → hire → connect → workflow → run → audit is a real, working, dynamically-configured path |

---

## 2 & 20. Actual system architecture (verified, not hypothesized)

```
Company (tenant)
 ↓
Configuration (industry/goals/departments/roles/plan)  — REAL, dynamically resolved, test-proven (§26)
 ↓
Users/Roles/Departments — REAL RBAC + department scoping (opt-in, ships inert until scopes are set)
 ↓
AI Employees (AiEmployee) — REAL, single identity primitive, no separate "Agent" table exists or is needed
 ↓
Skills(+Connections) / Knowledge / Memory / Policy(budget/approvalRules)
   Skills:      11/17 REAL, 4 honestly MOCK, 2 (Chatwoot/Plane) REAL-BUT-UNREACHABLE
   Knowledge:   REAL pipeline, default embedding is LEXICAL not semantic
   Memory:      REAL but silently caps at ~5 most-recent items, no ranking
   Policy:      budgetLimit REAL; maxCreditsPerExecution REAL (contradicts a stale schema comment)
 ↓
AI Assist (conversational workflow builder) — REAL, safe, well-validated; does NOT wire triggers (§18)
 ↓
Workflows (graph, versions, templates: 24 first-party, not 22 as CLAUDE.md claims)
 ↓
Workflow Runtime — TWO engines: durable state_machine (default, full retry/failure taxonomy)
                   and legacy_walk (no retry, currently BROKEN for WORKFLOW-approval resume — §37)
                   `inline` execution mode (serverless) ALWAYS forces legacy_walk
 ↓
Tools/Engines — Skills → real HTTP where a real executor exists; 3 of 4 self-hosted engines
                (Postiz/Chatwoot/Plane) have no deployed instance and 2 of those 3 have literally
                no code path to connect one even if deployed
 ↓
External Services — Twilio WhatsApp is the one fully customer-usable integration today
 ↓
Execution — actingEmployeeId is written and shown in the UI but is DISPLAY-ONLY; every real
            decision (connector choice, approval routing, credit attribution) uses an independent
            per-node employeeId that predates it
 ↓
Audit/Usage/Credits/Analytics — Audit is real and complete. Usage/Credits are fully built and
            correctly attributed but OFF BY DEFAULT (unmetered AI spend is the shipped default,
            named as a risk by the codebase's own deploy preflight script)
```

**Employee lifecycle is the sharpest gap in this diagram**: pausing, disabling, or archiving an AI Employee
does **not** stop any scheduled or event-triggered workflow that references it — only the chat surface checks
employee status. See §27/§37 P0-1.

---

## 3. Monorepo + module inventory

Zero orphan backend modules (every one of ~40 is reachable from `AppModule`, directly or via a real importer).
16 BullMQ processors, all with a real producer; 2 queues (`wf-compensate`, `wf-dlq`) are registered with neither
producer nor consumer — almost certainly the documented "compensation deliberately not implemented" decision,
but undocumented as such (unlike a sibling queue in `engines/support` that explicitly says "RESERVED, NOT
WIRED"). Frontend: 154 of 157 components (98%) have live call sites; the 3 dead ones are two intentionally-kept
legacy demo files and one built-but-never-adopted `DisabledControl.tsx`. Full detail: cluster `01`, `12`.

---

## 4. Database complete snapshot

~90+ Prisma models, almost all ACTIVE. Only one fully dead table found across the whole schema: **`BrandAsset`**
— real model, real migration, real `Company.brandAssets` relation, zero application code anywhere (missed by
the first bulk marketing-table classification because it grouped 9 marketing models together without checking
each one). The credit-system's 14 tables are correctly described as feature-flag-**dormant**, not dead — every
one has a real writer, and the schema's own "deliberately INERT" comment is simply wrong. Full detail: cluster
`01` (§B/§C), `12` (§0/§1).

---

## 5. Mock/unused/dead database table audit — headline results

| Class | Examples |
|---|---|
| Genuinely dead (no writer or reader anywhere) | `BrandAsset` |
| Write path unreachable (read side live, write side dead) | `MarketingConsent` — `recordConsent()` has zero callers, so the `marketing.check_consent` compliance tool can **never** report "consented," in any environment, forever, until someone builds a UI/API for it |
| Feature-flag-dormant, not dead (real writers exist) | All 14 credit-system tables |
| Column shipped ahead of its own consuming feature | `WorkflowRun.actingEmployeeId` — real, indexed, displayed, but **nothing** queries by it and no functional decision reads it |
| "Ships inert" by design, not a bug | `Department.scopes` (empty by default = unrestricted; a real editor UI exists, just unused by most tenants) |

Full detail: clusters `01`, `10`, `12`.

---

## 6–8. AI Employee inventory, unused, and mock employees

Four independent, hand-maintained catalogs describe the same 8-role roster (Prisma enum, onboarding catalog,
marketplace catalog, and a public-marketing-site catalog that can't even import the backend package). No fake
execution was found anywhere — both chat and the workflow `AI_EMPLOYEE_STEP` node genuinely share one real
agent runtime. But the catalogs have drifted from each other in ways that already show up as real product bugs:

- **The public marketing site advertises three example workflows that were deliberately deleted from the
  product** ("Resume → score → schedule", "Sales outreach", "Support triage" — all three named in the API's
  own `MARKETPLACE_RETIRED_WORKFLOWS` list), in direct violation of the marketing file's own rule that example
  workflows are only shown when a real template exists.
- **`RECRUITER` — the platform's flagship recruiting persona — has zero workflow templates it can ever
  satisfy.** All 11 candidate-facing HR/recruiting templates require role `HR`, never `RECRUITER`. This is the
  exact "installable in the gallery, unusable in every template" bug the codebase's own comments say was
  already found and fixed once for `MarketingAI` — recurring, unnoticed, for `RECRUITER`.
- `ACCOUNTANT` and `PROJECT_MANAGER` are hireable through all 3 entry points and marketed with specific
  responsibilities, but have **zero e2e coverage of any kind** and zero workflow templates — nothing is known
  broken, nothing beyond generic chat has ever been proven to work.
- Below Enterprise, no plan can hire more than 2 distinct roles — but HR, Marketing, and Sales **all three**
  now have real, plan-gated (`BUSINESS`) automation. A Growth ($40) customer can never reach all three without
  a custom Enterprise deal, and the plan doc's own example glosses over this.

Full detail: cluster `02`.

---

## 9–11. Skills complete audit

**The most self-auditing part of the codebase** — the catalog cannot claim a skill is real without a matching
case in the executor (a spec fails the build otherwise), and a real OAuth gate refuses to connect a skill with
no real executor at all. 11 of 17 skills are fully REAL with genuine external HTTP calls traced end to end; 4
(`stripe`, `github`, `hubspot`, `jira`) are honestly labeled MOCK and blocked from real connection in
production; the frontend shows an honest "Demo only" state rather than a fake Connect button. That said, three
concrete gaps survived this discipline:

- **Chatwoot and Plane are permanently unreachable in production, and the workflow-readiness gate hides it.**
  No code path anywhere creates the account/workspace row their otherwise-real executors depend on — yet
  `SkillRequirementsService` reports both skills `READY` at publish time, so a workflow author gets a green
  light to ship something mathematically guaranteed to fail its first real run.
- **The WhatsApp skill's generic Skills-catalog connect path writes a "Connected" badge the real executor never
  reads** — no provider adapter is registered for it, so the credential-validation gate that exists precisely
  to prevent this is silently skipped. The *correct* dedicated `/leads/whatsapp-connect` page does verify —
  nothing stops a user finding the wrong one first.
- `chatwoot.resolve_conversation` is catalogued REAL (passes the drift-guard test) while being hardcoded to
  always return failure.

Full detail: cluster `03`.

---

## 12–14, 20–22. Workflow templates + engine

24 first-party templates (11 HR + 11 Marketing + 2 Sales — CLAUDE.md's "22" is stale and misses the Sales
catalog entirely). The old marketplace code-catalog workflow templates were genuinely **retired** (not merely
"coexisting" as CLAUDE.md still claims) — a real cleanup that was never logged in module-status memory.

**Two workflow engines exist and share node semantics via one registry (no drift risk there), but reimplement
control flow, retries, and the approval gate independently:**

- `legacy_walk` has **no retry mechanism at all** and never writes a failure classification.
- `WORKFLOW_EXECUTION_MODE=inline` (the serverless deployment shape this codebase explicitly built) **always
  forces `legacy_walk`** regardless of the durable-engine setting — so the durable engine's substantial
  reliability investment (retry, backoff, failure taxonomy, resumable leases) is architecturally unreachable
  for that entire deployment shape, not merely under-tested in it.
- **The approval gate is duplicated, not shared, between the two engines** — kept "byte-compatible" by
  convention and comment discipline, which is exactly the kind of divergence that already caused a real
  production-safety gap once (a high-risk tool executing with no approval gate at all under the durable
  engine). All 5 previously-reported durable-only gaps from that incident are confirmed fixed today.
- **The "frozen-17, no banned node types" rule is enforced only inside the AI Assist agent and by first-party
  catalog unit tests — not by the shared validator every workflow and template actually passes through.** A
  tenant-authored template or hand-built workflow can legally use the banned legacy node types today (currently
  moot only because the tenant-template endpoint has no frontend caller). The older `POST /workflows/generate`
  generator still actively emits the banned vocabulary — including in its own hardcoded fallback — and remains
  one env-var flip away from being live again.
- **The durable, resumable-timer machinery is fully built on the read side and has zero writers anywhere** —
  WAIT remains a bounded 10-second in-process sleep in both engines, exactly as before the durable engine
  existed. Verified dead code, not a regression.

Full detail: cluster `04`.

---

## 15–17. Knowledge / RAG + Memory

The full pipeline (upload → storage → chunk/embed → pgvector search → role-scoped retrieval → chat injection →
workflow RETRIEVE node) is genuinely real end to end, with no mocked link. Two real gaps:

- **The default embedding provider (`hash`) is a real, deterministic bag-of-words hash — lexical, not
  semantic.** It matches literal shared vocabulary and nothing else (no synonyms, no paraphrase). A production
  deployment that never explicitly sets `local` or `openai` gets search that looks like semantic search in the
  UI but functions as keyword matching underneath.
- **Memory crowd-out is real and independently confirmed three ways**: a hard 5-item recency window with no
  importance ranking, no `kind` filter (so ordinary chat-summary noise pushes out taught facts), and a Learning
  panel UI that shows *every* fact ever taught with no cap — so an employee can visibly appear to "know" 10
  things while functionally recalling at most 5, whichever are newest.

One correction *to* CLAUDE.md itself: it claims the workflow RETRIEVE node "stays intentionally unscoped
(company-wide)" — the code, 7 pinned tests, and a separate prior audit all agree this was hardened to strict
role-based scoping and the doc line is simply out of date (the safer direction, but still wrong).

Full detail: cluster `05`.

---

## 18–19. AI Assist + Agent architecture

AI Assist is **not** spec-only — it's a fully built, safe, well-validated conversational workflow builder,
genuinely sharing the same publish-time validation as manual authoring, with a live in-chat skill-connect OAuth
flow still working exactly as shipped. One severe, confirmed gap:

**AI Assist never wires the trigger it was asked for.** The TRIGGER node it can generate has zero configurable
fields; `Workflow.triggerType` defaults to `MANUAL` and is only ever set through a separate manual UI path that
`accept()` never touches. A user can describe "when a CV arrives by email," get a fully validated,
dry-run-tested, "ready" workflow — and it will only ever run when a human clicks Run, with nothing in the
product telling them their described trigger didn't take effect. This is the same "green run, wrong behavior"
defect class the codebase has a name for elsewhere, reproduced here uncaught.

Second gap: `AssistService.accept()` has no server-side idempotency guard — calling it twice creates two real,
separate workflows, the first silently orphaned. The only protection is a client-side React ref that doesn't
survive two browser tabs.

**No separate "Agent" database subsystem exists, and none should be built.** Direct schema search: zero
`Agent*` models. `AiEmployee` (identity) + `Workflow` (behaviour) + `Skill` (capability) + one genuinely shared
`AgentRuntimeService` (not duplicated between chat and workflow steps) already cover every role a new Agent
abstraction would nominally add. The one real gap found (trigger wiring) is a bug in the existing pipeline, not
evidence of a missing concept.

Full detail: cluster `07`.

---

## 21–22, 27. Execution identity + employee lifecycle

**`WorkflowRun.actingEmployeeId` — despite being framed as the platform's headline identity fix — is
functionally display-only.** It's written correctly, indexed, and shown on the runs table, but a full-repo
search shows exactly 4 files ever reference it. Every real decision that needs to know "which employee" —
connector/credential choice, approval routing, credit/usage attribution, workflow-permission gating — already
had, and still uses, an independent, older, per-node `employeeId` convention. The 2026-09-03 fix closed "the
column is dead"; it did not change how execution actually resolves employee identity, which was already fine
via the older mechanism. The index built for it has zero queries using it.

**There is no persistent Workflow↔AiEmployee ownership relationship.** "Which employees does this workflow
involve" is fully derived from graph JSON at read time; a private backend query for the reverse direction
("all workflows for employee X") exists but was never exposed as an API, and the frontend has no UI for it in
either direction from the employee side.

**The single most severe finding of this whole audit:** pausing, disabling, or archiving an AI Employee does
**not** stop workflow execution. Every workflow-engine node handler that resolves an employee does a bare
lookup with no status/archived filter — the *only* status check anywhere in the codebase gates the chat
surface. The "Remove" button's own UI copy ("It will stop working immediately") is factually wrong for any
employee still referenced by an active scheduled or event-triggered workflow — that workflow keeps creating
runs, and those runs keep executing the paused/disabled employee's persona, model, budget, and skill
connections exactly as before.

Full detail: cluster `08`.

---

## 23–24. Frontend + API↔frontend connection audit

Unusually well-wired for this project stage: zero hardcoded data arrays, zero static/fake metrics, zero dead
buttons found anywhere in `apps/web/src`. Every "Connect/Install/Activate" control calls a real mutation.
Confirmed orphans, all real but disconnected:

- `LeadDetail.tsx` fetches but never renders `qualificationData` — the exact site-visit/budget/timeline notes a
  human would check are invisible on the one screen meant to show them.
- `GET /employees/:id/dependencies` and `GET /workflows/:id/dependencies`-equivalent safety-check endpoints are
  both fully built, richly informative, and both orphaned — the delete buttons on both employee and workflow
  cards fire the mutation directly behind a generic hardcoded confirm string instead.
- Three `internal/platform-admin/*` real-money endpoints (credit enforcement toggle, finance rollup, manual
  credit adjustment) have zero UI anywhere — curl-only by design, but worth naming plainly.
- `POST /workflow-templates` (author a tenant template) has no frontend caller at all.

Full detail: clusters `06`, `07`, `08`.

---

## 25, 40. Business flow (verified end to end)

Signup → onboarding (industry/goals/departments/roles/plan, all genuinely consumed downstream, §26) → hire an
AI Employee (seat-checked atomically across all 3 hire paths) → connect a skill (OAuth/PKCE real, or an honest
"Demo only" for the 4 mock skills) → upload knowledge (real pipeline) → build a workflow (manually or via AI
Assist, both validated identically) → publish/activate → trigger fires → run executes (durable engine by
default) → approval gate (routed, SLA'd, race-safe) → tool call (real where the skill is real) → result →
audit (hash-chained, complete) → credit ledger (correctly attributed — but off by default). **This entire path
was proven live in a real browser** (Playwright specs 01–05, 13/13 passing) — signup through execution through
audit, in one continuous session, against the real stack. The one broken link in an otherwise-intact flow is
the credit/billing tail being switched off in the shipped default, and the employee-lifecycle gap (§27) sitting
upstream of "run executes."

Full detail: clusters `06`, `11` (browser proof), and the billing trace in `10`.

---

## 26. Configuration-driven architecture

**Genuinely dynamic, not a static shell** — independently confirmed by both static analysis and a live test
run. Industry, business goals, departments, and hired-employee roles all branch through real, differentiated
lookup tables (test-proven with an exhaustive scenario matrix: an HR company and a Marketing company
demonstrably get different unlocked capabilities). The in-flight (uncommitted) role-based seat/plan gating
diff is complete, type-safe end to end, and shares one pure enforcement rule across the hire endpoint,
onboarding pre-flight, and the display layer. Two real gaps:

- **The frontend's product-context cache is never invalidated by the mutations its own code comment claims
  invalidate it.** Confirmed live: a real Playwright browser run hired a second employee and the seat counter
  stayed stale for the full 30-second test window — a code-reading finding and a live browser failure
  independently converging on the same root cause.
- `Company.size` and `Company.description` are captured and stored but never consumed by anything.

Full detail: cluster `11`.

---

## 28. Security

**Nothing currently exploitable was found.** Every specific regression CLAUDE.md flags as a historical
incident — the approval-decision `@Roles` guard removal, the fixed-OTP password-reset account-takeover, and
the durable-engine approval-gate bypass — was re-verified against the **current** code (not the commit message
that claimed to fix it) and all three are closed with real structural evidence: a named regression test, an
in-process boot guard that refuses to start, and a re-entrant Postgres-backed gate shared by both engines.
Tenant isolation, credential encryption (AES-256-GCM, refuses to boot without a real key in production), HR PII
encryption (proven by e2e reading raw DB rows, not just claimed), OAuth PKCE + replay protection, and webhook
signature verification (Twilio/Stripe/generic connectors, all verified before any DB write) are all real. Minor
residual items: CORS supports only one static origin (not a vulnerability, an operational limitation);
connector webhook replay protection has no timestamp/nonce window (documented, tracked); one real (non-secret)
company email address committed in `.env.example`.

Full detail: cluster `09`.

---

## 29–30. Billing/Credit/Usage + Engine integrations

Attribution is real: every credit-ledger row carries employee/workflow/run/step ids, and the historical
"Credits 0" display bug is genuinely fixed at the data layer. Budget enforcement is real and pre-flight
(checked before every reservation, re-checked per loop iteration, hard-capped per run). **But every one of
these checks is gated behind flags that all default `false` — the shipped default is unmetered AI spend,
exactly as the codebase's own deploy preflight script names it in plain language: "All AI work is free and
unmetered."** The one always-on safety net caps concurrency (10 simultaneous executions per company), not
cumulative spend over time. **A new, independently-discovered gap**: AI Assist sessions are completely invisible
to the credit system — metered only in a separate, non-customer-facing usage log, never reserved, debited, or
enforced, even with every credit flag on.

Of the four third-party engine integrations: only **Twilio WhatsApp** is genuinely usable by a real customer
today (self-service, verified-before-connect, no infrastructure dependency). Postiz has real code but requires
an admin-only, self-service-less prerequisite. **Chatwoot and Plane cannot be connected to a company by any
code path that exists today, regardless of infrastructure** — `provisionAccount()`/`provisionWorkspace()` both
throw "not yet implemented," and `infra/docker-compose.yml` doesn't even define the containers `.env.example`
assumes exist.

Full detail: cluster `10`.

---

## 31–34. Master unused / mock / dead / duplicate inventory

| Category | Items |
|---|---|
| **Dead** | `BrandAsset` table; `FaceMesh.tsx`; `DisabledControl.tsx`; `WF_COMPENSATE_QUEUE`/`WF_DLQ_QUEUE` (reserved, undocumented as such) |
| **Write-path-dead (looks live, isn't)** | `MarketingConsent` — compliance tool permanently reports false |
| **Unreachable in production** | Chatwoot, Plane (no provisioning path); Postiz (admin-only prerequisite) |
| **Display-only / schema-ahead-of-feature** | `WorkflowRun.actingEmployeeId` and its index |
| **Mock, honestly labeled** | `stripe`, `github`, `hubspot`, `jira` skills |
| **Retired, correctly cleaned up** | Marketplace code-catalog's 3 legacy workflow templates |
| **Legacy, still reachable via flag** | `POST /workflows/generate` (superseded by AI Assist, still emits banned node vocab, one flag flip from live again) |
| **Duplicate mechanism (deliberate, low-risk)** | Two workflow engines' approval gates (byte-compatible by convention, not by shared code) |
| **Stale "not enforced" comments (systemic pattern, 6 confirmed instances)** | Credit tables, `maxCreditsPerExecution`, `sessionTimeoutMinutes`, `allowedEmailDomains`, Stripe credential encryption, CLAUDE.md's RETRIEVE-node claim — all describe already-shipped enforcement as still pending |
| **Four independent AI-Employee catalogs, no shared source of truth** | Prisma enum / onboarding catalog / marketplace catalog / public marketing-site catalog |

Full detail: clusters `01`, `12` primarily, cross-referenced throughout.

---

## 35. Testing + browser E2E — actually run, not quoted

| Suite | Result (actually observed) |
|---|---|
| Unit (`apps/api`) | **110/110 suites, 1139/1139 tests, PASS** (higher than CLAUDE.md's stale 105/1058) |
| E2E, durable engine (default) | **103/103 suites, 767/767 tests, PASS** |
| E2E, `legacy_walk` engine | **99/103 suites, 763/767 tests — 4 REAL FAILURES**, all the same symptom: a WORKFLOW-kind approval is correctly approved but the run never leaves `WAITING`. This directly contradicts CLAUDE.md's "both modes 465/465" claim and is a live, currently-unfixed regression |
| Playwright browser (real stack, real browser) | **13/14 passing.** The one failure is a live reproduction of the product-context cache bug (§26) |
| Any real external provider (OpenAI/Anthropic/Stripe/Twilio/Postiz/Chatwoot/Plane) | **Zero automated coverage anywhere, by explicit design** — every CI workflow and local test setup forcibly blanks every real credential. "All green" proves the mock code paths and DB/state-machine logic are correct; it proves nothing about whether a real LLM call, a real charge, or a real WhatsApp send actually works. This is deliberate and documented, not hidden — but worth stating plainly since it doesn't get re-stated every time "all green" is quoted. |

Full detail: cluster `11`.

---

## 36. Critical dependency matrix

| Dependency | Status | Business impact |
|---|---|---|
| Company → Configuration | REAL, dynamic | Low risk |
| Configuration → Capability | REAL, dynamic, test-proven | Low risk |
| Employee → Workflow | REAL (derived, no FK) | No "all workflows for X" view — a real gap for support/ops, not a safety issue |
| Workflow → Employee Runtime | REAL, unified (not duplicated) | Low risk |
| Workflow → Trigger | **BROKEN specifically for AI-Assist-generated workflows** | High — silent no-op automation |
| Workflow → Skill | REAL | Low risk, except 2 skills (Chatwoot/Plane) that pass readiness but can never run |
| Skill → Connection | REAL for skills with a real executor | Medium — WhatsApp generic-connect badge is misleading |
| Employee → Knowledge | REAL | Low risk, semantic quality depends on embedding provider config |
| Employee → Permission | REAL | Low risk |
| Employee → Approval | REAL (routing/SLA), **BROKEN under legacy_walk** | High while that engine mode is in use |
| Employee → Budget | REAL, flag-gated off by default | **High — this is the shipped default** |
| Employee → Usage | REAL for chat/workflow, **MISSING for AI Assist** | Medium |
| Employee → Audit | REAL, complete | Low risk |
| Employee status → Workflow execution | **BROKEN — pause/disable/archive doesn't stop scheduled/event runs** | **High — the most severe single finding in this audit** |
| AI Assist → Employee | REAL (binds existing, never creates) | Low risk |
| AI Assist → Workflow | REAL, validated identically to manual | Low risk except trigger wiring (above) |
| Template → Workflow | REAL | Low risk |
| Knowledge → Retrieval | REAL, but lexical-only by default | Medium |

---

## 37. Production readiness

### Can a real company safely use Orlixa today?

**YES, WITH CONDITIONS.** The core loop (hire → connect → build → run → audit) is real, tested, and was proven
live in a browser. The conditions that matter, in order:

**P0 — must fix or explicitly accept before any customer whose workflows include pausing/disabling employees,
or before enabling `legacy_walk`/`inline` mode, or before selling metered usage:**
1. **Employee pause/disable/archive does not stop workflow execution.** (cluster `08`)
2. **`legacy_walk` engine: a WORKFLOW-kind approval never lets its run complete** — a live, reproduced
   regression, and `inline`/serverless deployment always forces this engine. (cluster `11`, `04`)
3. **Shipped default = unmetered AI spend**, named as a risk by the codebase's own preflight script; the one
   always-on safety net bounds concurrency, not cumulative cost. (cluster `10`)
4. **AI Assist spend is completely invisible to the credit system**, even with every flag on. (cluster `10`)
5. **AI-Assist-generated workflows silently default to `MANUAL` trigger** regardless of what the user described
   — "ready" and "published" but never actually automated until a human notices and fixes it by hand. (cluster `07`)
6. **Chatwoot and Plane pass workflow-readiness checks but can never actually run** — a customer building a
   Support/PM workflow around either gets no warning until the first real failure. (cluster `03`)
7. **The public marketing site advertises workflows that don't exist**, and the flagship `RECRUITER` role has
   zero usable recruiting automation. (cluster `02`)

**P1 — real gaps, lower urgency:**
- No plan below Enterprise can reach all 3 roles (HR/Marketing/Sales) that now have real automation.
- WhatsApp's generic connect surface writes a meaningless "Connected" badge.
- `actingEmployeeId` is display-only; no employee↔workflow ownership view exists anywhere.
- Frontend product-context cache goes stale after hire/plan-change mutations (confirmed live).
- Default knowledge-search embedding is lexical, not semantic; memory silently caps at ~5 items.
- Two safety-check endpoints (`employees`, `workflows` dependencies) are built and orphaned on the frontend.
- Postiz requires an admin-only prerequisite with no self-service path.
- `MarketingConsent`'s write path is unreachable — `check_consent` can never report success.
- Frozen-node-type enforcement has a real (currently dormant) side door via the tenant-template/legacy-generator paths.

**P2 — cosmetic / cleanup:**
- Six stale "not yet enforced" comments across schema/DTO/catalog files.
- One fully dead table (`BrandAsset`), 3 dead frontend components, 2 unwired reserved queues.
- `EMBEDDINGS_PROVIDER`/`STORAGE_PROVIDER` lack the same production boot-guard the other 3 provider seams have.

---

## 38–39. Final status classification & gap register

See the classification tables embedded in each section above and in the 12 cluster files, which carry every
individual item's classification and exact evidence citation. The P0/P1/P2 lists in §37 constitute the gap
register in priority order; each item there names its current state, evidence location (cluster file), and
business impact inline rather than being repeated a third time here.

---

## 41. Final CTO architecture questions — direct answers

1. **Is the current architecture fundamentally correct?** Yes.
2. **Is AI Employee the correct primary abstraction?** Yes — confirmed by absence of any competing concept.
3. **Should Agent be a separate DB entity?** No — would duplicate AiEmployee/Workflow/Skill for no new capability.
4. **Should Workflow remain the execution layer?** Yes.
5. **Should AI Assist generate workflows for AI Employees?** Yes, and it already does — correctly, except triggers.
6. **Can one employee safely have multiple workflows?** Yes technically (no FK prevents it), but there's no way to see or manage that list today.
7. **Is the Workflow Engine production-ready?** Yes in the default (durable) mode; no in `legacy_walk`/`inline` today.
8. **Is AI Assist production-ready?** Yes, with the trigger-wiring gap as a named exception.
9. **Are Skills production-ready?** Yes for 11 of 17; the rest are honestly labeled or need provisioning work.
10. **Are Connections production-ready?** Yes, with the WhatsApp generic-connect exception.
11. **Is Knowledge actually used?** Yes, genuinely — quality depends on embedding provider configuration.
12. **Is Memory actually used?** Yes, but silently capped; the UI overstates what's actually recalled.
13. **Are Permissions enforced?** Yes.
14. **Are Approvals enforced?** Yes in the default engine; broken in `legacy_walk`.
15. **Are Budgets enforced?** Yes when the flags are on; off by default.
16. **Is Usage correctly attributed?** Yes for chat/workflow; no for AI Assist.
17. **Is Configuration actually driving capabilities?** Yes, genuinely dynamic and test-proven.
18. **Are Departments actually created and used?** Yes; scoping is real but ships inert until an admin configures it.
19. **Are integrations actually used?** Only one of four (Twilio WhatsApp) is customer-usable today.
20. **Are there mock systems pretending to be production?** No systemic pattern found — the 4 mock skills are honestly labeled everywhere checked. The closest exception is WhatsApp's misleading generic-connect badge.
21. **Are there unused AI Employees?** `ACCOUNTANT`/`PROJECT_MANAGER` are unproven (zero e2e); the 3 CUSTOM marketplace templates are demo-only.
22. **Are there unused Skills?** No fully unused skill; 2 (Chatwoot/Plane) are real-but-unreachable.
23. **Are there unused Templates?** The 3 retired marketplace templates (correctly cleaned up).
24. **Are there unused Knowledge records?** Structurally possible (no role-existence check on category) but not confirmed against live data.
25. **Are there completely unused DB tables?** One: `BrandAsset`.
26. **Are there duplicate systems?** Only the two workflow engines' approval gates (deliberate, low-risk today).
27. **Biggest architectural risk?** The two-engine split — proven today by a live, real regression in the non-default mode.
28. **Biggest business/product risk?** Unmetered AI spend by default, compounded by AI Assist being invisible to billing entirely.
29. **Biggest security risk?** None currently exploitable; the nearest thing is CORS single-origin and the webhook replay window, both low severity.
30. **What should NOT be built/rebuilt?** A separate Agent subsystem; a second workflow-template system; a second embeddings/LLM/storage provider-selection mechanism — all already correctly built once.

---

## 42. Final "do not touch" list

- **`AgentRuntimeService`** — one real implementation, genuinely shared between chat and workflow steps. Any
  future work should extend it, not fork it.
- **The skill catalog's self-verifying discipline** (`real-execution-support.ts` failing the build if the
  catalog and executor drift) — this is why the skills audit came back this clean; replicate this pattern
  elsewhere (it would have caught the `actingEmployeeId`/comment-staleness pattern earlier if applied to docs).
- **The capability-resolver / product-context pipeline** — genuinely dynamic, well-tested, correctly labeled as
  advisory-only where it should be. Don't rebuild it to "add enforcement" — enforcement already lives correctly
  in the endpoints themselves.
- **`checkSeatFor()`** — one pure function shared by all 4 real call sites (hire, onboarding, display, resolver).
- **The approval routing/SLA system** — race-safe, chain-aware, well-tested. Fix the `legacy_walk` resume bug;
  don't redesign the routing model itself.
- **Webhook signature verification patterns** (Twilio, generic connectors) — grounded in reading the real
  providers' own source, careful about ordering (verify before persist). Reuse this pattern for any new
  integration rather than inventing a new one.

---

## 43. Final CTO verdict

**Continue building:** the AI Employee + Workflow + Skill core; AI Assist (once trigger-wiring is fixed); the
durable engine (make it the *only* engine, see below); role-based hiring/seat enforcement (already real, just
needs to be committed and its plan-tier gap addressed).

**Stop building:** new engine integrations before fixing the two that already have real code but no way to
connect (Chatwoot, Plane) — shipping a fifth integration while two existing ones are permanently unreachable is
the wrong sequencing.

**Remove:** the legacy `WORKFLOW_ENGINE_MODE=legacy_walk` path once its approval-resume bug is triaged — either
fix it or retire it; maintaining two engines with independently-reimplemented approval gates is the single
biggest structural risk this audit found, and it just produced a second real bug from the same root cause
(duplication) that produced the first one (the G25 bypass).

**Consolidate:** the four AI-Employee catalogs into one source of truth (even a generated/shared file across
the API/web boundary); the six stale "not enforced" comments into an accurate state.

**Fix immediately (P0, see §37):** employee-lifecycle enforcement in the workflow engine; the `legacy_walk`
approval-resume regression; AI Assist trigger wiring; the marketing-site/RECRUITER automation-promise gap;
Chatwoot/Plane's readiness-check honesty.

**Postpone:** new provider integrations beyond WhatsApp; semantic memory ranking; multi-origin CORS; durable
WAIT — none of these are blocking today's real usage.

### Next 10 implementation priorities, strictly ordered

1. **Make workflow-engine node handlers respect employee status/archivedAt** — the single highest-impact, most
   surprising gap found (cluster `08`).
2. **Fix (or retire) the `legacy_walk` WORKFLOW-approval-resume regression** — a live, reproduced failure
   (cluster `11`), and the deployment shape that forces this engine (`inline`) is a documented, intended path.
3. **Wire AI-Assist-generated triggers into `Workflow.triggerType`/`triggerConfig`** — currently silent
   no-op automation (cluster `07`).
4. **Decide and communicate the credit-enforcement rollout plan** — the shipped default is named a P0 risk by
   the codebase's own preflight script; either flip the flags for new signups or put a hard concurrency+time
   ceiling in place until billing enforcement is turned on (cluster `10`).
5. **Wire AI Assist into the credit ledger** — the one LLM entry point currently invisible to billing
   (cluster `10`).
6. **Fix the RECRUITER→HR template-role mismatch and correct the marketing site's example-workflow claims** —
   a customer-facing promise gap, cheap to fix (cluster `02`).
7. **Make `SkillRequirementsService` distinguish "no connection needed" from "cannot ever be connected"** for
   Chatwoot/Plane, so workflow readiness stops lying about them (cluster `03`).
8. **Fix the frontend product-context cache invalidation** — confirmed live in a real browser test
   (cluster `11`).
9. **Wire the two orphaned safety-check endpoints** (`employees`/`workflows` dependencies) into their delete
   confirmation dialogs — small, prevents real data-loss surprises (clusters `06`, `08`).
10. **Delete the 6 stale "not enforced" comments and add the missing production boot guards for
    `EMBEDDINGS_PROVIDER`/`STORAGE_PROVIDER`** — cheap, closes a systemic documentation-trust risk before the
    next person (or audit) is misled by it (cluster `12`).

---

## 44. Final one-sentence architecture decision

> **"If Orlixa continues from the current codebase, the correct architectural direction is: keep the AiEmployee
> + Workflow + Skill model exactly as it is, retire the duplicated `legacy_walk` engine in favor of the durable
> state machine as the only execution path, and close the handful of specific wiring gaps (employee-lifecycle
> enforcement, AI-Assist trigger translation, credit-flag rollout) that sit between an already-well-built
> platform and one that is fully honest about what it can do today."**
