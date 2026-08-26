# ORLIXA — PRODUCTION KILL-CRITIC AUDIT

**Date:** 2026-08-22
**Auditor role:** founder / CTO / principal architect / staff backend / QA lead / security reviewer / kill critic
**Codebase audited:** `d:\Vertical AI\platform` (monorepo, commit `4ef3e1e` + 222 uncommitted files)
**Method:** code-level tracing only. No feature was scored on the existence of a file, table, endpoint, page or test. Every claim below has a file/line citation or a command output behind it.

---

## 0. How to read this report

Three numbers are calculated, not guessed. Each has its formula shown in §13.

Where I could not get evidence, I say so instead of guessing. There is exactly one such place (the full e2e suite — see §0.2).

### 0.1 What I actually ran

| Check | Result |
|---|---|
| API unit suite (`jest -c test/jest-unit.json`) | **90 suites, 793 tests, all passed**, 33s. Verified this session. |
| API e2e suite (91 suites) | **Not completed.** See below. |
| Docker infra (postgres 5433, redis 6380, minio, prometheus, jaeger) | Up and reachable. |
| Codebase size | API `src` 56,920 lines · API `test` 23,310 lines · API unit specs 12,115 lines · Web `src` 34,379 lines · 80 Prisma models · 62 migrations |

### 0.2 The one thing I could not verify

I started the full e2e suite twice. Neither run finished. The cause is environmental, not a product defect:

- Two orphaned jest processes from **2026-08-20 23:42** (`workflow-templates.e2e-spec`, pids 32988/5380) were still alive and connected to the shared Redis.
- Redis reported **123 connected clients** (documented idle baseline is ~2).
- My own run's worker (pid 5476) sat at a frozen 218s CPU for over an hour — hung, not working.

This is the exact trap already written down in `CLAUDE.md` ("leftover dev servers and orphaned jest runs stay connected to the shared Redis and consume BullMQ jobs with old compiled code"). I attempted to kill the orphans and was **denied permission by the sandbox**, so I stopped chasing it.

**What this means for the report:** every e2e-related statement below is based on reading the specs and the CI config, not on a green run I personally observed. The unit suite result *is* mine. Treat "477 e2e tests green" in `CLAUDE.md` as unverified-by-me, not as disproved.

**Recommended action for the team:** kill those two 2-day-old jest processes before anyone trusts another workflow e2e result.

---

# 1. Executive Verdict

> ### Actual Product Concept Completion: **61%**
> ### Production Readiness: **67%**
> ### Configuration Dependency Completion: **68%**
> ### Configuration-Driven Architecture (Audit Area A): **45%**

**FINAL VERDICT: B — CORE PRODUCT PARTIALLY REALIZED.**

### The one-paragraph version

Orlixa has a genuinely strong *engine* and a genuinely weak *product*. The backend is better than most Series-A codebases I have read: a real durable execution state machine that is on by default, a pure-function authorization policy with department scoping, AES-GCM credential encryption, a 13-phase credit ledger with reservations and reconciliation, 62 migrations, real CI running e2e in both engine modes, and 793 unit tests that I watched pass. That is not a prototype.

But the product on top of it does not do the one thing the concept is built around. **Configuration does not drive the product.** A company tells Orlixa its industry, its size, its business goals and which AI Employees it wants — and then gets the same flat skill catalog, the same static sidebar, the same six generic dashboard tiles and the same unfiltered template list as everyone else. The live onboarding wizard literally sends `departments: []` to the server ([OnboardingWizard.tsx:103](apps/web/src/features/onboarding/components/OnboardingWizard.tsx#L103)), which means the department layer — the axis the whole authorization engine is scoped on — is empty for every tenant that has ever signed up.

The second theme is **backend without frontend**. Several complete, tested, migrated backend waves have no product surface at all: the entire HR domain (6 models, PII encryption, retention sweeps), workflow permissions, approval routing and SLA, department scopes, user-to-department assignment, per-employee model choice. These are not half-built — they are fully built and unreachable.

The third theme is **controls that look real and are not**. Seven checkboxes in the AI Employee Settings panel write JSON that no code path ever reads. `AiEmployee.model` is stored and never sent to the LLM. `WorkflowRun.actingEmployeeId` — the column that would make the PRD's headline claim ("every run is attributed to an Employee") true — is written by nothing and read by nothing.

---

# 2. What Orlixa Was Originally Intended To Be

Reconstructed from `docs/product/2026-08-01-orlixa-prd.md`, `docs/architecture/workflow-system/*`, the original V-AEP proposal, and the shipped flows.

**The concept:** a company hires AI Employees the way it hires people, instead of buying chatbot seats or wiring automations by hand.

The PRD states the differentiator plainly (§3 Product Vision):

> "An AI Employee is a digital member of staff, not a workflow engine with a chat window bolted on… the Employee is the primary abstraction — it has a role, a budget, a manager, permissions, and KPIs — and a workflow is simply one thing that Employee does."

Five specific promises follow from that, and they are the right things to audit against:

| # | The promise (PRD §3, §5) | Verdict |
|---|---|---|
| P1 | **Every run is attributed to an Employee**, not just a workflow. Cost, tokens, KPIs roll up to the Employee. | **NOT TRUE.** `WorkflowRun.actingEmployeeId` is dead (§9.1). Analytics counts tool calls and chat messages per employee; workflow runs are never attributed to one. |
| P2 | **Employee-scoped at execution time** — "an HR Employee is structurally unable to call a Marketing connector… enforced in the engine, not just hidden in the UI". | **MOSTLY TRUE, with a documented hole.** `employeeMayUseSkill` is real ([skills.service.ts:546](apps/api/src/modules/skills/skills.service.ts#L546)). But a `TOOL_ACTION` node with no `employeeId` bypasses it entirely, and `employeeId` on that node is optional. |
| P3 | **APPROVAL is a first-class node** with routing, chains, SLA and escalation. | **BUILT, UNREACHABLE.** All of it works in code and tests. None of it can be configured from the product (§7, §9.5). |
| P4 | **Knowledge is role-scoped** so HR documents never leak into a Marketing Employee's context. | **TRUE.** This is the single best chain in the product — end to end, including the workflow `RETRIEVE` node. |
| P5 | **Per-Employee reasoning strategy, model choice and prompt strategy.** | **NOT BUILT.** No reasoning-strategy column exists at all. `AiEmployee.model` exists but is never read (§9.2). |

And the organising principle the founder stated for this audit:

```
Company Configuration → Product Context → Capability Resolution
   → Dashboard / Navigation / Skills / Workflows / Knowledge / Connections → AI Execution
```

**That chain is broken at the second arrow.** There is no capability resolution layer. Details in §3 and §13.4.

---

# 3. AUDIT AREA A — Root Architecture: Configuration → Product Context → Capability Resolution

## 3.1 The primary architectural question, answered

> Is Orlixa **(A)** a configuration-driven platform, or **(B)** a collection of independent modules with duplicated configuration logic?

**Neither, and that is the interesting finding.**

It is not (B). I ran the anti-pattern scan the brief asked for and found **zero** occurrences of `if (industry === …)` and **zero** of `if (department === …)` anywhere in `apps/api/src` or `apps/web/src`. There is no duplicated configuration branching to centralize, because **there is almost no configuration branching at all**. The modules are cleanly separated and mostly do not consult company configuration in the first place.

It is not (A) either, because nothing resolves "what is relevant for this company right now".

The honest classification is a third thing: **a well-factored permission platform that was never given a relevance layer.** Orlixa answers *"is this user ALLOWED to do X?"* well. It has no answer at all for *"is this RELEVANT to this company?"*

That distinction matters for the fix, and it is why my recommendation in §3.6 is **Option B, not Option C**.

## 3.2 LAYER 1 — Company Configuration

| Configuration | Source (where collected) | Storage | Consumers | Runtime Effect | Status |
|---|---|---|---|---|---|
| `Company.name` | Register (auto: `"{Name}'s Workspace"`), onboarding step 1, `PATCH /companies/current` | `Company.name` | tenant, assist prompt, sidebar | Displayed; in assist system prompt | **ACTIVE** |
| `Company.industry` | Onboarding step 1 (free-text dropdown, 10 options, **frontend-only list**) | `Company.industry` | `assist-agent.service.ts:387` only | One line of text in the AI Assist system prompt (`assist-prompt.ts:106`). Nothing else. | **PARTIALLY_ACTIVE** |
| `Company.size` | Onboarding step 1 | `Company.size` | Same one place | Same one line of prompt text | **PARTIALLY_ACTIVE** |
| `Company.website` | Onboarding step 1 | `Company.website` | Read back by `/onboarding/status` only | None | **STORED_ONLY** |
| `Company.businessGoals` | Onboarding step 3 (whole dedicated wizard step) | `String[]` | `onboarding.service.ts` only — written, pruned, read back to rehydrate the wizard | **None.** Zero consumers outside onboarding. | **DEAD** |
| `Company.onboardingRoles` | Onboarding step 2 | `String[]` | Goal reconciliation only | Prunes the goal list (which itself does nothing) | **PARTIALLY_ACTIVE** |
| `Company.country` | **Nowhere in the UI** (RegisterDto only) | `Company.country` | `tenant.service.ts` mapper | None | **DEAD** |
| `Company.timezone` | **Nowhere in the UI** | `Company.timezone` | mapper | None. The workflow scheduler is server-timezone; no timezone handling exists in `modules/workflows`. | **DEAD** |
| `Company.logoUrl` | **Nowhere in the UI** | `Company.logoUrl` | mapper | None — sidebar renders `OrlixaMark` + company name | **DEAD** |
| `Company.description` | `CompleteOnboardingDto` only; no field in the wizard | `Company.description` | mapper | None | **DEAD** |
| `Department` rows | **Not from onboarding** (wizard sends `[]`). Only `/organization` manual create. | `Department` | authorization policy, approval routing, workflow permissions, teams | Real, when they exist | **ACTIVE but unpopulated** |
| `Department.scopes` | **No UI control exists** ([DepartmentSection.tsx](apps/web/src/features/organization/components/DepartmentSection.tsx) has name + description only) | `String[]` | `authorization.policy.ts:135` | This is the master switch for the entire department-isolation layer | **ACTIVE in code, UNREACHABLE in product** |
| `User.role` | `/team` page | `User.role` | RolesGuard, AuthorizationPolicy, everywhere | Real | **ACTIVE** |
| `User.departmentId` / `teamId` | **No UI control.** `features/users/hooks.ts:65-67` hardcodes them to `null`. | columns exist | authz policy, approval routing | Real, when set — and they are never set | **ACTIVE in code, UNREACHABLE** |
| `User.managerUserId` | **Not writable by any API.** Absent from `UpdateUserDto`. | column exists | `EMPLOYEE_MANAGER` approval routing | Falls back to `ANY_ADMIN` ([approval-routing.service.ts:124](apps/api/src/modules/approval-routing/approval-routing.service.ts#L124)) | **DEAD (write path missing)** |
| `SecurityPolicy.sessionTimeoutMinutes` | `/organization` | column | `auth.service.ts:509` | Real, enforced | **ACTIVE** |
| `SecurityPolicy.dataRetentionDays` | `/organization` | column | HR retention sweep, data retention | Real | **ACTIVE** |
| `SecurityPolicy.mfaRequired` | `/organization` | column | `assertPolicyIsEnforceable` **refuses to enable it** | Honestly blocked with an explicit error | **NOT_REQUIRED (honestly handled)** |
| `SecurityPolicy.defaultApprovalSlaMinutes` | Nowhere | column (migration `20260801240000`) | **Zero references in `apps/api/src`, `apps/web/src` or `packages/`** | None | **DEAD** |
| `Subscription.plan` | `/billing` | `Subscription` | seat limit at hire, 2 `@RequirePlan` routes, template `minPlan` | Real | **ACTIVE** |

**Layer 1 score: 8 ACTIVE · 3 PARTIALLY_ACTIVE · 1 STORED_ONLY · 6 DEAD · 3 built-but-unreachable.**

## 3.3 LAYER 2 — Product Context

> Can the system reliably answer *"what is relevant and allowed for this user and company right now?"*

**"Allowed" — yes, and well.** There is a real, centralized, pure-function policy engine.

| Context Input | Source | Resolver | Consumers | Enforcement | Status |
|---|---|---|---|---|---|
| Tenant (`companyId`) | JWT | `CurrentTenant` decorator | every service | Application-level `where: { companyId }` on every query. **No Postgres RLS** (ADR-005, acknowledged in the PRD). | **CONSISTENT** |
| User + role + status | JWT + `authorization.service.actorById` | `AuthorizationPolicy.decide()` — a pure function, exhaustively unit-tested | 4 services + 10 controllers | Backend | **CENTRALIZED (partially adopted)** |
| Department placement | `User.departmentId` → `Department.scopes` | Same | Same | Backend | **CENTRALIZED but always empty** |
| Subscription / plan | `BillingService.getSubscription` | none — read ad hoc | `EmployeesService.create`, `PlanGuard` (2 routes), `workflow-templates` | Backend, thin | **DISTRIBUTED, INCONSISTENT** |
| Company configuration (industry/size/goals) | `Company` row | **no resolver** | assist prompt only | none | **MISSING** |
| Hired AI Employees | `AiEmployee` rows | **no resolver** | listed, never used to decide relevance | none | **MISSING** |

**The verdict on Layer 2:** the *authorization* half is genuinely good architecture — better than the brief assumed. The *context* half does not exist. There is no code anywhere that answers "given this company, what should it see?"

### 3.3.1 Adoption gap in the authorization layer

The centralized layer exists but only **10 of 51 controllers** use `AuthorizationGuard`/`@RequirePermission`. Only **4 services** call `AuthorizationService` (`employees`, `knowledge`, `workflows`, `hr/staff`).

The most consequential omission:

**`AnalyticsController` has `@UseGuards(JwtAuthGuard)` and nothing else.** Any `MEMBER` can call `GET /analytics/employees` and receive KPI rows for **every AI Employee in the company**, including ones the *same user* is denied from reading through `GET /employees` (which does apply `authz.filter(actor, 'employee:read', …)`). Two endpoints, same data, different answers. That is a real, exploitable inconsistency, not a theoretical one.

## 3.4 LAYER 3 — Capability Resolution

This is the layer the founder's brief is really about, and it is the emptiest.

| Capability | Resolver | Inputs | Enforcement | Consumers | Status |
|---|---|---|---|---|---|
| Which **skills** are relevant | **none** | — | — | `/skills` shows all 15, always | **MISSING** |
| Which **AI Employees** can be hired | `ONBOARDING_CATALOG` (7 roles, each tagged with departments) | departments | — | **Nothing.** `useOnboardingCatalog()` exists in `hooks.ts` and is imported by **zero components**. The wizard hardcodes `const ROLES = ['HR','MARKETING']`. | **DEAD RESOLVER** |
| Which **workflow templates** are relevant | `requires.{skills,employeeRoles,minPlan}` | tenant resources | Checked at **install** (→422) | Browse list is unfiltered — an HR-only company sees all 11 Marketing templates and gets a 422 on click | **PARTIAL** |
| Which **navigation** items to show | one boolean `canManageOrg` | user role | frontend only | 4 static arrays in `Sidebar.tsx` | **HARDCODED** |
| Which **dashboard widgets** to show | **none** | — | — | 6 fixed tiles for everyone | **MISSING** |
| Which **connections** to suggest | `suggestedSkills` string in `marketplace.catalog.ts` | none — static per template | none | Rendered as a comma-separated text hint | **COSMETIC** |
| Capability → skill/tool | **`SKILL_CAPABILITIES` map** ([capabilities.ts](apps/api/src/modules/skills/capabilities.ts)) | capability name | Guarded by `capabilities.spec.ts` | AI Assist skill card, workflow skill requirements | **REAL AND GOOD** |

The last row deserves credit: `CAPABILITY_TOOLS` is exactly the right shape of abstraction (`EMAIL_SEND → [gmail.send_email, email.send_email]`). It resolves *capability → provider*. What is missing is the layer above it: *company context → which capabilities matter*.

## 3.5 Dependency chain verification

```
Department Added
  → Company Configuration Updated          CONNECTED  (Department row created)
  → Relevant AI Employees Available        BROKEN     (no link — AiEmployee.department is free text, no FK)
  → Relevant Skills Available              MISSING    (flat catalog)
  → Relevant Connections Suggested         MISSING
  → Relevant Workflows Available           BROKEN     (Workflow.category only set by template install)
  → Dashboard Updates                      MISSING
  → Runtime Uses Correct Context           PARTIAL    (only if Department.scopes set — no UI to set it)
```

```
AI Employee Hired
  → EmployeeSkill grants                   CONNECTED  (manual assignment; enforced at runtime)
  → Knowledge scoped to role               CONNECTED  ← the one fully working chain
  → Workflow templates unlocked            PARTIAL    (enforced at install, not surfaced)
  → Dashboard row appears                  CONNECTED
  → Workflow runs attributed to employee   BROKEN     (actingEmployeeId dead)
  → Navigation changes                     MISSING
```

## 3.6 ARCHITECTURAL GAP DECISION

### → **OPTION B — EXISTING ARCHITECTURE IS PARTIALLY SUFFICIENT.**

Not Option C. The evidence is against a new "Product Context Engine":

1. `AuthorizationPolicy.decide()` is already the right pure-function shape and already takes `{actor, action, resource, department}`. Adding relevance to it is an extension, not a rewrite.
2. `CAPABILITY_TOOLS` is already the capability registry. It needs one more table, not a new framework.
3. There is **no duplicated configuration logic to consolidate** (zero `if industry ===`). A consolidation framework has nothing to consolidate.
4. Most of the gap is not architecture at all — it is missing UI on top of finished backends. Building a new abstraction would not add a single `Department.scopes` input field.

**The minimum change that closes it:**

| Add | Where | Why not a new service |
|---|---|---|
| `RELEVANCE` map: `EmployeeRole → { skillKeys[], capabilities[], workflowCategories[] }` | next to `capabilities.ts` | Same file, same shape, same spec-test pattern as `CAPABILITY_TOOLS` |
| `GET /context/effective` returning `{plan, features[], departments[], hiredRoles[], relevantSkillKeys[], navItems[]}` | thin controller over existing services | This is also the `GET /authz/effective` the PRD promised security reviewers and never built |
| One `useProductContext()` hook the sidebar + dashboard + catalogs read | `apps/web/src/features/tenant` | Replaces 4 static arrays and 3 copies of `plan === 'BUSINESS' \|\| plan === 'ENTERPRISE'` |
| `Department.scopes` and `User.departmentId` **form controls** | 2 existing components | Turns the finished authorization layer on |

## 3.7 Anti-pattern classification

| Pattern found | Count | Classification | Note |
|---|---|---|---|
| `if (industry === …)` | **0** | — | The problem is the opposite: industry branches nowhere |
| `if (department === …)` | **0** | — | Same |
| `role === 'OWNER' \|\| role === 'ADMIN'` inline | 5 sites (`skills.controller:70`, `workflows.controller:293,325`, `assist.service:303`, `useAppShellProps:22`) | **CENTRALIZE** | Should be `authz.can(actor, 'skill:connect')` — the capability already exists |
| `plan === 'BUSINESS' \|\| plan === 'ENTERPRISE'` in frontend | 3 sites (`workflows/page.tsx:37`, `OnboardingWizard.tsx:97`, `CreateWorkflowChooser.tsx:34`) | **CENTRALIZE** | Duplicated entitlement rule; and the sidebar forgot to apply it (§9.4) |
| Hardcoded AI Employee list in wizard | `OnboardingWizard.tsx:29` | **REFACTOR** | Backend catalog already exists and is unused |
| Static navigation arrays | `Sidebar.tsx:36-69` | **REFACTOR** | Should be context-derived |
| Two parallel workflow-template systems | `marketplace.catalog.ts` (15 code templates) **and** `WorkflowTemplate` model (22 DB templates) | **REMOVE one** | Both live, both in the nav (`/marketplace` and `/workflows/templates`) |
| Two workflow engines | `state_machine` (default) + `legacy_walk` | **REMOVE `legacy_walk`** | CI already treats it as deprecated; it doubles every test run |
| `PLAN_RANK` duplicated | already fixed 2026-08-20 | **VALID** | Good catch by the team |
| Prompt-level role guardrail (`ROLE_SCOPE`) | `employees.constants.ts:70` | **VALID** | Explicitly documented as prompt-level, not a security control |

### FINAL ROOT ARCHITECTURE SCORE

| Layer | Weight | Completion | Evidence |
|---|---:|---:|---|
| Configuration persistence | 15 | 90% | Every field has a column + migration; onboarding is resumable server-side |
| Configuration consumption | 20 | 45% | industry/size = prompt text only; goals/country/tz/logo/description/model/hours/language/permissions read by nobody |
| Capability resolution | 20 | 15% | No resolver. Flat catalogs, static nav, unfiltered templates, no recommendations |
| Backend enforcement | 15 | 70% | Real policy engine, 4 services + 10 controllers, seat limits, employee skill grants |
| Frontend relevance | 10 | 10% | Static nav, generic dashboard, hardcoded 2-role wizard |
| Change propagation | 10 | 25% | Workflow version pinning only; goal pruning; no employee config version; no re-derivation |
| Runtime execution context | 10 | 55% | tenant + employee + role + knowledge scope threaded; model/hours/language/permissions not |

```
(15×0.90) + (20×0.45) + (20×0.15) + (15×0.70) + (10×0.10) + (10×0.25) + (10×0.55)
= 13.5 + 9.0 + 3.0 + 10.5 + 1.0 + 2.5 + 5.5
= 45.0
```

> ## Configuration-Driven Architecture: **45%**

**What stops it reaching 100%, in one sentence each:**
1. Nothing turns company context into a filtered list of anything.
2. Six company-level configuration fields are stored and read by no code.
3. The onboarding wizard sends `departments: []`, so the axis the whole authorization layer scopes on is empty in every tenant.
4. Three finished configuration surfaces (`Department.scopes`, `User.departmentId`, `AiEmployee.model`) have no input control anywhere.
5. The frontend has zero relevance logic — four static arrays and six fixed tiles.

---

# 4. Role Dependency Audit

| Role / Permission | UI | API | Backend | Data Scope | Runtime | Status |
|---|---|---|---|---|---|---|
| `OWNER` | ✅ | ✅ | ✅ | Full tenant; explicitly never department-scoped (`policy.ts:112`) | ✅ | **COMPLETE** |
| `ADMIN` | ✅ | ✅ | ✅ | Full tenant unless their department has `scopes` | ✅ | **COMPLETE** |
| `MEMBER` | ✅ | ✅ | ✅ | Restricted for employees/knowledge/workflows/hr; **not** for analytics, approvals list, skills catalog, marketplace, events | Partial | **PARTIAL** |
| `UserStatus.DISABLED` kill switch | ✅ | ✅ | ✅ `policy.ts:91` re-checked per request | n/a | ✅ | **COMPLETE** |
| Department scoping (`Department.scopes`) | ❌ **no input field** | ✅ | ✅ | ✅ 4 services filter by it | ✅ | **BACKEND ONLY — unreachable** |
| `User.departmentId` | ❌ **no input field** (`hooks.ts:65` hardcodes null) | ⚠️ `UpdateUserDto` supports it | ✅ | ✅ | ✅ | **BACKEND ONLY — unreachable** |
| `User.teamId` | ❌ | ⚠️ DTO only | ✅ | ✅ | ✅ | **BACKEND ONLY — unreachable** |
| `User.managerUserId` | ❌ | ❌ **not in any DTO** | ✅ read | ✅ | Falls back to `ANY_ADMIN` | **BROKEN (no write path)** |
| `AiEmployee.managerUserId` | ❌ (UI edits free-text `managerName`) | ❌ not in `UpdateEmployeeDto` | ✅ read | — | Falls back | **BROKEN (no write path)** |
| `WorkflowPermission` grants | ❌ **no UI at all** (`/workflows/:id/permissions` never called from web) | ✅ | ✅ enforced at enqueue | ✅ | ✅ | **BACKEND ONLY — unreachable** |
| Approval routing rules | ❌ **no UI at all** | ⚠️ raw JSON in `AiEmployee.approvalRules` | ✅ | ✅ | ✅ | **BACKEND ONLY — unreachable** |
| Analytics access | ✅ visible to all | ❌ **no role check** | ❌ | ❌ **none** | — | **BROKEN — MEMBER sees all employees' KPIs** |
| Plan entitlement (`@RequirePlan`) | ⚠️ 3 duplicated literals; **sidebar not gated** | ✅ 2 routes | ✅ | — | ✅ | **PARTIAL** |
| HR domain (OWNER/ADMIN, reads included) | ❌ **no UI** | ✅ | ✅ + `authz.filter` on staff | ✅ | ✅ | **BACKEND ONLY** |

### Roles that are stored and have no downstream effect
- `User.managerUserId`, `AiEmployee.managerUserId` — unwritable.
- `Department.scopes` — the switch nobody can flip.
- `AiEmployee.permissions` (4 flags) — written by the UI, read by nothing.

### Can API calls bypass frontend restrictions?
Mostly no — the important gates are server-side. The exceptions: **analytics** (no role check at all) and **conversations / learning / marketplace / events / scheduling / handoff controllers** (JWT only, no capability check).

---

# 5. AI Employee Dashboard Audit

`GET /analytics/{overview,employees,activity}` → `/dashboard`.

| Widget | Data Source | AI-Employee Dependency | Real / Mock | Status |
|---|---|---|---|---|
| Tasks Completed | `SkillExecution(SUCCESS)` + `Message(ASSISTANT)` + `WorkflowRun(COMPLETED)` | none — company total | **Real** | **COMPLETE but generic** |
| Hours Saved | `tasksCompleted × 10min` (`MINUTES_SAVED_PER_TASK`) | none | **Derived from a hardcoded constant.** Labelled "est." in the UI. | **ILLUSTRATIVE** |
| Cost Savings | `hoursSaved × $25` (`HOURLY_RATE_USD`) | none | Same | **ILLUSTRATIVE** |
| Success Rate | `(toolSuccess + workflowCompleted) / (toolActions + workflowRuns)` | none | **Real** | **COMPLETE but generic** |
| Pending Approvals | `ApprovalRequest(PENDING)` count | none | **Real** | **COMPLETE** |
| Active Employees | `AiEmployee(ACTIVE)` count | n/a | **Real** | **COMPLETE** |
| Per-employee KPI table | `groupBy(employeeId)` over SkillExecution / Conversation / Message / ApprovalRequest | ✅ per employee | **Real** | **PARTIAL — excludes workflow runs entirely** |
| KPI attainment | `AiEmployee.kpiTargets` vs actuals | ✅ | **Real** | **COMPLETE** |
| Activity feed | `groupBy(employeeId, skillKey, tool)` | ✅ | **Real** | **COMPLETE** |

### Widgets that should exist per the concept and do not

The brief asked specifically about role-relevant dashboards. **None exist.** A company that hired only a Marketing Employee sees exactly the same six tiles as one that hired only HR.

The data to build them is already in the database and is queried by nothing:

| Missing widget | Table that already holds the data | Rows written by |
|---|---|---|
| Marketing: Posts Published / Scheduled | `PublishedPost`, `ScheduledPost`, `Campaign` | postiz executor + marketing-sync cron |
| Marketing: Campaign performance | `MarketingAnalyticsSnapshot` | marketing-analytics cron |
| Support: Conversations / Resolutions | `SupportConversation`, `SupportMessage` | chatwoot webhook |
| Support: Escalations | `HandoffRequest` | handoff module |
| HR: Candidates / Interviews | `InterviewSlot`, `StaffMember`, `OnboardingTask` | scheduling + HR modules |
| HR: Pending reviews / leave | `PerformanceReview`, `LeaveRequest` | HR module |
| PM: Issues tracked | `TrackedIssue`, `PlaneProject` | plane webhook |

**That is roughly 15 populated tables with zero dashboard representation.**

### Other dashboard findings
- **Not tenant-leaky** — every query is `where: { companyId }`. Verified.
- **Not role-scoped** — see §4.
- **Empty states:** `activity()` returns `[]` and the feed hides employees with no activity — good. But the tile row shows a brand-new company "0 Tasks · 0.0h Saved · $0 Cost Savings · Pending 0", which is an honest but demoralising first-run experience with no "here's what to do next" affordance.
- **No irrelevant-widget hiding**, because no widget is relevance-aware.

---

# 6. Onboarding Dependency Matrix

The real wizard is `apps/web/src/features/onboarding/components/OnboardingWizard.tsx` — 3 steps.

| Selection | Collected? | Stored | Backend Used | Runtime Used | Dashboard Used | Editable later | Status |
|---|---|---|---|---|---|---|---|
| Company name | ✅ step 1 | `Company.name` | ✅ | ✅ prompt + display | ✅ sidebar | ✅ `/organization` | **CONNECTED** |
| Industry | ✅ step 1 (10 hardcoded frontend options, no backend enum) | `Company.industry` | ⚠️ assist prompt only | ⚠️ one line of prompt text | ❌ | ✅ | **STORED, BARELY USED** |
| Company size | ✅ step 1 | `Company.size` | ⚠️ assist prompt only | ⚠️ | ❌ | ✅ | **STORED, BARELY USED** |
| Website | ✅ step 1 | `Company.website` | ❌ | ❌ | ❌ | ✅ | **STORED ONLY** |
| AI Employee roles | ✅ step 2 — **only HR and MARKETING**, hardcoded | `Company.onboardingRoles` + real `AiEmployee` rows | ✅ hires via `EmployeesService.create` | ✅ | ✅ | Hire more yes; **change a role, no** | **CONNECTED (narrow)** |
| Business goals | ✅ step 3 (a whole dedicated step) | `Company.businessGoals` | ❌ | ❌ | ❌ | ✅ (re-run wizard) | **DEAD** |
| **Departments** | ❌ **never asked. `departments: []` is sent literally** | would be `Department` | ✅ (if they existed) | ✅ | ❌ | ✅ `/organization` | **BROKEN CHAIN — HIGH** |
| Company description | ❌ (DTO field, no form field) | `Company.description` | ❌ | ❌ | ❌ | API only | **DEAD** |
| Country / timezone / logo / phone | ❌ (RegisterDto only, register form doesn't send them) | columns | ❌ | ❌ | ❌ | API only | **DEAD** |
| Skills / connections | ❌ not part of onboarding | — | — | — | — | `/skills` | **NOT IN ONBOARDING** |
| Knowledge sources | ❌ not part of onboarding | — | — | — | — | `/knowledge` | **NOT IN ONBOARDING** |
| Preferred AI model | ❌ | `AiEmployee.model` | ❌ | ❌ | ❌ | API only | **DEAD** |
| Plan | ⚠️ implicit — everyone defaults to `STARTER` | `Subscription` | ✅ | ✅ seats | ✅ | ✅ `/billing` | **CONNECTED** |
| Free credit grant | automatic | `CreditLedger` + `CreditLot` | ✅ | ✅ | ✅ badge | n/a | **CONNECTED** |

### The two structural onboarding defects

**(1) Departments are never collected.** `OnboardingWizard.tsx:103` sends `departments: []`. The backend has a complete, idempotent, `skipDuplicates` department-creation branch at `onboarding.service.ts:220-226` that runs on an empty array every single time. Downstream: department-scoped authorization, `DEPARTMENT` approval routing, `DEPARTMENT` workflow permissions and department-based data scoping are all inert for every tenant that has ever onboarded.

**(2) The backend hire catalog is orphaned.** `ONBOARDING_CATALOG` defines 7 roles, each tagged with the departments it belongs to, and its own docstring says *"the wizard filters it by the departments the company selected"*. It does not. `useOnboardingCatalog()` is defined in `hooks.ts:73` and imported by **no component**. The wizard hardcodes `const ROLES = ['HR','MARKETING'] as const`.

So the one place in the codebase that was designed to do configuration-driven filtering is dead code, replaced by a hardcoded pair.

---

# 7. AI Employee Settings GAP

Panel: `apps/web/src/features/employees/components/EmployeeSettings.tsx`.

| Item | CURRENT | MISSING | IMPACT | RECOMMENDATION |
|---|---|---|---|---|
| **Name** | Editable, works | — | — | Keep |
| **Role / category** | Set at hire, **immutable** (`role` absent from `UpdateEmployeeDto`) | Any way to change it | To re-categorise an employee you must delete and recreate — which **cascades away every conversation, memory, feedback and skill grant** (§8). | Add role change behind a warning + a `configVersion` bump; never a silent swap |
| **Subcategory** | Does not exist as a concept | Whole concept | Marketing site advertises categories (Procurement/Operations/Legal) the model cannot express | Either add `subcategory` or stop advertising them |
| **Description / persona** | `persona` editable via API; **shown on create form only** | Edit control in Settings | Minor | Add field |
| **Objective / goals** | ✅ editable, feeds analytics attainment | Feeds nothing at execution time | Goals do not steer the agent | Thread into the system prompt |
| **Department** | ✅ editable **free text** | FK to `Department` | Typing "Marketing" does not connect the employee to the Marketing department. Documented deferred item. | Convert to a `departmentId` select |
| **Assigned skills** | ✅ separate tab, real, enforced at runtime | Relevance filtering by role | An HR employee can be granted Stripe | Warn on mismatch; do not block |
| **Allowed tools** | Derived from skill grants | Per-tool granularity | Coarse | Defer |
| **Connected applications** | ✅ per-employee connections work | — | — | Keep |
| **AI model** | Column + `UpdateEmployeeDto` field | **No UI control, and never read at runtime.** `LlmCompletionInput` has no model field; both providers read `LLM_MODEL` env only. Usage rows even record `model: process.env.LLM_MODEL`. | **Per-employee model choice is fiction.** So is per-employee model cost attribution. PRD lists it as a differentiator. | Thread `employee.model` into `LlmCompletionInput`, or delete the column and the claim |
| **Model provider** | Global env only | Per-employee | Same | Same |
| **Reasoning level** (`DIRECT`/`PLAN_ACT`/`REACT`/`REFLECT`) | **Does not exist anywhere** — no column, no code | Everything | PRD §3 names it as a competitive differentiator vs Copilot Studio | Remove from the PRD or build it |
| **Execution preferences (working hours, timezone, language)** | ✅ editable, ✅ displayed | **Never read by any runtime path.** No reference in `modules/employees/runtime` or the engine. | Three settings that visibly do nothing. "Language: French" changes no output. | Thread into the prompt, or remove the fields |
| **Cost / credit behaviour** | `budgetLimit` ✅ enforced (chat + AI_STEP). `maxCreditsPerExecution` / `maxCreditsPerTask` ✅ enforced since 2026-08-20 | No UI for the two credit ceilings | API-only controls | Add to the panel |
| **Workflow assignments** | Not modelled | Any link | You cannot see "which workflows does Emma run" | Derive from node `employeeId` |
| **Trigger configuration** | Per workflow, not per employee | — | Fine | Keep |
| **Knowledge sources** | ✅ per-employee Knowledge tab, role-filtered, real | — | — | Keep — best-in-class here |
| **Memory** | ✅ teach/forget + learning summary | Semantic recall (recency only) | FACTs get crowded out past `RECENT_MEMORY_LIMIT=5` | Known deferred |
| **Approval requirements** | 3 checkboxes: `approveOverBudget`, `approveExternalMessages`, `approveRefunds` | **The policy reads none of them.** `toolRequiresApproval()` reads only `requireApprovalForAllTools` and `requireApprovalForTools`. | **3 safety controls that do nothing.** A user who ticks "Require approval for external messages" gets no approval gate. | **P0.** Either map the 3 keys onto the real policy or delete the checkboxes |
| **Allowed actions / permissions** | 4 checkboxes: `sendEmail`, `contactCustomers`, `makePayments`, `accessKnowledge` | **`AiEmployee.permissions` is read by the mapper and nothing else.** Zero runtime consumers. | **4 more controls that do nothing** — including "Make payments" | **P0.** Same choice |
| **Status** (Active/Paused/Disabled) | ✅ real, chat returns 409 when paused | Effect on scheduled workflows (§8) | A disabled employee's scheduled workflows keep running | Fix in lifecycle work |
| **Config versioning / pinning** | **Does not exist.** No `configVersion` column. | Everything | Changing budget/model/approval rules mid-run affects in-flight executions non-deterministically. Workflows have `WorkflowVersion` pinning; employees have none. | Add `AiEmployee.configVersion` + snapshot on run start |

**Seven visible controls in the flagship settings panel have zero runtime effect.** For a product whose §4 persona goal is *"Configure budget limits and approval rules once, trust every Employee honors them"*, this is the most damaging single finding in the report.

---

# 8. Configuration Impact Matrix

Legend: ✅ handled · ⚠️ partial/unsafe · ❌ nothing happens · — n/a

| Configuration Changed | AI Employees | Skills | Workflows | Dashboard | Knowledge | Connections | Permissions | Credits | Audit | Runtime |
|---|---|---|---|---|---|---|---|---|---|---|
| Change **Industry** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ next assist prompt only |
| Change **Company size** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ same |
| Change **Business goals** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Add Department** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ becomes a valid routing/permission subject | ❌ | ✅ | ❌ until users are assigned (no UI) |
| **Remove Department** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ **`User.departmentId` SetNull → those users silently become UNSCOPED (see everything)**; `Team.departmentId` SetNull; approval rules naming the dept id dangle | ❌ | ✅ | ⚠️ silent privilege widening |
| **Change User role** | — | ✅ | ✅ | ❌ analytics ignores role | ✅ | ✅ | ✅ immediate (per-request) | — | ✅ `user.role_changed` | ✅ |
| **Assign user to Department** | — | ✅ | ✅ | ❌ | ✅ | — | ✅ | — | ✅ | ✅ — **but no UI exists to do it** |
| **Add AI Employee** | ✅ | — | — | ✅ appears | ✅ role scope | — | — | ✅ seat check | ⚠️ no `employee.create` audit action | ✅ |
| **Disable AI Employee** | ✅ status | ⚠️ grants remain | ❌ **scheduled/EVENT workflows naming it keep firing** | ✅ drops from Active count | — | ⚠️ its connections remain usable by workflows | — | ⚠️ open reservations not released | ⚠️ | ⚠️ chat 409s; workflows do not |
| **Delete AI Employee** | ✅ | ❌ cascade deletes `EmployeeSkill` | ❌ **workflow nodes naming it break at runtime, no validation** | ❌ history vanishes | ❌ memories cascade | ❌ **`InstalledSkill` cascade — deletes encrypted credentials** | — | ⚠️ counters dangle | ⚠️ | ❌ |
| **Change AI Employee category/role** | **impossible** | — | — | — | — | — | — | — | — | — |
| **Change AI model** | ⚠️ stored | — | — | — | — | — | — | ❌ cost still attributed to `LLM_MODEL` | ❌ | ❌ **never read** |
| **Remove a Skill from an employee** | ✅ | ✅ | ⚠️ workflow `TOOL_ACTION` without `employeeId` still runs it | ✅ | — | ✅ | ✅ enforced | ✅ | ✅ | ✅ next call |
| **Disconnect an application** | ⚠️ | ✅ status | ⚠️ `auto` executor **silently falls back to mock** | ❌ no signal | — | ✅ | — | — | ✅ `connector.disconnected` | ⚠️ **runs report success while doing nothing** |
| **Change Subscription plan** | ✅ seat cap at next hire (never retroactive) | ❌ | ⚠️ 2 routes only | ❌ | ❌ | ❌ | ❌ | ✅ | ⚠️ | ✅ |
| **Change SecurityPolicy retention** | — | — | — | — | ✅ | — | — | — | ✅ | ✅ next sweep |

### The lifecycle rules that are missing, stated plainly

1. **Deleting an AI Employee is a destructive, unguarded cascade.** `EmployeesService.remove()` is `findOwnedEmployee` then `prisma.aiEmployee.delete()`. Nothing checks for running workflow runs, pending approvals, workflows referencing the employee, or open credit reservations. `InstalledSkill.employeeId` cascades — so the employee's **encrypted OAuth credentials are deleted with them**, with no warning. This is the same class of defect as G29 (workflow delete destroying audit history) which the PRD called ship-blocking.
2. **Disabling an AI Employee does not stop its automated work.** Chat returns 409; scheduled and event-triggered workflows that name it keep executing.
3. **Deleting a Department widens privileges.** Every user in it becomes unscoped.
4. **No AI Employee configuration versioning.** Workflows pin a `WorkflowVersion`; employees pin nothing. A budget or approval-rule change during a run takes effect mid-flight.
5. **Orphan references are not prevented.** `ApprovalRequest.employeeId`, `SkillExecution.employeeId`, `EmployeeCreditPeriodCounter.employeeId` and workflow node `config.employeeId` are all loose strings with no FK.

---

# 9. Broken Dependency Chains

Ordered by severity.

### 9.1 Workflow runs are not attributed to an AI Employee — HIGH
```
PRD: "every run is attributed to an Employee (not just a workflow)"
  → WorkflowRun.actingEmployeeId column exists (migration 20260801150000)
  → written by NOTHING
  → read by NOTHING
  → analytics per-employee KPIs exclude workflow runs entirely
  → the product's stated #1 differentiator is not implemented
```
Verified: `grep -rn "actingEmployeeId" apps packages` returns exactly one hit — the schema line.

### 9.2 Per-employee AI model is stored and ignored — HIGH
```
AiEmployee.model  →  UpdateEmployeeDto.model  →  persisted
  → LlmCompletionInput has no model field
  → OpenAiLlmProvider / AnthropicLlmProvider read config.get('LLM_MODEL')
  → agent-runtime records usage as model: process.env.LLM_MODEL
  → per-employee model choice AND per-employee model cost attribution are both false
```

### 9.3 Seven AI Employee safety controls do nothing — HIGH
```
Settings UI writes permissions{sendEmail,contactCustomers,makePayments,accessKnowledge}
  → AiEmployee.permissions JSON
  → read only by employees.mapper.ts (to echo it back)
  → NO runtime consumer

Settings UI writes approvalRules{approveOverBudget,approveExternalMessages,approveRefunds}
  → AiEmployee.approvalRules JSON
  → toolRequiresApproval() reads ONLY requireApprovalForAllTools / requireApprovalForTools
  → the three keys the UI writes are never read
```

### 9.4 Entitlement does not reach navigation — MEDIUM (but hits every free signup)
```
Subscription.plan = STARTER
  → AssistController is @RequirePlan('BUSINESS','ENTERPRISE')
  → Sidebar NAV_PRIMARY includes { href:'/assist', label:'AI Assist' } with no gate
  → every STARTER user sees "AI Assist" and gets a 403 on click
```
The onboarding wizard was already patched to route around this (`canUseAssist`), which proves the team knows the rule — the sidebar was simply never given it. Same rule is copy-pasted literally in 3 frontend files.

### 9.5 The entire configuration→relevance chain — HIGH
```
Onboarding: industry=Healthcare, size=51-200, goals=[...], roles=[HR]
  → stored correctly
  → /skills shows all 15 skills including Stripe, GitHub, Postiz, Chatwoot
  → /workflows/templates shows all 22 including 11 Marketing ones (422 on install)
  → /marketplace shows all 10 employee templates + 15 more workflow templates
  → sidebar shows Interview scheduling, Marketplace, AI Assist regardless
  → dashboard shows 6 identical tiles
  → nothing anywhere is Healthcare-specific, HR-specific, or 51-200-specific
```

### 9.6 Departments never created → four features inert — HIGH
```
OnboardingWizard sends departments: []
  → zero Department rows for a newly onboarded tenant
  → Department.scopes has no UI anyway
  → User.departmentId has no UI
  → therefore: department-scoped authorization = inert
             DEPARTMENT approval routing = unresolvable
             DEPARTMENT workflow permissions = unusable
             department data isolation = inert
```

### 9.7 Approval routing is unconfigurable — HIGH
```
P3-05 shipped: routing rules, multi-level chains, SLA sweep, escalation tiers,
               canDecide, USER/ROLE/DEPARTMENT/TEAM/EMPLOYEE_MANAGER/ANY_ADMIN
  → configured via AiEmployee.approvalRules.routing (raw JSON)
  → NO UI anywhere writes it (grep: zero frontend hits for "routing"/"approverRule"/"escalationChain"/"onTimeout")
  → 3 of the 6 rule types (DEPARTMENT, TEAM, EMPLOYEE_MANAGER) cannot resolve
    because departmentId/teamId/managerUserId have no write path
  → SecurityPolicy.defaultApprovalSlaMinutes: 0 references in the entire codebase
```

### 9.8 Four connectors are permanently fake — HIGH
```
OAuth registry supports google, slack, atlassian(jira), hubspot
  → a customer connects real HubSpot / real Jira → status CONNECTED
  → RealSkillExecutor has no case for hubspot / jira / github / stripe
  → default: → this.fallback.execute(...)  ← the MOCK executor
  → every CRM write, every Jira issue, every GitHub action, every Stripe payment link
    returns a fabricated success
```
`stripe.create_payment_link` is flagged `highRisk`, so a human is asked to approve a payment link — and then a mock runs. Honestly marked as a TODO at `real-skill-executor.ts:121`, but it is shipped behaviour.

### 9.9 Production can boot with the mock executor — HIGH
```
requireRealProviderInProduction() guards LLM_PROVIDER, BILLING_PROVIDER, MAIL
  → NOT applied to SKILL_EXECUTOR (skills.module.ts:62 default 'mock')
  → NODE_ENV=production with SKILL_EXECUTOR unset boots cleanly
  → every skill call silently returns fake success
```

### 9.10 Six scheduled jobs never run on the deployed shape — HIGH
`CronController` handles 17 jobs. `apps/api/vercel.json` schedules 11. Unscheduled:
`imap-poll`, `credit-reservation-sweep`, `subscription-credit-renewal`, `enterprise-credit-agreement-renewal`, `credit-reconciliation`, `credit-finance-rollup`.

Consequences on Vercel: IMAP inbound email never polls; stale credit reservations are never released (balances leak); **monthly included credits are never granted to paying PRO/BUSINESS customers**; enterprise agreements never renew; no reconciliation or finance rollup.

### 9.11 Serverless deployment silently loses durable execution — MEDIUM/HIGH
`WORKFLOW_EXECUTION_MODE=inline` (required on Vercel — there is no worker) forces the engine back to `legacy_walk`. The team documented this trap and made it log loudly at boot, which is good — but it means the **production deployment does not have** attempts, leases, reaper recovery or exactly-once side effects, all of which are on by default everywhere else.

### 9.12 Workflow scope axis is unsettable — MEDIUM
`Workflow.category` is the department-scope axis for workflows. It can only be set by a template install (`workflows.service.ts:210` comment says so explicitly). Hand-authored and AI-Assist-generated workflows get `null` → unscoped → visible to every department.

### 9.13 Analytics bypasses the authorization layer — MEDIUM
Covered in §3.3.1.

---

# 10. Dead / Disconnected Implementation

| Item | Evidence | Classify |
|---|---|---|
| `WorkflowRun.actingEmployeeId` | 1 hit repo-wide (the schema line) | **CONNECT** (this is the concept) |
| `SecurityPolicy.defaultApprovalSlaMinutes` | 0 hits in src | **CONNECT** or **REMOVE** |
| `Company.businessGoals` | consumers: onboarding only | **CONNECT** (feed relevance) |
| `Company.country / timezone / logoUrl / description` | mapper only | **REMOVE** (or collect + use timezone for the scheduler) |
| `AiEmployee.model` | never reaches the LLM | **CONNECT** |
| `AiEmployee.permissions` | mapper only | **CONNECT or REMOVE the 4 checkboxes** |
| `approvalRules.approveOverBudget / approveExternalMessages / approveRefunds` | policy reads different keys | **CONNECT or REMOVE the 3 checkboxes** |
| `AiEmployee.workingHoursStart/End`, `language`, `timezone` | never read at runtime | **CONNECT** (cheap: prompt injection) |
| `ONBOARDING_CATALOG` + `useOnboardingCatalog()` | hook imported by zero components | **CONNECT** |
| `GET /onboarding/catalog` | no frontend consumer | **CONNECT** |
| **Whole HR API** (`/hr/staff`, `/hr/leave`, `/hr/reviews`, `/hr/documents`, `/hr/onboarding-tasks`, `/hr/attendance`) — 6 models, PII encryption, retention | **zero frontend calls** | **CONNECT** (it is the MVP's #1 persona) |
| `/workflows/:id/permissions` | zero frontend calls | **CONNECT** |
| `/retention` | zero frontend calls | **DEFER** (admin API is acceptable) |
| `/handoff` | zero frontend calls | **CONNECT** (support escalation is user-facing) |
| Marketing domain tables (`Campaign`, `ScheduledPost`, `PublishedPost`, `SocialAccount`, `BrandAsset`, `MediaAsset`, `MarketingAnalyticsSnapshot`) | no UI | **CONNECT** |
| Support domain (`SupportConversation`, `SupportMessage`, `ChatwootAccount`) | no UI | **CONNECT** |
| PM domain (`PlaneWorkspace`, `PlaneProject`, `TrackedIssue`) | no UI | **DEFER** |
| `marketplace.catalog.ts` `WORKFLOW_TEMPLATES` (15) alongside the DB `WorkflowTemplate` (22) | two live systems, two nav entries | **REMOVE** the marketplace shim |
| `legacy_walk` engine | deprecated in CI, doubles test time | **REMOVE** after one more release |
| `RunEventOutbox` / realtime WS gateway | seq-outbox exists, gateway off | **DEFER** (documented P5-01) |
| `ProcurementAI` / `OperationsAI` / `LegalAI` on the marketing site | `role: 'CUSTOM'`; no enum values; not offered in onboarding | **REMOVE from the site** until built |
| `mfaRequired` | explicitly refused by the service | **KEEP** (honest) |

---

# 11. Production Gaps (prioritised)

### P0 — blocks production

| # | Gap | Why it is P0 |
|---|---|---|
| P0-1 | **7 dead safety controls in AI Employee Settings** (4 permissions + 3 approval rules) | A customer ticks "Make payments: off" / "Require approval for external messages" and neither is honoured. This is a trust and arguably a liability problem, not a polish problem. |
| P0-2 | **`SKILL_EXECUTOR` has no production guard** | A prod deploy with the var unset silently mocks every integration while reporting success. |
| P0-3 | **hubspot / jira / github / stripe have no real executor** but hubspot+jira have real OAuth | Customer connects a real account, sees CONNECTED, every write is fake. |
| P0-4 | **6 cron jobs unscheduled on Vercel**, including `subscription-credit-renewal` and `credit-reservation-sweep` | Paying customers never receive their monthly credits; reservations leak. |
| P0-5 | **AI Employee delete is an unguarded destructive cascade** incl. encrypted credentials | Same defect class the PRD called ship-blocking for workflows (G29). |
| P0-6 | **Analytics has no authorization** | Any MEMBER reads every employee's KPIs, contradicting `GET /employees`. |
| P0-7 | **222 uncommitted files** (119 untracked, 103 modified) — the entire credits system, handoff module, 10 migrations | CI has never seen this code. There is no rollback point. Last commit 2026-08-20. |

### P1 — required before scale

| # | Gap |
|---|---|
| P1-1 | No capability/relevance resolver — the core concept (§3.4) |
| P1-2 | Departments never created at onboarding; `Department.scopes` and `User.departmentId` have no UI → the whole authorization layer is inert |
| P1-3 | Approval routing / SLA / escalation unconfigurable; `EMPLOYEE_MANAGER`, `DEPARTMENT`, `TEAM` rules cannot resolve |
| P1-4 | `WorkflowRun.actingEmployeeId` unwired → no employee attribution, the stated differentiator |
| P1-5 | Per-employee model not honoured; cost attributed to the global model |
| P1-6 | Disabling an employee does not stop its scheduled/event workflows |
| P1-7 | Deleting a department silently un-scopes its users |
| P1-8 | No AI Employee config versioning → mid-run config changes |
| P1-9 | `TOOL_ACTION` without `employeeId` bypasses employee skill scoping |
| P1-10 | Vercel/inline deployment silently runs the non-durable engine |
| P1-11 | Frontend test coverage is ~25 test files for 34,379 lines; no browser suite in the repo |

### P2 — important

| # | Gap |
|---|---|
| P2-1 | Zero role-specific dashboard widgets despite ~15 populated domain tables |
| P2-2 | HR / Marketing / Support / PM domains have no product UI |
| P2-3 | `/workflows/:id/permissions` has no UI |
| P2-4 | Workflow `category` unsettable outside template install |
| P2-5 | Two template systems, two nav entries |
| P2-6 | `GET /authz/effective` promised in the PRD, does not exist |
| P2-7 | Marketing site advertises 3 AI Employees the product cannot create |
| P2-8 | `hoursSaved`/`costSavings` derived from hardcoded 10min/$25 (labelled "est.", but still headline tiles) |
| P2-9 | `role === 'OWNER'\|\|'ADMIN'` duplicated 5×; plan check duplicated 3× |
| P2-10 | Company/workflow timezone unused → server-tz scheduling |
| P2-11 | Empty-state dashboard gives a new customer nothing to do |

### P3 — later
SSO · semantic memory recall · analytics charts/trends · realtime WS · publisher marketplace · logo upload · per-node retry UI · Postgres RLS · `legacy_walk` removal.

---

# 12. Kill-Critic Section

### A. Features that should NOT be built
1. **A "ProductContext Engine" / new central configuration service.** There is zero duplicated configuration logic to consolidate (0 `if industry ===`). Building a framework here would add abstraction where the actual missing thing is one lookup table and four form fields.
2. **A general node-breadth push** (more node types, iPaaS parity). The PRD's own §0.9 non-goal. n8n wins that fight.
3. **Per-tool granular permission matrices.** `EmployeeSkill` grants are already enforced at execution and are the right coarseness for the current customer size.
4. **Postgres RLS right now.** Real gap, but application-level `companyId` filtering is consistent and tested. It is an enterprise-deal unlock, not a correctness fix.
5. **Reasoning strategies (`REACT`/`REFLECT`/`PLAN_ACT`).** Sold in the PRD, worth zero to a customer who cannot even pick a model. Delete the claim, don't build the feature.

### B. Duplicate architecture
1. **Two workflow-template systems** — `marketplace.catalog.ts` (15 code templates, `/marketplace`) and `WorkflowTemplate` (22 DB templates, `/workflows/templates`). Both in the nav. Kill the marketplace shim.
2. **Two workflow engines** — `state_machine` + `legacy_walk`. CI runs both on every push. Delete `legacy_walk`.
3. **Two department concepts** — `Department` rows (real, FK'd, authz-relevant) and `AiEmployee.department` free text (cosmetic). Merge.
4. **Two approval-rule vocabularies** — the UI's 3 keys and the policy's 2 keys. Pick one.
5. **Three copies of the plan check** in the frontend; **five copies** of the OWNER/ADMIN check in the backend.

### C. Over-engineered relative to what is reachable
1. **Approval routing + SLA + escalation** (P3-05: a migration, a cycle-safe module, multi-level chains, a cross-tenant sweep, 19 tests) — **not configurable from the product**, and half its rule types cannot resolve because three FK columns have no write path.
2. **Workflow permissions** (P3-06: model, migration, 7 subject/action pairs, 13 tests) — **no UI**.
3. **The HR domain** (P3-01: 6 models, field-level AES-GCM PII encryption, legal hold, time-based retention sweep) — **no UI at all**. This is the MVP's #1 persona.
4. **Credit system phases 4-13** (ledger, lots, FIFO consumption, reservations, refunds, reconciliation, finance rollups, platform-operator admin, canary cohorts) — enforcement is off, 5 of its cron jobs are unscheduled in the deploy manifest, and there is no customer-facing surface beyond a balance badge.

Blunt version: **the team keeps shipping the hardest 80% of a feature and skipping the 20% that makes it usable.** Every one of these is excellent code that no customer can reach.

### D. Can be deferred
Realtime WS · analytics charts · SSO · semantic memory · PM domain UI · publisher marketplace · logo upload · per-workflow timezone.

### E. Must be fixed immediately
1. Delete or wire the 7 dead settings controls (**hours**).
2. Add `requireRealProviderInProduction('SKILL_EXECUTOR', …)` (**minutes**).
3. Add the 6 missing crons to `vercel.json` (**minutes**).
4. Add `@RequirePermission` to the analytics controller (**minutes**).
5. Guard `EmployeesService.remove()` and stop cascading `InstalledSkill` (**hours**).
6. Commit the 222 files (**now**).
7. Either implement hubspot/jira/github/stripe executors or refuse to mark them CONNECTED (**days**).
8. Send real departments from the onboarding wizard (**hours**).

---

# 13. Completion Calculation

## 13.1 Product Concept Completion

Scoring: `COMPLETE=100 · MOSTLY=75 · PARTIAL=50 · MINIMAL=25 · MISSING=0`, adjusted to the audited evidence. UI-only implementation never scores above PARTIAL.

| # | Capability | Weight | Completion | Weighted | Evidence |
|---|---|---:|---:|---:|---|
| 1 | Auth, tenancy, sessions | 5 | 95% | 4.75 | JWT+refresh, OTP verify, reset, disabled-user kill switch, session timeout enforced |
| 2 | Onboarding capture | 4 | 60% | 2.40 | 3 resumable steps; departments never collected; 2 of 7 roles; backend catalog orphaned |
| 3 | **Configuration → product propagation** | 11 | 22% | 2.42 | Only knowledge role-scoping, seat limits and goal-pruning are live; 6 fields dead |
| 4 | AI Employee lifecycle | 5 | 65% | 3.25 | CRUD + status real; role immutable; delete destroys history; no config version |
| 5 | AI Employee configuration | 5 | 40% | 2.00 | 10 fields persist; model/language/hours/permissions/approval-checkboxes inert |
| 6 | AI Employee chat runtime | 7 | 85% | 5.95 | plan→retrieve→memory→act→validate; citations, confidence, approval + budget gates |
| 7 | Knowledge / RAG + role scoping | 6 | 90% | 5.40 | pgvector HNSW, tenant-scoped, role-scoped in chat **and** in the RETRIEVE node |
| 8 | Skills catalog / install / connect | 6 | 60% | 3.60 | 15 skills, 4 OAuth providers, 5 verify adapters; 4 skills permanently mocked; no relevance |
| 9 | Skill execution + audit + scoping | 6 | 70% | 4.20 | `employeeMayUseSkill` real; `SkillExecution` audit; unscoped TOOL_ACTION bypass; mock default |
| 10 | Workflow authoring | 7 | 85% | 5.95 | canvas, 19 node types, readiness invariant, versions, AI Assist |
| 11 | Workflow execution engine | 8 | 80% | 6.40 | durable state machine on by default; attempts/leases/reaper/DLQ; inline silently downgrades |
| 12 | Triggers | 4 | 75% | 3.00 | manual/schedule/webhook/event all real; no timezone; 6 crons unscheduled |
| 13 | Approvals | 6 | 55% | 3.30 | gate + canDecide + SLA real and tested; unconfigurable; 3 of 6 rule types unresolvable |
| 14 | RBAC / permissions / dept scoping | 6 | 35% | 2.10 | Excellent policy engine; adopted by 10/51 controllers; scopes + dept assignment unreachable |
| 15 | Dashboard / analytics | 6 | 40% | 2.40 | real aggregates; generic; no authz; no role widgets; no run attribution |
| 16 | Billing / plans / credits | 4 | 70% | 2.80 | plans, seats, Stripe provider, full ledger; enforcement off; 5 crons unscheduled |
| 17 | Vertical domains (HR/Mkt/Support/PM) | 4 | 30% | 1.20 | backends + engines real; zero product UI for any of the four |
| | **TOTAL** | **100** | | **61.12** | |

```
Product Concept Completion = Σ(weight × completion) / 100 = 61.12 / 100
```
> ## = **61%**

## 13.2 Production Readiness

| Dimension | Weight | Score | Weighted | Evidence |
|---|---:|---:|---:|---|
| Architecture & tenant isolation | 15 | 75% | 11.25 | Consistent `companyId` filtering, pure-function policy, clean module graph; no RLS; 2 engines; 2 template systems |
| Security | 20 | 62% | 12.40 | AES-GCM at rest, PKCE OAuth, kill switch, approval gate, disposable-domain checks, SSRF guard **·** unguarded prod mock executor, no MFA/SSO, dept isolation unreachable, unscoped TOOL_ACTION bypass, 4 fake connectors, 7 dead safety controls |
| Reliability & recovery | 15 | 78% | 11.70 | Durable engine, attempts/leases/reaper, DLQ, circuit breaker, rate limiter, idempotency records, watchdog **·** inline mode loses all of it; 6 crons unscheduled |
| Data integrity & lifecycle | 15 | 50% | 7.50 | 62 migrations, FKs, retention, legal hold, audit chain **·** destructive employee delete, dept-delete privilege widening, orphan approvals, dead columns |
| Observability | 10 | 80% | 8.00 | Metrics registry, structured logger, correlation IDs, OTel tracing, Prometheus+Jaeger running, alerts cron, `/admin/health`, `/admin/dlq` |
| Testing | 15 | 72% | 10.80 | **793 unit tests green, verified this session**; 91 e2e suites; CI runs both engines **·** full e2e not completable here; ~25 web tests for 34k lines; no browser suite in-repo |
| Deployment & config safety | 10 | 55% | 5.50 | Real CI (lint/typecheck/e2e), Vercel manifest, provider guards for LLM/billing/mail **·** 222 uncommitted files, 6 unscheduled crons, mock-default executor, inline→legacy downgrade |
| **TOTAL** | **100** | | **67.15** | |

```
Production Readiness = 11.25+12.40+11.70+7.50+8.00+10.80+5.50 = 67.15
```
> ## = **67%**

## 13.3 Configuration Dependency Completion

39 configuration items scored across 7 stages, weighted so that "stored but never consumed" scores low, per the brief:

`Collected in UI ×1 · Stored ×1 · Read by backend ×2 · Affects runtime ×3 · Surfaced back ×1 · Editable later ×1 · Reachable without raw API ×2` → **max 11 per item, 429 total**.

| Band | Items | Examples |
|---|---|---|
| **9–11 (fully wired)** | 12 | company name, user role, plan, employee name/persona, `knowledgeAccess`, `budgetLimit`, session timeout, retention days, skill config, skill connection, per-employee connection |
| **6–8 (wired but unreachable, or partial)** | 13 | departments, `Department.scopes`, `User.departmentId`, industry, size, `maxCredits*`, `requireApprovalForTools`, routing, goals/KPIs, employee role, workflow category, workflow permissions, mfaRequired |
| **3–5 (visible but inert)** | 9 | employee department text, working hours, language, employee timezone, permission checkboxes, approval checkboxes, employee model, website, `User.managerUserId` |
| **≤2 (dead)** | 5 | country, company timezone, logoUrl, company description, `defaultApprovalSlaMinutes` |

```
Σ item scores = 290.5
Configuration Dependency Completion = 290.5 / 429 = 0.677
```
> ## = **68%**

**Read this number carefully.** It is high because the *technical* configuration (skill credentials, security policy, budgets, plans, knowledge access) is genuinely well wired. The *business* configuration — the part that is supposed to make the product feel tailored — is the part that is dead. That asymmetry is exactly what the next number isolates.

## 13.4 Configuration-Driven Architecture

Calculated in §3.7:
```
(15×0.90)+(20×0.45)+(20×0.15)+(15×0.70)+(10×0.10)+(10×0.25)+(10×0.55) = 45.0
```
> ## = **45%**

---

# 14. Final Remaining Work

## PHASE 0 — Critical broken dependencies (1 week)

| # | Problem | Impact | Files / modules | Depends on | Size |
|---|---|---|---|---|---|
| 0.1 | 7 AI Employee settings controls have no runtime effect | Customers configure safety controls that do nothing | `web/.../employees/labels.ts`, `EmployeeSettings.tsx`, `api/.../skills/tool-approval-policy.ts`, `employees/runtime/tool-executor.service.ts` | — | **MEDIUM** |
| 0.2 | Production can boot with the mock skill executor | Silent fake integrations in prod | `api/.../skills/skills.module.ts:62` (+ `common/config/require-real-provider.ts`) | — | **SMALL** |
| 0.3 | 6 cron jobs unscheduled on Vercel | Paying customers get no monthly credits; reservations leak; IMAP dead | `apps/api/vercel.json` | — | **SMALL** |
| 0.4 | Analytics has no authorization | MEMBER reads all employees' KPIs | `analytics.controller.ts`, `analytics.service.ts` | AuthorizationModule | **SMALL** |
| 0.5 | Employee delete is a destructive unguarded cascade | Loses conversations, memories, grants and **encrypted credentials** | `employees.service.ts:201`, `schema.prisma` (`InstalledSkill.employeeId` → `SetNull`), new migration | — | **MEDIUM** |
| 0.6 | Deleting a department silently un-scopes its users | Privilege widening | `organization.service.ts:99` | — | **SMALL** |
| 0.7 | 222 uncommitted files | No CI, no rollback | repo | — | **SMALL** |
| 0.8 | hubspot / jira / github / stripe are permanently mocked while OAuth says CONNECTED | Customers believe real writes are happening | `real-skill-executor.ts`, `providers/index.ts` | — | **LARGE** |
| 0.9 | Onboarding sends `departments: []` | Empties the authorization axis for every tenant | `OnboardingWizard.tsx:103` (+ a departments step) | — | **SMALL** |

## PHASE 1 — Configuration-driven architecture (2–3 weeks)

| # | Problem | Impact | Files / modules | Depends on | Size |
|---|---|---|---|---|---|
| 1.1 | No relevance map | The core concept | new `api/.../skills/relevance.ts` (mirror `capabilities.ts` + a spec test) | — | **MEDIUM** |
| 1.2 | No effective-context endpoint | Frontend has nothing to read | new `GET /context/effective` (also satisfies the PRD's `GET /authz/effective`) | 1.1 | **MEDIUM** |
| 1.3 | Frontend has no context hook | Static nav + generic catalogs | `features/tenant`, `Sidebar.tsx`, `/skills`, `/workflows/templates`, `/marketplace` | 1.2 | **MEDIUM** |
| 1.4 | `Department.scopes` has no input | The authorization layer is inert | `DepartmentSection.tsx` | — | **SMALL** |
| 1.5 | `User.departmentId`/`teamId`/`managerUserId` have no input; `managerUserId` has no DTO | 3 of 6 routing rule types unresolvable | `UpdateUserDto`, `users.service.ts`, `UserForm.tsx`, `UserList.tsx` | 1.4 | **MEDIUM** |
| 1.6 | Onboarding does not use the backend catalog | Dead configuration-driven filtering | `OnboardingWizard.tsx`, `useOnboardingCatalog` | 0.9 | **SMALL** |
| 1.7 | `businessGoals` feeds nothing | A whole wizard step does nothing | `relevance.ts`, template ranking, assist prompt | 1.1 | **SMALL** |
| 1.8 | AI Assist plan gate missing in the sidebar; plan check duplicated 3× | Every STARTER user hits a 403 | `Sidebar.tsx`, one shared `useEntitlements()` | 1.2 | **SMALL** |

## PHASE 2 — Role and AI Employee relevance (2–3 weeks)

| # | Problem | Impact | Files / modules | Depends on | Size |
|---|---|---|---|---|---|
| 2.1 | `WorkflowRun.actingEmployeeId` unwired | The product's stated differentiator | `run-state-writer.service.ts`, `workflows.service.ts`, `analytics.service.ts` | — | **MEDIUM** |
| 2.2 | `AiEmployee.model` never reaches the LLM | Per-employee model + cost attribution are false | `llm.provider.ts` (`LlmCompletionInput.model`), both providers, `agent-runtime`, `ai-step.handler` | — | **MEDIUM** |
| 2.3 | Working hours / language / timezone inert | Three settings that do nothing | `agent-runtime.service.ts` prompt builder | — | **SMALL** |
| 2.4 | No AI Employee config versioning | Mid-run config changes | `schema.prisma` (`AiEmployee.configVersion` + snapshot on run start), engine | 2.1 | **LARGE** |
| 2.5 | Role immutable; changing it means destroying history | Forces the destructive path | `UpdateEmployeeDto`, `employees.service.ts` | 2.4 | **MEDIUM** |
| 2.6 | Disabling an employee does not stop its workflows | Disabled staff keep working | `workflows.service.ts` enqueue guard, schedule activation | 2.1 | **MEDIUM** |
| 2.7 | Unscoped `TOOL_ACTION` bypasses employee skill scoping | Contradicts the PRD's "structurally unable" claim | `tool-action.handler.ts`, `skills.service.ts:546` | — | **MEDIUM** |
| 2.8 | Approval routing / SLA unconfigurable | An entire wave is unreachable | new routing editor in `EmployeeSettings` + `NodeEditor`; wire `defaultApprovalSlaMinutes` | 1.5 | **LARGE** |
| 2.9 | Workflow permissions have no UI | An entire wave is unreachable | new share dialog on `/workflows/[id]` | 1.5 | **MEDIUM** |
| 2.10 | `Workflow.category` unsettable | Workflow-side department scoping inert | workflow settings form | 1.4 | **SMALL** |

## PHASE 3 — Dashboard and operational visibility (3–4 weeks)

| # | Problem | Impact | Files / modules | Depends on | Size |
|---|---|---|---|---|---|
| 3.1 | Dashboard is generic | No relevance after onboarding | `analytics.service.ts` + role-specific sections; `/dashboard` | 1.2, 2.1 | **LARGE** |
| 3.2 | Marketing domain has no UI | 7 populated tables invisible | new `/marketing` (campaigns, scheduled posts, published, brand assets) | — | **LARGE** |
| 3.3 | HR domain has no UI — the MVP's #1 persona | 6 models + PII encryption + retention invisible | new `/hr` (staff, leave, reviews, documents, onboarding tasks, attendance) | — | **XL** |
| 3.4 | Support domain has no UI | Conversations + handoffs invisible | new `/support` | — | **LARGE** |
| 3.5 | Empty state gives a new customer nothing | Poor first run | `/dashboard` | 1.2 | **SMALL** |
| 3.6 | `hoursSaved`/`costSavings` from hardcoded constants | Headline tiles are assumptions | `analytics.constants.ts` + customer-supplied inputs in `/organization` | — | **MEDIUM** |

## PHASE 4 — Production hardening (ongoing)

| # | Problem | Impact | Files / modules | Size |
|---|---|---|---|---|
| 4.1 | Vercel/inline runs the non-durable engine | Prod lacks the safety features that are on everywhere else | deployment shape: one always-on worker + `WORKFLOW_EXECUTION_MODE=queue` | **LARGE** |
| 4.2 | Frontend test coverage ~25 files / 34k lines; no browser suite in-repo | UI regressions ship | Playwright suite for the golden journeys | **LARGE** |
| 4.3 | Two template systems, two engines | Maintenance + confusion | delete `marketplace.catalog` workflows; delete `legacy_walk` | **MEDIUM** |
| 4.4 | Duplicated `OWNER\|ADMIN` (5×) and plan (3×) checks | Drift risk | route through `authz.can()` / `useEntitlements()` | **SMALL** |
| 4.5 | Marketing site sells 3 unbuildable AI Employees | Oversell | `features/marketing/ai-employees.ts` | **SMALL** |
| 4.6 | No Postgres RLS | Enterprise security review | phased, per-table | **XL** |
| 4.7 | Orphaned jest processes poison e2e runs | Untrustworthy test results (hit me twice in this audit) | a `pretest` cleanup script | **SMALL** |
| 4.8 | No SSO | Enterprise blocker (already removed from the sold feature list — correctly) | — | **XL** |

---

# 15. FINAL VERDICT

> ## **B — CORE PRODUCT PARTIALLY REALIZED**

Not (A) — this is emphatically not a disconnected concept. Real customers can register, hire an AI Employee, upload documents, connect Gmail or Slack, chat with a grounded agent that cites its sources, describe a workflow in English, publish it, watch it run on a durable engine, approve a high-risk action and be billed for it. That whole path works.

Not (C) — because "functionally complete" would require the configuration model to be connected, and it is not. The single organising principle the product is built on — *configure once, and the system behaves accordingly* — is 45% implemented, and the missing 55% is the part the customer actually experiences.

### The honest summary for the founder

**What you have:** an unusually well-engineered execution platform. The durable state machine, the authorization policy, the credit ledger, the knowledge role-scoping and the connector resilience layer are all better than they need to be at this stage. 793 unit tests pass. CI is real.

**What you do not have:** a product that behaves differently for a healthcare recruiter than for a marketing agency. Onboarding asks four questions and uses one of them. The dashboard is the same for everyone. The skill list is the same for everyone. The sidebar is the same for everyone.

**The most expensive pattern in this codebase** is not bugs — it is finished backends with no front door. Approval routing, workflow permissions, department scoping, the entire HR domain, per-employee model choice: five substantial, tested, migrated bodies of work that no customer can reach. Roughly a third of the engineering investment in this repo is currently unsellable for want of, in several cases, a single form field.

**The most dangerous finding** is the seven checkboxes. A product that asks a customer to tick "Make payments: off" and "Require approval for external messages", stores their answer, shows it back to them on reload, and then ignores both at execution time, is making a safety promise it does not keep. Fix that this week, before anything else on this list.

---

## Appendix A — Changes I made to the system during this audit

Per the audit's implementation restriction, I made **no code changes**. The only non-read actions were:

1. Ran `jest --config test/jest-unit.json` (read-only; 793 tests passed).
2. Started the e2e suite twice against the local dev Postgres/Redis; both were stopped without completing. These runs write to the local dev database only.
3. Attempted to terminate two orphaned jest processes from 2026-08-20 — **denied by the sandbox**; they are still running and still holding Redis connections.

No file in `apps/`, `packages/` or `prisma/` was modified. This report is the only file created.

## Appendix B — Verification commands for the load-bearing claims

```bash
# The onboarding wizard sends no departments
grep -n "departments: \[\]" apps/web/src/features/onboarding/components/OnboardingWizard.tsx

# The backend hire catalog is orphaned
grep -rn "useOnboardingCatalog" apps/web/src --include=*.tsx      # → no results

# businessGoals has no consumer outside onboarding
grep -rn "businessGoals" apps/api/src apps/web/src | grep -v onboarding

# actingEmployeeId is a dead column
grep -rn "actingEmployeeId" apps packages                          # → 1 hit: schema.prisma

# defaultApprovalSlaMinutes is a dead column
grep -rn "defaultApprovalSlaMinutes" apps packages                 # → no results

# AiEmployee.permissions is never read at runtime
grep -rn "employee.permissions" apps/api/src                       # → no results

# The approval policy reads different keys than the UI writes
grep -n "requireApprovalForAllTools\|requireApprovalForTools" apps/api/src/modules/skills/tool-approval-policy.ts
grep -n "approveOverBudget\|approveExternalMessages\|approveRefunds" apps/web/src/features/employees/labels.ts

# Per-employee model never reaches the provider
grep -n "LLM_MODEL" apps/api/src/modules/employees/llm/*.ts
grep -n "model" apps/api/src/modules/employees/llm/llm.provider.ts  # LlmCompletionInput has no model field

# Department.scopes and User.departmentId have no UI
grep -n "scopes" apps/web/src/features/organization/components/DepartmentSection.tsx   # → no results
grep -n "departmentId" apps/web/src/features/users/components/UserForm.tsx             # → no results

# No real executor for 4 skills
grep -n "case 'hubspot\|case 'jira\|case 'github\|case 'stripe" apps/api/src/modules/skills/executors/real-skill-executor.ts  # → no results

# SKILL_EXECUTOR has no production guard
grep -n "requireRealProviderInProduction" apps/api/src/modules/skills/skills.module.ts # → no results

# 6 cron jobs are not scheduled
grep -c "imap-poll\|credit-reservation-sweep\|subscription-credit-renewal\|credit-reconciliation\|credit-finance-rollup\|enterprise-credit" apps/api/vercel.json   # → 0

# The HR API has no frontend consumer
grep -rn "'/hr/" apps/web/src                                       # → no results

# Analytics has no authorization
grep -n "UseGuards\|RequirePermission\|Roles" apps/api/src/modules/analytics/analytics.controller.ts
```
