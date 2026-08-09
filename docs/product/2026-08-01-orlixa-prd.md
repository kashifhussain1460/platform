# Orlixa — Product Requirements Document

**Product:** Orlixa (formerly V-AEP) — Enterprise AI Employee Operating System
**MVP scope:** two AI Employees — **HR** and **Marketing**

---

## 1. Document control

| Field | Value |
|---|---|
| Document | `docs/product/2026-08-01-orlixa-prd.md` |
| Version | 1.0 |
| Status | Draft for review — **not yet approved for build**; several open questions in §21 block sign-off |
| Owner | Principal Product Manager, Orlixa |
| Reviewers (proposed) | Head of Engineering (workflow system); Staff Engineer, execution engine (ADR-001/ADR-005 owner); Security/Compliance lead; Founder/CEO (business goals, plan/pricing); HR domain SME; Marketing domain SME |
| Approvals required before build starts | Engineering (feasibility + wave sequencing), Security (G25/G29 remediation plan, licensing exposure), Founder (business goals, plan tiers) |
| Related architecture documents (single source of truth for every requirement below) | `docs/architecture/workflow-system/00-overview-and-canonical-contracts.md` (canonical enums/contracts, gap audit G1–G30, ADRs, NFR targets, wave sequencing) · `01-workflow-core.md` (versioning, lifecycle, templates) · `02-node-architecture.md` (node contract/registry) · `03-ai-employees.md` (HR + Marketing Employee model, F1–F6) · `04-skills-connectors.md` (connector framework, auth, resilience) · `05-execution-engine.md` (durable state machine) · `06-variables.md` (variables/secrets/expressions) · `07-knowledge-memory.md` (retrieval + memory) · `08-approvals.md` (routing/SLA/escalation) · `09-permissions.md` (8-level permission model) · `10-audit.md` (audit/cost attribution) · `11-analytics.md` (metrics) · `12-database.md` (schema/partitioning) · `13-api.md` (REST/WebSocket surface) · `14-json-contract.md` (canonical workflow JSON) · `15-frontend.md` (canvas UI) |
| Related status document | `docs/status/2026-07-27-complete-progress-documentation.md` — ground-truth snapshot of what is built today; this PRD's SHIPPED/IN PROGRESS/PROPOSED markers are reconciled against it |
| Change control | Any change to a Functional or Non-Functional Requirement number must update the traceability matrix in §22 and be re-reviewed by Engineering |

---

## 2. Executive summary

Orlixa lets a company **hire AI Employees** instead of buying chatbot licenses or building automations from scratch. An AI Employee has a role, a department, a manager, a budget, connected tools ("Skills"), company knowledge, memory, and the authority to run multi-step workflows with human approval gates on anything high-stakes. The MVP ships exactly two: an **HR Employee** (recruitment through exit, 13 capabilities) and a **Marketing Employee** (campaign planning through paid-ad briefs, 10 capabilities).

The platform today is a real, deployed product — not a prototype. Fifteen backend modules are shipped and in production use (a live tenant runs real recruiting workflows), three of ten researched "AI Workforce Engines" are fully wired (Postiz for social publishing, Chatwoot for support, Plane for project management), and the system is live on Vercel/Neon/Upstash. It is also, by the architecture team's own verified 30-item gap audit, missing load-bearing enterprise capability: workflow versioning, durable waits beyond ten seconds, per-node retry, department-scoped permissions, routed/escalating approvals, and — most urgently — a safety control that is silently bypassed (G25: a workflow can call a "requires approval" tool with zero approval gate) and a delete endpoint that destroys audit history (G29). This PRD's Functional and Non-Functional Requirements close exactly those gaps, in the sequence the architecture's own implementation waves (W0–W9) specify, and its Risk Analysis treats G25 and G29 as ship-blocking, not backlog items.

The MVP additionally requires one enum value that does not exist today: `EmployeeRole.MARKETING`. Without it, a Marketing Employee is created as `CUSTOM`, which silently disables role-scoped knowledge retrieval and role-based analytics — a correctness bug that would ship invisibly if this PRD did not call it out explicitly (G10).

---

## 3. Product Vision

**An AI Employee is a digital member of staff, not a workflow engine with a chat window bolted on.** Every other node-based automation tool (n8n, Power Automate, Zapier) inverts this: the graph is primary, and "AI" is one node type among hundreds. Orlixa inverts it back (doc 00 §0.2): the Employee is the primary abstraction — it has a role, a budget, a manager, permissions, and KPIs — and a workflow is simply one thing that Employee does on the company's behalf. Concretely, this means every run is attributed to an Employee (not just a workflow), every tool call is scoped by what that Employee is allowed to touch, every high-stakes action pauses for a human the way a new hire's work would be reviewed, and every Employee's answers are grounded in that specific company's documents — never a generic model's guess.

The long-run vision is a roster of AI Employees a company can hire the way it hires people — Support, Sales, Recruiter, HR, Marketing, Accountant, Project Manager today, more roles later — each auditable, each budgeted, each replaceable without disrupting the others. The MVP proves this model with two employees whose capability sets are wide enough to be genuinely useful (13 HR capabilities, 10 Marketing capabilities) and narrow enough to ship honestly.

---

## 4. Business Goals

| # | Goal | Measurable target | Instrumented by (doc 11 — Analytics) |
|---|---|---|---|
| BG-1 | Prove the "hire an AI Employee" model converts | ≥ 15% of trial companies activate at least one AI Employee (HR or Marketing) and run ≥ 1 real workflow within 14 days of signup | `11.B Workflow & execution analytics` — run counts per company per employee, first-run-to-signup latency |
| BG-2 | Reduce HR operational load measurably | Pilot customers report ≥ 30% reduction in time-to-screen for CV screening and ≥ 20% reduction in average leave-decision turnaround, measured against the HR Employee's own declared KPIs (doc 03 §3.1.2) | `11.F Employee productivity & skill usage` (per-capability KPI attainment vs `AiEmployee.kpiTargets`) |
| BG-3 | Marketing Employee drives real publishing volume, not just drafts | ≥ 50% of scheduled posts drafted by the Marketing Employee are approved and published within their scheduled window | `11.B`/`11.F` — `ScheduledPost`/`PublishedPost` counts vs `Campaign` targets |
| BG-4 | Approval Center is trusted, not bypassed | Zero occurrences of a `highRisk` or `requireApprovalForAllTools` tool executing without a corresponding `ApprovalRequest` row (closes G25) | `10.A`/`10.C` audit event stream — every `TOOL_ACTION`/`AI_EMPLOYEE_STEP` side effect must have a matching approval or an explicit auto-approve flag; a security dashboard alert fires on any gap |
| BG-5 | Cost stays predictable per Employee | 95% of companies stay within 10% of their configured `AiEmployee.budgetLimit`/`BudgetConfig.monthlyUsdCap` in any given month | `11.E AI cost analytics` — per-employee monthly spend vs budget, alert-threshold breach rate |
| BG-6 | Enterprise deals are not blocked by missing controls | Win rate on deals ≥ 500 seats where department-scoped RBAC (Phase 9) and routed approvals (Phase 8) were an explicit requirement ≥ 40% once both ship (W6) | Sales-reported deal data cross-referenced with `GET /authz/effective` adoption and `ApprovalRoutingConfig` usage counts |
| BG-7 | Run history is durable, satisfying "show me every decision from Q1" | 100% of `WorkflowRun`/`WorkflowStepRun` history survives a workflow deletion (closes G29) | Audit completeness check (doc 10 §0.8 target: 100% of state transitions retained) |

---

## 5. Market context & competitive positioning

Orlixa competes for budget with n8n, Microsoft Power Automate, Zapier, and Microsoft Copilot Studio. All four are credible, well-funded incumbents; Orlixa does not out-node them. The positioning is deliberate exclusion, not breadth (doc 00 §0.2, §0.9):

| Dimension | n8n / Zapier / Power Automate | Copilot Studio | **Orlixa** |
|---|---|---|---|
| Primary abstraction | The workflow graph. "AI" is one node type among hundreds. | The copilot/agent, but scoped to a single bot's conversational surface — no cross-functional "digital employee" concept with budget/manager/department | **The AI Employee.** The workflow is something the Employee executes; cost, tokens, KPIs, and permissions roll up to the Employee, not the graph (doc 00 §0.2 point 1). |
| Attribution | "Which workflow ran" | "Which bot answered" | "Which digital worker did this" — no competitor names this as a first-class attribution key |
| Authorization scope | User-level or workspace-level | Per-bot / per-connector | **Employee-scoped at execution time** — an HR Employee is structurally unable to call a Marketing connector because its `EmployeeSkill` grants don't include it, enforced in the engine, not just hidden in the UI (doc 00 §0.2 point 2; doc 09 closes the gap where this was previously UI-only) |
| Approval / human-in-the-loop | Bolted-on "human review" connectors in some products; not a first-class node with routing/SLA/escalation | Present in some flows via Power Automate approvals, not integrated with an "Employee" concept | **`APPROVAL` is a first-class node type** with routing, multi-level chains, SLA, and escalation (doc 08) — though see Risk G25 for where this control is *currently* bypassable from a workflow, which is the single most important gap this PRD requires closed before claiming parity |
| Knowledge grounding | Generic RAG connector, not role-scoped | Copilot-level knowledge sources, not workflow-node-level | **Knowledge/Memory are node types** with role-scoping so an HR document never leaks into a Marketing Employee's context (doc 00 §0.2 point 4; doc 07) |
| Reasoning configurability | Not applicable — no "employee" to configure | Per-bot instructions | **Per-Employee reasoning strategy** (`DIRECT`/`PLAN_ACT`/`REACT`/`REFLECT`), model choice, and prompt strategy (doc 00 §0.2 point 5; doc 03 §3.0) |
| Node catalogue breadth | 400+ nodes (n8n) | Wide, Microsoft-ecosystem-deep | **Deliberately narrow** — doc 00 §0.9 non-goal #1: not a general-purpose iPaaS. Breadth comes from the Skills/connector layer, not node count. |
| Code execution in workflows | Some products allow arbitrary JS/Python nodes | Limited | **Explicitly excluded in v1** (doc 00 §0.9 non-goal #2) — `TRANSFORM` uses a safe declarative evaluator only; arbitrary code in a multi-tenant runtime is treated as an RCE/sandboxing problem larger than its v1 value |

**Where Orlixa is honestly behind today, stated for the sales/marketing organization so it is never oversold:** no durable wait beyond 10 seconds (G2), no parallel branches (G3), no per-node retry (G4), a 50-node cap (G16), and the approval-bypass safety gap (G25). Positioning against n8n/Power Automate on "enterprise workflow depth" before Wave W3 ships would be a claim the product cannot back up in a competitive bake-off.

---

## 6. User Personas (the humans)

| Persona | Goals | Pains today | Jobs-to-be-done | Success criteria | What they touch |
|---|---|---|---|---|---|
| **HR Manager / Director** | Reduce time-to-hire and administrative load; keep compliance deadlines met | Manual CV screening, scattered leave/attendance tracking, no single source of truth for staff records | "Hire" an HR Employee that screens CVs, schedules interviews, and routes leave/exit decisions to me for a quick yes/no | CVs screened/day, time-to-screen, zero missed compliance deadlines (doc 03 §3.1.2 KPI column) | HR Employee chat, `/hr/staff` roster, Approval Center inbox, HR workflow templates |
| **Marketing Manager** | Ship a consistent publishing cadence without a full-time coordinator | Manually drafting captions, tracking what's scheduled where, no single dashboard for campaign performance | "Hire" a Marketing Employee that drafts on-brand content, schedules it, and reports on performance weekly | Posts published on schedule %, campaign goal attainment % (doc 03 §3.2.2) | Marketing Employee chat, `/marketing/campaigns`, Approval Center (publish gate), analytics snapshots |
| **Company Owner / Admin** | Buy the platform once, trust it enforces the controls it's sold on | No visibility into whether a "requires approval" setting is actually holding; billing/budget surprises | Configure budget limits and approval rules once, trust every Employee and every workflow honors them | Zero unauthorized high-risk executions (BG-4); spend within 10% of budget (BG-5) | Employee configuration screens, Organization/Security Policy settings, Billing |
| **IT / Security Reviewer** | Pass a security review before signing a contract | SSO/audit-log features are sold but not built (per §19); multi-tenant isolation is application-enforced, not DB-enforced | Get a straight answer on what is enforced server-side vs UI-only before recommending purchase | A written, honest answer to "is this enforced or just hidden" for every control they ask about | `GET /authz/effective`, audit log export, this PRD's Enterprise Constraints section (§19) |
| **Individual Contributor (staff member)** | Get a leave request or a document verified quickly, without chasing HR by email | Slow, opaque HR processes; no visibility into where a request sits | Submit a leave request, get a fast, policy-grounded decision, see status without asking | Leave-decision turnaround measured and trending down | Chat with the HR Employee; `/hr/staff/:id/leave-requests` |

---

## 7. Company Personas (the buying organisations)

| Dimension | **Startup** (~50 people) | **Scale-up** (~500 people) | **Enterprise** (~5,000 people) |
|---|---|---|---|
| Buying trigger | Founder wants HR/marketing coverage without hiring a coordinator | Growing HR/marketing team wants to stop drowning in manual coordination as headcount scales | Procurement-driven: replacing/augmenting an existing HRIS/marketing stack, needs a defensible security posture |
| Procurement/security expectations | Minimal — a signed DPA and "is my data isolated" answer is usually enough | A security questionnaire, but no hard SSO/audit-log requirement yet | Full vendor security review: SSO (not yet built — see §19), audit log retention and export, data residency questions, a real SLA |
| Deployment shape | Single company, few AI Employees, low workflow volume | Multiple departments, moderate run volume, first real need for approval routing beyond "any admin" | Department/team-scoped RBAC required from day one (doc 09), high run volume, needs the durable-wait/retry/parallel capability (Wave W3) to trust the platform with real payroll/compliance timing |
| Plan tier (existing `Plan` enum: `STARTER \| PRO \| BUSINESS \| ENTERPRISE`) | `STARTER`/`PRO` | `PRO`/`BUSINESS` | `ENTERPRISE` |
| Which doc 00 §0.8 constraint bites hardest | Run-start p95 <2s and node-attempt overhead are invisible at this volume — non-issues | Durable-wait accuracy (±30s) starts mattering the first time a 3-day approval SLA is configured; per-tenant blast-radius isolation matters the first time one bad workflow misfires | All of §0.8 simultaneously: 10M node-attempts/day throughput, 90d/400d retention, <60s orphan recovery, and — critically — the fact that tenant isolation is `companyId`-filtered application code, not Postgres RLS on every table (ADR-005), is exactly the kind of finding a Fortune-500 security review will flag |

---

## 8. HR Employee Persona

**Role:** `EmployeeRole.HR` (existing enum value; scope **widened**, not replaced — doc 03 §3.1.3 ADR). **Department:** typically People Operations. **Reports to:** configurable `managerUserId` (doc 03 §3.0.5, once the FK migration lands; today a free-text `managerName`).

### Responsibilities (13/13 capabilities, doc 03 §3.1.2)

| # | Capability | Autonomous or gated | MVP or later | Notes |
|---|---|---|---|---|
| 1 | Recruitment (intake) | Autonomous (draft/read only) | MVP | No approval — nothing high-stakes happens until scheduling/shortlisting |
| 2 | Interview scheduling | Autonomous | MVP | Only capability with real prior-art (`scheduling`/`gmail`/`calendar` skills, EXISTING) |
| 3 | Resume screening | **Gated** — HR is in `HIGH_STAKES_ROLES`, every screening turn requires approval | MVP | No real document-parsing pipeline yet (honest limitation, §18) |
| 4 | Employee onboarding | **Gated** (offer/setup step) | MVP | Requires `StaffMember` (NEW roster model, §8 below) |
| 5 | Leave management | **Gated** (`record_leave_decision` is `highRisk`) | MVP | AI reasons from retrieved policy text, not a computed leave balance (explicit non-feature) |
| 6 | Attendance | Autonomous | MVP | Batch-write pattern required at MNC scale (2,000+ staff) |
| 7 | Performance review | **Gated** | MVP | |
| 8 | Exit process | **Gated** | MVP | Access revocation (`github.remove_collaborator`) is **simulated only** — no real IT de-provisioning exists |
| 9 | Compliance | Autonomous (reminders only) | MVP | |
| 10 | Policy management | **Gated** for publishing a policy change | MVP | |
| 11 | Employee records | Gated only for status-changing updates | MVP | |
| 12 | Document verification | **Gated** (HR is high-stakes) | MVP | No layout-aware PDF/DOCX parsing — honest limitation |
| 13 | Payroll coordination | **Gated** (money-adjacent) | MVP | Coordination only — never computes net pay/tax/statutory deductions; this scope boundary must be stated to customers explicitly |

All 13 are scoped MVP by the architecture (doc 03 promises 13/13 coverage); this PRD treats them as MVP-complete only once every "NEW" status template/skill in doc 03 §3.1 ships — see the Feature Breakdown (§15) for per-capability SHIPPED/IN PROGRESS/PROPOSED status, which today is **PROPOSED for all 13** except capability 2 (interview scheduling), which has real, working prior art.

### KPIs
Time-to-first-contact, candidates sourced/week, interview no-show %, CVs screened/day, time-to-productive, avg leave-decision turnaround, on-time attendance rate, reviews completed on time %, offboarding completion %, compliance deadlines missed (target 0), policy-question resolution rate, record accuracy, verification turnaround time, payroll data submitted on time % (full mapping: doc 03 §3.1.2).

### What it may and may not do autonomously
- **Never autonomous, always gated:** any `StaffMember` status transition (`update_staff_status`), leave/exit/performance-review decisions, document verification sign-off, payroll handoff. These are `highRisk: true` tools by design (doc 03 §3.1.11) — deliberately split from non-risky record edits.
- **HR is blanket `HIGH_STAKES_ROLES`:** every chat turn and every `AI_EMPLOYEE_STEP` using the HR Employee sets `needsApproval: true` regardless of confidence (doc 03 §3.0.10 point 2) — a stronger gate than Marketing's action-specific gating.
- **Escalation:** today, only "any OWNER/ADMIN decides" (blanket). Post-Phase-8, escalation follows a configured chain (department head → any admin → auto-reject on timeout) — see FR-801–FR-806.

### Genuine cross-role conflict, resolved
Widening `ROLE_SCOPE.HR` to include recruiting/CV screening creates a real self-contradiction risk: two hardcoded prompts say "CV screening is RECRUITER work," so a widened HR Employee asked to screen a CV could read its own system prompt and refuse the job it was just hired to do (G18). **This PRD requires both hardcoded strings fixed in the same change that widens `ROLE_SCOPE.HR`** (FR-301).

---

## 9. Marketing Employee Persona

**Role:** `EmployeeRole.MARKETING` — **does not exist in the schema today (G10)**; this is a hard MVP prerequisite, not a nice-to-have (FR-101). **Department:** typically Marketing. Needs no new roster model — its domain tables (`Campaign`, `MediaAsset`, `BrandAsset`, `MarketingAnalyticsSnapshot`) already exist in the schema but have **zero application-code wiring today** (F5, doc 03 §3.2.1).

### Responsibilities (10/10 capabilities, doc 03 §3.2.2)

| # | Capability | Autonomous or gated | MVP or later | Notes |
|---|---|---|---|---|
| 1 | Campaign Planning | Autonomous (drafting a campaign isn't risky) | MVP | Wiring is NEW; the `Campaign` table already exists |
| 2 | Content Creation | Autonomous (drafting only; publish is gated downstream) | MVP | |
| 3 | Social Media (scheduling/publishing) | **Gated** — `highRisk: true` already, real today | MVP — **most mature capability, SHIPPED** | Only Marketing capability needing nothing beyond documentation |
| 4 | SEO | Autonomous, advisory-only | MVP | **No real execution connector — honest N/A**, not simulated |
| 5 | Email Marketing | **Recommend gating** any >1-recipient loop | MVP, limited | No suppression/unsubscribe list — a real CAN-SPAM/GDPR gap at volume; not production-ready bulk email |
| 6 | Lead Generation | Autonomous | MVP | Composition of existing `hubspot`/`gmail` skills |
| 7 | Analytics | Autonomous | MVP | Wiring NEW; table exists |
| 8 | Performance Tracking | Autonomous | MVP | |
| 9 | Brand Management | **Gated** — org-wide blast radius | MVP | |
| 10 | Paid Ads | N/A — brief-only | MVP (advisory only) | **No Google/Meta Ads connector exists in Orlixa's own product catalog** — the Google Ads/Meta Ads MCP tools visible in a coding session are unrelated Claude-Code tooling, not an Orlixa product connector, and must never be conflated with one in customer-facing material |

### KPIs
Campaigns launched on schedule %, brief approval turnaround, content pieces produced/week, posts published on schedule %, engagement rate, recommendations delivered/adopted (weak proxy — no real traffic data), emails sent (open-rate not trackable without a real ESP), leads captured/week, snapshot freshness, campaign goal attainment %, brand-guideline adherence (full mapping: doc 03 §3.2.2).

### What it may and may not do autonomously
- **Deliberately NOT in `HIGH_STAKES_ROLES`.** Marketing's risk is action-specific (publishing), not blanket — the existing `highRisk` flag on `postiz.schedule_post`/`publish_now` is the correct, narrower gate (doc 03 §3.2.3). Requiring manager sign-off on "what's our brand voice?" would be unwarranted friction.
- **Every publish already routes through the Approval Center with zero new work** — this is the one Marketing capability that is genuinely production-shaped today.
- **A real multi-tenant fairness risk exists:** Postiz's rate limit is instance-wide (90–100 requests/hour), not per-tenant. One company's bulk campaign import can exhaust the shared budget for every other tenant unless routed through Orlixa's own per-connector rate limiter (Edge Case, §18).

---

## 10. Functional Requirements

Numbering: `FR-<epic>xx`. Priority: P0 (ship-blocking for MVP), P1 (required for enterprise sales), P2 (valuable, not blocking).

### Epic 100 — Employee model foundation (traces to doc 03 §3.0, §3.1, §3.2; Wave W5)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-101 | The system SHALL add `MARKETING` as a real value of the `EmployeeRole` Prisma enum, in the same migration as the `ReasoningStrategy` enum. | **P0** | doc 00 §0.7.1 canonical enum; doc 03 §3.0.5 (closes G10) |
| FR-102 | The system SHALL widen `ROLE_SCOPE.HR` to the full 13-capability scope and add `ROLE_SCOPE.MARKETING`, landing in the same change as FR-101. | P0 | doc 03 §3.1.3, §3.3 migration checklist step 2 |
| FR-103 | The system SHALL correct the two hardcoded "CV screening is RECRUITER work" guardrail strings (`agent-runtime.service.ts`, `planner.service.ts`) in the same change as FR-102, replacing with a marketing-work clause. | P0 | doc 03 §3.0.10 point 3, G18 |
| FR-104 | The system SHALL update every strict zod role enum (`createEmployeeSchema`, `completeOnboardingSchema`) and the onboarding `Department` business-function tag to accept `MARKETING`, landing together with FR-101 (not piecemeal). | P0 | doc 03 §3.0.10 point 4, F6 |
| FR-105 | The system SHALL introduce a `StaffMember` model (with `LeaveRequest`, `AttendanceRecord`, `PerformanceReview`, `DocumentVerificationRecord` satellites) as the HR system of record for the customer's human workforce, distinct from `User` (platform logins) and `AiEmployee` (digital workers). | P0 | doc 03 §3.1.5 (closes F4) |
| FR-106 | The system SHALL wire the existing-but-orphaned `Campaign`, `MediaAsset`, `BrandAsset`, `MarketingAnalyticsSnapshot` tables to real services/controllers rather than redesigning them. | P0 | doc 03 §3.2.3, §3.2.9 (closes F5) |
| FR-107 | The system SHALL add a new `hr_records` internal skill (no OAuth, company-internal) backing HR capabilities 4–13. | P0 | doc 03 §3.1.3, §3.1.6 |
| FR-108 | The system SHALL extend the `postiz` skill with six new tools (`create_campaign`, `list_campaigns`, `register_media_asset`, `get_brand_profile`, `update_brand_asset`, `get_account_insights`). | P0 | doc 03 §3.2.6 |
| FR-109 | The system SHALL implement the `AI_EMPLOYEE_STEP` node type as the full PLAN→RETRIEVE→MEMORY→ACT→VALIDATE employee pipeline (via `AgentRuntimeService.runForTurn`), not a bare completion, so a workflow step genuinely means "this Employee did the work." | P0 | doc 03 §3.0.3, doc 02 (node contract) |
| FR-110 | The system SHALL make `AiEmployee.llmConfig`, `.executionLimits`, `.budgetConfig`, `.promptStrategy`, `.observability`, and `.reasoningStrategy` real, enforced fields rather than decorative JSON, per the typed interfaces in doc 03 §3.0.7. | P1 | doc 03 §3.0.2 (closes F1–F3 cosmetic-config class of bug) |

### Epic 200 — Workflow versioning & lifecycle (traces to doc 01; Wave W1)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-201 | The system SHALL split `Workflow` into a stable container (identity/metadata/pointers) and immutable `WorkflowVersion` rows; every `WorkflowRun` SHALL pin the exact `workflowVersionId` it executes. | P0 | doc 01 §1.A (ADR-002); closes G1 |
| FR-202 | The system SHALL prevent any mutation of a `PUBLISHED`/`DEPRECATED`/`ARCHIVED` `WorkflowVersion.definition`, enforced by both a service-layer guard and a database trigger. | P0 | doc 01 §1.C.5 |
| FR-203 | The system SHALL support rollback to any prior `PUBLISHED`/`DEPRECATED` version as an O(1) pointer swap that never mutates or migrates in-flight runs. | P0 | doc 01 §1.D |
| FR-204 | `DELETE /workflows/:id` SHALL perform a soft delete (`status=ARCHIVED`) and SHALL NOT cascade-delete `WorkflowRun`/`WorkflowStepRun` history. Hard delete SHALL be blocked while any run is `PENDING`/`RUNNING`/`WAITING`. | **P0 — ship-blocking, Wave W1 priority ahead of new capability** | doc 01 §1.A.6, §1.C.6 (closes G29) |
| FR-205 | The system SHALL provide a code-defined, boot-validated starter template catalogue covering all 13 HR and 10 Marketing capability templates (doc 01 §1.E), instantiable per company with tenant-specific ids/secrets scrubbed. | P0 | doc 01 §1.E |
| FR-206 | The system SHALL support structural validation at save time (cycle detection, trigger presence, per-node config validation, branch completeness, resource existence), replacing the current 32-line duplicate/dangling-edge-only validator. | P0 | doc 01 §1.C.5 (closes G14) |
| FR-207 | The system SHALL support workflow categorisation (`WorkflowCategory`), tags, ownership, and department attribution with full-text search. | P1 | doc 01 §1.B |

### Epic 300 — Node architecture & execution engine (traces to doc 02, doc 05; Waves W2–W4)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-301 | The system SHALL replace the engine's `switch(node.type)` with a `NodeRegistry` of typed `NodeDefinition` objects (schema, validate, execute, retry policy, permissions) — one definition read by validator, executor, permission check, and UI node library. | P0 | doc 00 ADR-003; doc 02 §2.A |
| FR-302 | The system SHALL preserve all 8 existing node types with identical `config` shape and runtime semantics; existing `Workflow.definition` JSON SHALL keep validating and running unchanged. | P0 | doc 00 ADR-004; doc 02 §2.B |
| FR-303 | The system SHALL restructure execution from "one job runs the whole graph" to "one job advances one node-attempt, all state in Postgres," via `RunCoordinator`/`StepDispatcher`/`NodeAttemptProcessor`. | P0 | doc 00 ADR-001; doc 05 §5.A |
| FR-304 | The system SHALL support durable waits accurate to the target in §11 (NFR-503), for durations from minutes to months, surviving worker restarts. | P0 | doc 05 §5.D (closes G2) |
| FR-305 | The system SHALL support fan-out/fan-in via `PARALLEL`/`JOIN` node types with atomic barrier accounting. | P0 | doc 05 §5.B (closes G3) |
| FR-306 | The system SHALL support per-node retry with configurable backoff (`NONE`/`FIXED`/`LINEAR`/`EXPONENTIAL`) and transient-vs-terminal failure classification, so one connector's transient 429 does not fail an entire run. | P0 | doc 05 §5.C (closes G4) |
| FR-307 | The system SHALL reclaim an orphaned node-attempt (worker crash/restart) via a lease + reaper mechanism within the target in NFR-508, without retrying already-executed side effects. | P0 | doc 05 §5.A, §5.D (closes G5) |
| FR-308 | The system SHALL support optional saga-style compensation (`CompensationSpec` per node) so a later step's failure can undo completed side effects when configured. | P1 | doc 05 §5.D (closes G6) |
| FR-309 | The system SHALL replace the current `NOTIFY` log-only stub with real channel dispatch (email/Slack/etc.). | P0 | doc 02 (closes G7) |
| FR-310 | The system SHALL replace the blunt `MAX_WORKFLOW_NODES = 50` runtime cap with a per-workflow `settings.maxSteps` budget plus save-time cycle detection. | P1 | doc 05 (closes G16) |
| FR-311 | The system SHALL support `SUB_WORKFLOW` node type for reusable building blocks, using the same authorization subject as the calling run (no permission-laundering across workflows). | P1 | doc 02 §2.C; doc 09 §9.C.10 |
| FR-312 | The system SHALL ship the state-machine execution path behind a per-tenant `WORKFLOW_ENGINE_MODE` flag (`legacy_walk \| state_machine`), with the existing walk as instant fallback, and run both against the same e2e suite before migrating any tenant. | P0 | doc 00 §0.10 Wave W3 |

### Epic 400 — Connectors & Skills (traces to doc 04; Wave W8, with select P0 items pulled forward)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-401 | The system SHALL enforce the `canSend`/`canRead`/`dailyEmailLimit`/business-hours config fields that are today collected but never checked by `RealSkillExecutor`. | P1 | doc 04 §4.0.4 (closes G28) |
| FR-402 | The system SHALL expose a read API for `SkillExecution` (the tool-call audit log), which today has zero read endpoints anywhere in the codebase. | P1 | doc 04 §4.0.4 (closes G27) |
| FR-403 | The system SHALL wire Plane's already-implemented, unit-tested webhook signature verification to an actual controller (currently reachable by no route). | P2 (Plane is outside MVP's two-employee scope but shares the connector framework) | doc 04 §4.0.4 (closes G26) |
| FR-404 | The system SHALL add PKCE to the OAuth authorization-code flow. | P1 | doc 04 §4.0.4 |
| FR-405 | The system SHALL isolate Postiz's shared, instance-wide rate limit per tenant at Orlixa's own connector-level rate limiter, so one company's bulk campaign cannot exhaust the budget for every other tenant. | **P0 for Marketing MVP** | doc 03 §3.2.10/§3.2.13; doc 00 §0.8 "blast radius of one bad tenant" target |

### Epic 500 — Variables, secrets & knowledge (traces to doc 06, doc 07; Wave W4/W5)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-501 | The system SHALL support typed variable scopes (`INPUT`/`RUNTIME`/`WORKFLOW`/`GLOBAL`/`ENVIRONMENT`/`SECRET`/`OUTPUT`) replacing the untyped `Record<string, unknown>` context. | P1 | doc 06 §6.1 (closes G13) |
| FR-502 | The system SHALL land a secret redaction boundary (never persist a resolved secret value into `WorkflowStepRun.output`) **before** any feature that lets a template resolve a secret into `args`. | **P0 — must land before, not after, secret-in-template support** | doc 06 §6.2 (pre-empts G24 landmine) |
| FR-503 | Knowledge retrieval inside a workflow (`RETRIEVE` node) SHALL be role-scoped identically to chat retrieval, so an HR Employee's workflow step cannot retrieve Marketing-only documents. | P0 | doc 07 §7.1 |
| FR-504 | The system SHALL add explicit `MEMORY_READ`/`MEMORY_WRITE` node types so workflow-driven memory is inspectable, not only implicit. | P1 | doc 07 §7.2 (closes G15) |

### Epic 600 — Approvals (traces to doc 08; Wave W0 partial, W6 full)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-601 | **Every `TOOL_ACTION`/`AI_EMPLOYEE_STEP` call from a workflow SHALL pass through the same approval-requirement check the chat path already enforces** (`ApprovalService.requiresApproval`), before this PRD's other approval features ship. | **P0 — Wave W0, ship ahead of all new capability** | doc 00 §0.3.2 G25, §0.10 Wave W0 |
| FR-602 | The system SHALL support `ApprovalRoutingConfig` on an `APPROVAL` node or an employee's `approvalRules`: `USER`/`ROLE`/`DEPARTMENT`/`TEAM`/`EMPLOYEE_MANAGER`/`ANY_ADMIN` rule types, resolved via a dependency-light `ApprovalRoutingModule`. | P1 | doc 08 §8.1 |
| FR-603 | The system SHALL support multi-level sequential approval chains (department head → any admin, etc.), modeled as multiple `ApprovalRequest` rows sharing one `chainId`. | P1 | doc 08 §8.1.3 |
| FR-604 | The system SHALL support per-level SLA (`dueAt`), escalation chains, and a configurable timeout policy (`ESCALATE`/`AUTO_APPROVE`/`AUTO_REJECT`/`NONE`), via a self-sufficient cross-tenant sweep independent of Phase 5's durable-wait timer. | P1 | doc 08 §8.2 |
| FR-605 | The system SHALL replace the blanket `@Roles('OWNER','ADMIN')` decide-time guard with a per-request `canDecide` check, preserving byte-identical behaviour for every unrouted (legacy) request as a mandatory regression test. | P1 | doc 08 §8.1.11 |
| FR-606 | The system SHALL expose `GET /approvals/:id/history` returning the complete decision trail (every level, every escalation hop) for one logical approval chain. | P1 | doc 08 §8.3 |
| FR-607 | `DEPARTMENT`/`TEAM`/`EMPLOYEE_MANAGER` routing SHALL NOT be enabled until `User.departmentId`/`.teamId`/`.managerUserId` and `AiEmployee.managerUserId` exist as real FK columns (prerequisite migration). | P1 | doc 08 §8.0.4 |

### Epic 700 — Permissions (traces to doc 09; Wave W6)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-701 | The system SHALL provide a single `AuthorizationService.can(ctx, action, resource)` Policy Decision Point, called from every enforcement point (HTTP guards and the node-attempt processor) — no re-implementation of decision logic per call site. | P1 | doc 09 §9.A |
| FR-702 | The system SHALL support department/team-scoped roles (`RoleScopeAssignment`) additive to the existing company-wide `User.role`, provably back-compatible (a company with zero scoped-role rows behaves byte-for-byte as today). | P1 | doc 09 §9.B (closes half of G9) |
| FR-703 | The system SHALL support per-workflow permission grants (`WorkflowPermission`) at USER/ROLE/DEPARTMENT/TEAM/EMPLOYEE subject granularity. | P1 | doc 09 §9.C |
| FR-704 | The system SHALL enforce `EmployeeSkill` grants at the actual tool-execution chokepoint (`SkillsService.runTool`), not only at the chat tool-list-building step — closing the gap where a workflow `TOOL_ACTION` can call any company-installed skill for any employee regardless of assignment. | **P0** | doc 09 §9.D (closes gap (c)) — staged rollout via `SecurityPolicy.skillGrantEnforcement` (`off`/`audit`/`enforce`), defaulting existing companies to `audit` |
| FR-705 | Every `NodeType` SHALL declare a `requiredPermission`, checked at both save time (advisory) and every node-attempt (the actual security boundary). | P1 | doc 09 §9.C.11 |
| FR-706 | The system SHALL define `RunFailureClass.AUTHORIZATION_DENIED` so a permission/grant denial is distinguishable from a generic node error in analytics. | P1 | doc 09 §9.F; promotes into doc 00 §0.7.1 |

### Epic 800 — Audit, retention & cost attribution (traces to doc 10; Wave W7)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-801 | The system SHALL attribute cost/tokens per `WorkflowStepRun` attempt (not only in the separate `UsageEvent` stream), so cost is joinable per step. | P1 | doc 10 §10.C (closes G11) |
| FR-802 | The system SHALL write every state transition and side effect through a transactional outbox to guarantee audit completeness. | P1 | doc 10 §10.B |
| FR-803 | The system SHALL partition high-volume execution tables monthly and enforce the retention policy in NFR-505 (90d hot / 400d cold, tenant-configurable). | P1 | doc 10 §10.F; doc 12 |
| FR-804 | The system SHALL apply tamper-evidence to audit rows (append-only, checksum-linked). | P2 | doc 10 §10.E |

### Epic 900 — Analytics (traces to doc 11)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-901 | The system SHALL report per-employee KPI attainment against `AiEmployee.kpiTargets`, per the capability-KPI mapping in doc 03 §3.1.2/§3.2.2. | P1 | doc 11 §11.F |
| FR-902 | The system SHALL report per-employee monthly cost against `budgetLimit`/`BudgetConfig.monthlyUsdCap`, with an alert at `alertThresholdRatio`. | P1 | doc 11 §11.E |
| FR-903 | The system SHALL report workflow/node failure analytics (failure class distribution, top failing node types). | P2 | doc 11 §11.D |

### Epic 1000 — Frontend / canvas (traces to doc 15; Wave W9, deliberately last)

| ID | Requirement | Priority | Traceability |
|---|---|---|---|
| FR-1001 | The system SHALL provide a visual node-based canvas (React Flow + dagre) replacing the current linear step-list editor, reading the same `NodeDefinitionDto[]` registry the backend validator uses. | P1 | doc 15 §15.C; already-approved canvas design (`docs/superpowers/specs/2026-07-27-visual-workflow-builder-design.md`) |
| FR-1002 | The Inspector SHALL be a generic form renderer driven by `NodeConfigField[]`, not hand-written per-node-type blocks, so a new `NodeType` requires zero frontend code change. | P1 | doc 15 §15.D (Decision A) |
| FR-1003 | The system SHALL provide an Execution Timeline showing live per-node run status, both as a drawer and as an overlay on canvas nodes. | P1 | doc 15 §15.E |
| FR-1004 | Every drag-only canvas interaction (move, connect, delete) SHALL have a non-drag equivalent for accessibility. | P2 | doc 15 §15.0.5 Decision D |

---

## 11. Non-Functional Requirements

All numbers below are the architecture's own stated targets (doc 00 §0.8) — none invented for this PRD.

| ID | Requirement | Target | Measured at |
|---|---|---|---|
| NFR-501 | Sustained throughput | ≥ 10,000,000 node-attempts/day, via horizontal node workers and per-tenant fair-share queues | Load test against `wf-node-attempt` queue depth/drain rate |
| NFR-502 | Run start latency | p95 < 2 seconds from trigger fired to first node entering `RUNNING` | Timestamp delta, trigger event → first `WorkflowStepRun.status=RUNNING` |
| NFR-503 | Node attempt engine overhead | p95 < 50 ms of engine overhead, excluding the node's own work (LLM call, tool call, etc.) | `NodeAttemptProcessor` entry-to-dispatch timestamp delta, node execution time subtracted |
| NFR-504 | Durable wait accuracy | ± 30 seconds at any duration from minutes to months | `WorkflowRunTimer` fire time vs. configured due time, sampled across the full duration range |
| NFR-505 | Run history retention | 90 days hot storage, 400 days cold storage, then purge — tenant-configurable | Monthly partition age at query time; archive-job completion logs |
| NFR-506 | Tenant isolation | No cross-tenant read possible, at the application layer for all 38+ tables, reinforced by Postgres RLS on the new high-volume execution tables | Automated cross-tenant fuzz test suite; RLS policy presence check on `WorkflowRun`/`WorkflowStepRun` |
| NFR-507 | Audit completeness | 100% of state transitions and every side effect recorded, via transactional outbox | Reconciliation job comparing `WorkflowStepRun` transitions to `AuditEvent` rows — zero gap tolerance |
| NFR-508 | Recovery from worker loss | < 60 seconds to reclaim an orphaned node-attempt | Chaos test: kill a worker mid-attempt, measure time to `RunReaper` reclaim |
| NFR-509 | Blast radius of one bad tenant | Zero measurable latency/throughput impact on other tenants from one tenant's misbehaving workflow | Per-tenant concurrency cap + circuit breaker test: saturate one tenant's queue, measure others' p95 unaffected |
| NFR-510 | Approval SLA sweep accuracy | Escalation/timeout fires within its own sweep interval (5 minutes) of the configured `dueAt`, not sub-second — stated honestly as a safety-net guarantee, not a real-time one | Sweep interval configuration + breach-to-action timestamp delta |
| NFR-511 | Definition size / node count ceiling | Reject any `WorkflowVersion.definition` over 1 MB or exceeding `settings.maxSteps` (default ceiling 500) | Save-time validation rejection test |
| NFR-512 | Multi-tenant Postiz fairness | Orlixa's own per-connector rate limiter enforces per-tenant fair share against Postiz's shared 90–100 req/hour instance-wide limit | Rate-limiter test: one tenant's burst does not starve another tenant's scheduled publish within the same window |

---

## 12. Acceptance Criteria (Given/When/Then)

**AC-FR-101 (MARKETING enum)**
- Given a company on any plan, When an admin creates a new AI Employee with `role: "MARKETING"`, Then the API accepts it without falling back to `CUSTOM`, and the resulting employee's knowledge retrieval scopes to `category: 'MARKETING'`, not the shared `CUSTOM` bucket.

**AC-FR-204 (soft delete)**
- Given a workflow with 50 completed `WorkflowRun` rows, When an admin calls `DELETE /workflows/:id`, Then the workflow's `status` becomes `ARCHIVED`, `archivedAt` is set, and all 50 runs and their step rows remain queryable via `GET /workflows/:id/runs` (or an equivalent archived-workflow run-history endpoint).
- Given a workflow with a `RUNNING` run, When an admin calls `DELETE /workflows/:id`, Then the API returns 409 and the workflow is not archived.

**AC-FR-601 (approval bypass closed)**
- Given an employee with `approvalRules.requireApprovalForAllTools = true`, When a workflow's `TOOL_ACTION` node calls any tool for that employee, Then a `PENDING` `ApprovalRequest` is created and the tool does NOT execute until approved — identical behaviour to the same call made from chat.
- Given a tool flagged `highRisk: true` in the catalog, When called from a `TOOL_ACTION` node with no explicit `autoApprove`, Then execution pauses for approval exactly as it would from chat.

**AC-FR-304 (durable wait)**
- Given a `WAIT` node configured for 72 hours, When the run reaches that node, Then the run transitions to `WAITING`, the process may restart or redeploy during the wait, and the run resumes automatically within ±30 seconds of the 72-hour mark without re-executing any already-completed step.

**AC-FR-306 (per-node retry)**
- Given a `TOOL_ACTION` node configured with `retry: {maxAttempts: 3, backoff: 'EXPONENTIAL'}`, When the underlying connector returns a transient 429 on the first two attempts and succeeds on the third, Then the run completes successfully and the step's final `WorkflowStepRun` reflects 3 attempts, not a failed run.

**AC-FR-405 (Postiz fairness)**
- Given Tenant A schedules 40 posts in one bulk campaign import, When Tenant B (a different company) schedules a single post in the same hour, Then Tenant B's post is not delayed or rejected due to Tenant A's bulk import exhausting the shared Postiz rate limit.

**AC-FR-704 (skill-grant enforcement)**
- Given `SecurityPolicy.skillGrantEnforcement = 'enforce'` and an employee with no `EmployeeSkill` grant for `hubspot`, When a workflow `TOOL_ACTION` node attempts to call `hubspot.create_deal` for that employee, Then the call returns `{ok: false, error: "Employee is not granted the \"hubspot\" skill"}` and no HubSpot API call is made.
- Given the same setup with `skillGrantEnforcement = 'audit'`, When the same call is made, Then the call executes (unchanged) and a denial is logged for later review.

**AC-FR-602/603 (approval routing)**
- Given an `APPROVAL` node configured with `routing.levels: [{rule: 'DEPARTMENT', target: 'dep_finance'}, {rule: 'ANY_ADMIN'}]`, When the node is reached, Then a `PENDING` `ApprovalRequest` is created with `approverRuleType: 'DEPARTMENT'`, and only a user whose `departmentId` matches can decide it; upon approval, a second `PENDING` row is created for `ANY_ADMIN`.

**AC-NFR-502 (run-start latency)**
- Given a `MANUAL` trigger fired via `POST /workflows/:id/run` under normal load, When measured across 1,000 consecutive runs, Then the 95th-percentile time from request receipt to the first node's `WorkflowStepRun.status = RUNNING` is under 2 seconds.

---

## 13. User Stories

Story points are relative (Fibonacci-like: 1, 2, 3, 5, 8, 13).

| ID | Story | Points | Acceptance criteria ref |
|---|---|---|---|
| US-1 | As an **HR Manager**, I want to hire an HR Employee and see it screen inbound CVs against our hiring policy, so that I stop manually reading every resume. | 8 | AC tied to FR-107, FR-205 (`hr.recruitment.resume_screening` template) |
| US-2 | As a **Marketing Manager**, I want the Marketing Employee to draft on-brand social posts and only publish after I approve them, so that nothing goes out under our name without a human check. | 5 | AC-FR-601 |
| US-3 | As a **Company Owner**, I want my "require approval for all tools" setting to hold no matter whether the action came from chat or a workflow, so that I can trust the control I configured. | 8 | AC-FR-601 |
| US-4 | As an **IT/Security Reviewer**, I want a straight answer on whether tenant isolation is enforced by the database or only by application code, so that I can accurately represent the risk to my security committee. | 3 | §19 Enterprise Constraints |
| US-5 | As an **HR Manager**, I want a staff member's leave request to route to their actual manager for approval, not just "any company admin," so that the right person decides. | 8 | AC-FR-602/603, requires FR-607 prerequisite |
| US-6 | As a **Company Admin**, I want to delete an old, unused workflow without losing the history of decisions it made, so that I can still answer "what happened in Q1" during an audit. | 5 | AC-FR-204 |
| US-7 | As a **Marketing Manager**, I want a campaign that schedules 20 posts at once to not get throttled by another customer's activity on the shared publishing engine. | 5 | AC-FR-405 |
| US-8 | As an **HR Employee (digital)**, when I am asked to screen a CV, I want my own system prompt to reflect that this is legitimately my job, so that I don't self-refuse the work I was hired for. | 3 | FR-103, G18 |
| US-9 | As a **Department Head**, I want to approve requests routed specifically to my department without needing company-wide ADMIN rights, so that I'm not over-privileged just to do my job. | 8 | FR-702, FR-602 |
| US-10 | As an **Individual Contributor**, I want to submit a leave request through chat and see its status update as it's routed and decided, so that I don't have to email HR to check. | 5 | doc 03 §3.1.4 diagram 2 |
| US-11 | As a **Workflow Author**, I want to see a validation error at save time if I reference a skill my company hasn't installed, so that I catch the mistake before publishing, not after a run fails in production. | 3 | FR-206 |
| US-12 | As a **Marketing Manager**, I want a weekly performance snapshot comparing results against my campaign's stated goal, so that I know whether the campaign is working without pulling numbers myself. | 5 | FR-106, doc 03 §3.2.2 capability 8 |

---

## 14. Epics

| Epic | Scope | Exit criteria | Wave (doc 00 §0.10) |
|---|---|---|---|
| **E0 — Close G25 (approval bypass)** | Route high-risk `TOOL_ACTION`/`AI_EMPLOYEE_STEP` calls through the same approval gate the chat path already has | Zero unauthorized high-risk executions in a full regression suite covering both chat and workflow paths | **W0** — ships before any new capability |
| **E1 — Workflow versioning** | `WorkflowVersion`, publish/rollback, soft-delete (G29 fix), backfill of existing `Workflow.definition` | Every existing live workflow has a v1 `WorkflowVersion`; `DELETE` never destroys run history | **W1** |
| **E2 — NodeRegistry** | Port the existing 8 node types unchanged into the new registry | Existing e2e suite passes byte-for-byte, zero behaviour change | **W2** |
| **E3 — Durable state machine** | `RunCoordinator`/`StepDispatcher`/`NodeAttemptProcessor`, durable waits, per-node retry, fan-out/fan-in, worker-loss recovery | Ships behind `WORKFLOW_ENGINE_MODE` flag; both modes pass the same e2e suite; live tenant migrated deliberately, not by default | **W3** — highest-risk wave |
| **E4 — Variables & new logic nodes** | Typed variable scopes, `SWITCH`/`PARALLEL`/`JOIN`/`SUB_WORKFLOW`/`LOOP` | New node types pass save-time validation and execute correctly against the state machine | **W4** |
| **E5 — HR & Marketing Employees** | `MARKETING` role, `StaffMember` roster, `hr_records` skill, Postiz wiring, `AI_EMPLOYEE_STEP`, all 23 starter templates | All 13 HR + 10 Marketing capabilities have a working template exercising real skills, no mocked "success" | **W5** |
| **E6 — Approval routing & permissions** | Routed/escalating approvals, department-scoped RBAC, execution-time skill-grant enforcement | Two enterprise-sales blockers closed; regression test proves unrouted requests behave identically to today | **W6** |
| **E7 — Audit & analytics** | Per-attempt cost attribution, transactional outbox, partitioning/retention, KPI/cost dashboards | Audit completeness = 100% against NFR-507; retention policy enforced per tenant | **W7** |
| **E8 — Connector hardening & realtime API** | PKCE, rate-limiter fairness, `SkillExecution` read API, Plane webhook wiring, WebSocket gateway | All P0/P1 items in Epic 400 shipped; realtime channel delivers run/step events per doc 13 | **W8** |
| **E9 — Visual canvas** | React Flow canvas, generic Inspector, Execution Timeline | Feature-flagged rollout; old linear editor remains available until canvas reaches parity | **W9** — deliberately last |

---

## 15. Feature Breakdown

Status legend: **SHIPPED** (in production today), **IN PROGRESS** (partially wired, verified gaps remain), **PROPOSED** (designed, zero or near-zero code exists).

| Feature | Epic | FRs | Architecture phase | Status | Wave |
|---|---|---|---|---|---|
| Workflow graph CRUD + JSON storage | E1 | FR-201 | doc 01 §1.A | SHIPPED (pre-versioning shape) | — |
| Sequential graph execution (8 node types) | E2 | FR-302 | doc 02 §2.B | SHIPPED | — |
| Approval pause/resume (chat path) | E0 | FR-601 | doc 08 (existing mechanism) | SHIPPED | — |
| Approval pause/resume (workflow `APPROVAL` node) | E1 | — | doc 01 | SHIPPED | — |
| **Approval gate on workflow `TOOL_ACTION`/`AI_EMPLOYEE_STEP`** | E0 | FR-601 | doc 00 §0.3.2 G25 | **PROPOSED — P0 gap, not built** | W0 |
| Optimistic concurrency on workflow save | E1 | — | doc 01 §1.A.10 | SHIPPED | — |
| Stuck-run watchdog (fails, never retries) | E3 | — | doc 05 | SHIPPED | — |
| Idempotent run claim | E1 | — | doc 01 | SHIPPED | — |
| Subscription gating on execution | E1 | — | doc 01 | SHIPPED | — |
| Per-employee budget enforcement (flat `budgetLimit`) | E5 | — | doc 03 §3.0.2 | SHIPPED | — |
| Connector quarantine (degraded/disconnected) | E8 | — | doc 04 | SHIPPED | — |
| Dry-run/test mode | E3 | — | doc 01 | SHIPPED | — |
| AI-drafted workflows (plan-gated) | E5 | — | doc 00 §0.3.1 | SHIPPED | — |
| Postiz publishing (schedule/publish/status) | E5 | — | doc 03 §3.2.3 | SHIPPED | — |
| Chatwoot support inbox integration | (outside MVP 2-employee scope) | — | doc 04 §4.7 | SHIPPED | — |
| Plane PM integration | (outside MVP scope) | — | doc 04 §4.7 | SHIPPED | — |
| Workflow versioning (`WorkflowVersion`, publish/rollback) | E1 | FR-201–FR-203 | doc 01 §1.A–§1.D | **PROPOSED** | W1 |
| Soft-delete workflows (fix G29) | E1 | FR-204 | doc 01 §1.A.6 | **PROPOSED — P0** | W1 |
| `NodeRegistry` | E2 | FR-301 | doc 02 §2.A | **PROPOSED** | W2 |
| Durable waits (>10s) | E3 | FR-304 | doc 05 §5.D | **PROPOSED** | W3 |
| Parallel/Join fan-out | E3 | FR-305 | doc 05 §5.B | **PROPOSED** | W3 |
| Per-node retry | E3 | FR-306 | doc 05 §5.C | **PROPOSED** | W3 |
| Real `NOTIFY` dispatch | E3 | FR-309 | doc 02 | **PROPOSED** | W3/W2 |
| `MARKETING` employee role | E5 | FR-101 | doc 03 §3.0.5 | **PROPOSED — P0** | W5 |
| `StaffMember` roster + satellites | E5 | FR-105 | doc 03 §3.1.5 | **PROPOSED — P0** | W5 |
| `hr_records` skill | E5 | FR-107 | doc 03 §3.1.6 | **PROPOSED** | W5 |
| Campaign/BrandAsset/MediaAsset wiring | E5 | FR-106 | doc 03 §3.2 | **PROPOSED** | W5 |
| `AI_EMPLOYEE_STEP` node | E5 | FR-109 | doc 03 §3.0.3 | **PROPOSED** | W5 (or interim as a switch case ahead of W2) |
| 13 HR + 10 Marketing starter templates | E5 | FR-205 | doc 03 §3.1/§3.2 | **PROPOSED** | W5 |
| Approval routing/multi-level/SLA/escalation | E6 | FR-602–FR-606 | doc 08 | **PROPOSED** | W6 |
| Department/team-scoped RBAC | E6 | FR-702, FR-703 | doc 09 §9.B/§9.C | **PROPOSED** | W6 |
| Execution-time skill-grant enforcement | E6 | FR-704 | doc 09 §9.D | **PROPOSED — P0** | W6 (staged audit→enforce rollout) |
| Per-attempt cost/token attribution | E7 | FR-801 | doc 10 §10.C | **PROPOSED** | W7 |
| Partitioning + retention enforcement | E7 | FR-803 | doc 10 §10.F, doc 12 | **PROPOSED** | W7 |
| `SkillExecution` read API | E8 | FR-402 | doc 04 §4.0.4 | **PROPOSED** | W8 |
| OAuth PKCE | E8 | FR-404 | doc 04 §4.2.9 | **PROPOSED** | W8 |
| WebSocket realtime gateway | E8 | — | doc 13 §13.C/§13.D | **PROPOSED** — noted internally as under-specified (see §17 risk on doc drift) | W8 |
| Visual node canvas | E9 | FR-1001–FR-1004 | doc 15 | **PROPOSED** | W9 |

---

## 16. Dependencies

### Internal (between epics/waves)
- E1 (versioning) must land before E3 (state machine), because the state machine pins `workflowVersionId` at run creation.
- E2 (NodeRegistry) must land before E4 (new logic nodes) and before E5's `AI_EMPLOYEE_STEP` reaches its final home (an interim switch-case wiring is acceptable ahead of E2, per doc 03 §3.3 step 7).
- E6's `DEPARTMENT`/`TEAM`/`EMPLOYEE_MANAGER` approval routing (FR-602) is **hard-blocked** on the `User.departmentId`/`.teamId`/`.managerUserId` and `AiEmployee.managerUserId` schema migration (FR-607) — these routing rule types are unimplementable without it.
- E7 (audit/cost attribution) depends on E3's attempt-level data existing to be worth reporting on.
- E9 (canvas) depends on the node-library, validation-message, and timeline contracts defined by E1–E7 — it is scheduled last deliberately, not by accident.
- E0 (G25 fix) is independent of every other wave and should not be delayed by any of them.

### External
- **LLM providers** — OpenAI/Anthropic (swappable per doc 00 §0.5; per-employee model routing is designed but not yet enforced, F1). A provider outage directly stalls every `AI_STEP`/`AI_EMPLOYEE_STEP` node; no fallback provider is currently configured.
- **Connectors** — Gmail, Google Calendar/Drive, Slack, HubSpot, Jira, GitHub, Stripe, HTTP (generic), and the AI Workforce Engines Postiz/Chatwoot/Plane. Of the 14 cataloged skills, real tool execution exists for `slack`, `gmail` (partial), `calendar`, `gdrive`, `scheduling`, `http`, `postiz`, `chatwoot`, `plane`; `email`, `stripe`, `github`, `hubspot`, `jira` fall through to mock execution today (doc 04 §4.0.3) — a genuine dependency risk if any MVP HR/Marketing template assumes real execution on one of the mocked ones.
- **Hosting** — the execution plane (BullMQ workers) and the WebSocket gateway **require a persistent host; they cannot run on serverless-only infrastructure.** This is already true in production (`QUEUE_WORKERS_ENABLED` gates workers off Vercel's API deployment specifically) and is a **procurement/deployment requirement**, not a footnote: any customer requiring an air-gapped or fully-serverless deployment cannot be served without a dedicated worker host.
- **Managed Postgres (Neon)** — pgvector extension required for knowledge retrieval; connection pooling for serverless is a known, deferred gap (many short-lived Vercel functions hitting Postgres directly has real connection limits, normally solved with PgBouncer or Prisma Accelerate — not yet implemented).
- **Managed Redis (Upstash)** — transport only for the execution engine per ADR-001 (Postgres is the source of truth), which is precisely what makes durability compatible with a remote, potentially-evicting managed Redis.
- **Postiz's own shared rate limit** (90–100 req/hour instance-wide) is an external dependency the Marketing Employee's scheduling/publishing capability cannot exceed regardless of Orlixa's own scaling.

---

## 17. Risk Analysis

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R-1 | **G25 — high-risk tools bypass the Approval Center when called from a workflow.** A customer's "require approval for all tools" setting is silently defeated by any workflow. Fails an enterprise security review; sold-but-not-enforced control. | High (exists today, verified in code) | **Critical** — trust/legal exposure, security-review failure | FR-601, shipped as Wave W0, ahead of all other new capability | Eng lead, workflow engine |
| R-2 | **G29 — `DELETE /workflows/:id` cascades and permanently destroys all run/step history.** A customer cleaning up an old workflow unknowingly loses the ability to answer "what happened" for an audit. | Medium (requires an explicit delete action, but no warning exists today) | **Critical** — audit/compliance exposure, irreversible data loss | FR-204, soft-delete flip, Wave W1 priority | Eng lead, workflow-core |
| R-3 | **AGPL-3.0 licensing exposure from wrapped engines.** Postiz and Plane are both confirmed AGPL-3.0 (no separate Enterprise Edition for either). Orlixa wraps them as "invisible" backend engines behind a proprietary SaaS. AGPL's network-use clause can require offering corresponding source to users who interact with the modified software over a network — and Orlixa customers *do* interact with Postiz/Plane functionality via API, even though the branding is hidden. This is a genuine, unresolved legal question, not a settled one. | Medium (depends on the specific modifications made and legal interpretation of "interacting over a network" through an intermediary API) | High — potential obligation to release Orlixa's modifications to Postiz/Plane as source, or a forced re-platform | Get explicit legal counsel sign-off on the AGPL network-use exposure before GA; consider isolating any Orlixa-side modifications to these engines behind a clean plugin boundary rather than forking; document the "engines run unmodified, only accessed via public API" posture if that is in fact true and get it verified | Founder/CEO + external counsel |
| R-4 | **LLM cost runaway.** Only the flat `AiEmployee.budgetLimit` is genuinely enforced today; richer `BudgetConfig` (per-run cap, alert threshold) is designed but not yet enforced (F1-class decorative-config risk). A misconfigured or looping `AI_EMPLOYEE_STEP` inside a workflow could run up cost before a human notices. | Medium | Medium-High (direct COGS impact, could exceed a customer's willingness to pay) | FR-110 (enforce `BudgetConfig.perRunUsdCap`), FR-902 (cost alerting), Execution Limits (`maxToolCallsPerDay`, `maxWorkflowRunsPerDay`) as a per-employee blast-radius cap | Eng lead, employees module |
| R-5 | **Prompt injection via retrieved knowledge or inbound connector data.** An HR Employee retrieving a malicious CV, or a Marketing Employee ingesting a poisoned webhook payload, could have its `AI_EMPLOYEE_STEP` pipeline manipulated into calling a tool it shouldn't. The architecture's `VALIDATE` step and approval gates are a partial mitigation, not a proof against injection. | Medium-High (any RAG/tool-calling system has this exposure; not specifically analyzed in the architecture docs) | High for HR (PII, employment decisions) and Marketing (brand-damaging public posts) | Approval gating on all high-stakes tools (once R-1 is fixed) is the primary backstop; recommend an explicit prompt-injection test suite using known adversarial CV/webhook payloads before GA — **not currently specified in any architecture document, flagged here as a gap the docs do not address** | Security lead |
| R-6 | **Multi-tenant isolation is application-enforced (`companyId` filter in every query), not database-enforced**, except for a planned RLS addition on the two highest-volume execution tables (ADR-005). A single missed `WHERE companyId = ...` in new or refactored code is a cross-tenant data leak. | Medium (38+ tables, all manually filtered; a proven pattern, but not a structural guarantee) | Critical if it occurs — cross-tenant PII/business-data leak | RLS on `WorkflowRun`/`WorkflowStepRun` (ADR-005) is a start, not a full fix; recommend extending RLS coverage to `StaffMember`/`LeaveRequest`/`ApprovalRequest` given their PII sensitivity, and adding an automated cross-tenant fuzz-test suite (NFR-506) to CI | Eng lead, platform/tenancy |
| R-7 | **G18 — HR self-refusal regression.** Widening `ROLE_SCOPE.HR` without fixing the two hardcoded "CV screening is RECRUITER work" strings produces an HR Employee that refuses its own job. | High if FR-102/FR-103 are not landed together | Medium — visible, embarrassing product failure in a customer demo, not a security issue | FR-103 mandated in the same change as FR-102 (§10 Epic 100); add a regression test that asks the HR Employee to screen a CV and asserts it does not refuse | Eng lead, employees/runtime |
| R-8 | **G10 — missing `MARKETING` enum silently degrades a Marketing Employee to `CUSTOM`.** If shipped without FR-101, knowledge retrieval collapses to the shared bucket and per-role analytics cannot isolate Marketing performance — a correctness bug that produces no error, just silently wrong behavior. | High if sequencing is not respected | Medium — undermines BG-3/BG-6 measurement, not visible to the customer until they ask "why does Marketing only see shared docs" | FR-101 as a hard MVP gate; boot-time registry validation (doc 01 §1.E edge case) already fails loudly if a template references `MARKETING` before the enum exists — rely on that as a build-time tripwire | Eng lead, employees module |
| R-9 | **Postiz's instance-wide rate limit creates a noisy-neighbor risk across all Marketing customers**, not just one tenant's own workflows. | Medium-High (rate limit is real and low: 90-100/hour shared across every Orlixa customer using Postiz) | Medium — publish delays/failures for unrelated customers during another customer's bulk campaign | FR-405 (per-tenant fairness at Orlixa's own rate limiter), plus a documented ceiling on template-driven bulk scheduling | Eng lead, marketing engine |
| R-10 | **Documentation drift inside the architecture set itself.** `15-frontend.md` (dated 2026-08-01, same day as this PRD's source material) explicitly states Phase 12 (database), 13 (API), and 14 (JSON contract) "do not exist on disk" — yet this PRD's research confirms all three files exist with full content, also dated 2026-08-01. The architecture set does not cross-reference its own most recent state reliably. | High (already observed) | Medium — a PM or engineer trusting any single phase doc's "current state" section without re-verifying against the live file tree will make decisions on stale information | Treat every phase doc's "verified" claims as time-stamped, not evergreen; re-verify against source before every planning cycle; this PRD's own architecture-doc citations should be spot-checked again before build kickoff given how recently 12/13/14 were apparently added | Eng lead (documentation owner) |
| R-11 | **Execution-time skill-grant enforcement (FR-704) is a behavior change for live production workflows**, not a pure addition — turning on `enforce` mode could break a workflow that today succeeds only because the check doesn't exist (e.g., a company-wide skill install that was never explicitly `assign()`'d to the employee referenced in the workflow). | Medium | Medium — could break real customer automation if rolled out carelessly | Staged rollout already specified in doc 09 §9.D (`off`→`audit`→`enforce`, with a backfill script grandfathering observed `(employeeId, skillKey)` pairs from 90 days of successful executions before `enforce` ever becomes default) — this PRD requires that staged rollout, not a direct flip | Eng lead, skills module |
| R-12 | **`preventSelfApproval` and `AUTO_APPROVE`-on-timeout are both opt-in, defaulting to today's looser behavior.** A customer who assumes "approval" means "a different human decided" may be surprised that self-approval is allowed by default and that an unattended SLA timeout can auto-approve a high-risk action if misconfigured. | Low-Medium | Medium — could weaken the exact safety story the platform is sold on if a customer misconfigures `onTimeout: AUTO_APPROVE` without realizing the implication | Never pre-select `AUTO_APPROVE` in the builder UI (already specified, doc 08 §8.2.15); add an explicit UI warning callout when a customer selects it | Product + Eng, approvals |

---

## 18. Edge Cases (product-level — what the user sees)

| Scenario | What the user sees |
|---|---|
| A workflow author tries to publish a graph with a cycle formed by raw edges (not a `LOOP` node) | `422` with `{code: 'CYCLE_DETECTED', message: "Cycle: n_cond_2 → n_ai_3 → n_cond_2. Use a LOOP node for intentional repetition."}` — a specific, actionable error, not a generic "invalid workflow" |
| An admin tries to activate a workflow with no published version | `409 — "Publish a version before activating this workflow."` |
| A customer instantiates a starter template requiring a skill they haven't installed | Template instantiates anyway as a DRAFT, with a visible "finish setting this up" checklist (connect Gmail, choose which employee runs step 3) rather than a silently broken workflow |
| An HR Manager tries to approve their own leave request (self-approval) | Allowed by default (matches today's behavior); blocked with `403 — "You cannot approve a request you triggered yourself"` only if the company has opted into `preventSelfApproval` |
| A department-scoped approval routes to a department with zero linked users | The request sits `PENDING` with no eligible decider unless an SLA/escalation is configured — this PRD requires every routed level to carry an SLA specifically to prevent an approval waiting forever (doc 08 §8.1.11 best practice) |
| A Marketing Employee is asked to run paid-ad campaigns | The Employee responds that it can produce a brief/recommendation only — it does not claim to have launched an ad campaign, because no execution connector exists; this must be true in the product's actual chat responses, not just in this document |
| A workflow references an employee that gets deleted after publish | The frozen `WorkflowVersion` still references the old employee id; the run fails at that node with a clear "employee not found" error, not a silent skip |
| Two admins edit the same workflow draft simultaneously | The second save gets `409` via the existing optimistic-concurrency check (`expectedUpdatedAt` mismatch) |
| A company disables (offboards) the user who published a still-active, schedule-triggered workflow | Subsequent automated runs of that workflow start failing `AUTHORIZATION_DENIED` at the first node whose permission the disabled user no longer satisfies — a real, surprising operational consequence that this PRD requires be surfaced as an explicit prompt during the offboarding flow ("this user published N active automations — re-publish as another admin before disabling them") |
| A customer asks to see every tool call an AI Employee has ever made | Today: not possible — `SkillExecution` (the tool-call audit log) has no read API anywhere in the product (FR-402 closes this) |
| A high-risk tool call is denied by `EmployeePermissions` (a hard deny) vs. gated by approval (a soft, reviewable gate) | The chat/workflow response is explicit about which happened: a hard deny never creates an approval request and is not something a manager can override by approving; an approval gate is reviewable. These must read differently to the end user, not both as a generic "action blocked" message |

---

## 19. Enterprise Constraints

**Security review posture — stated honestly, not optimistically:**

| Control | Status today | What "enforced" actually means |
|---|---|---|
| SSO | **NOT SUPPORTED.** Sold as a future capability contingent on the Keycloak engine (researched, not built) | No SAML/OIDC login path exists yet |
| Audit logs (queryable) | **PARTIAL.** `AuditLog`/`SkillExecution` are written; `SkillExecution` has **no read API** (FR-402 closes this) | Write path exists; a customer cannot self-serve query the full tool-call history today |
| Data residency | **NOT VERIFIED / not addressed by any architecture document reviewed.** Deployment is Vercel + Neon + Upstash, region unspecified in the docs reviewed for this PRD | Any residency commitment (EU-only data, etc.) is an open question, §21 |
| MFA / session timeout / data-retention policy | **STORED BUT NOT ENFORCED.** `SecurityPolicy` fields exist and are saved from the UI; enforcement of most of them is a known, documented gap (per the 2026-07-27 progress snapshot) | A customer configuring "require MFA" today gets a setting that does nothing |
| Multi-tenant isolation | **Application-enforced** (`companyId` filter on every query, all 38+ tables), reinforced by planned Postgres RLS on the two highest-volume execution tables only | Not a database-level guarantee across the whole schema — see R-6 |
| Approval Center as a sold safety control | **Currently bypassable from workflows (G25)** — must not be represented as fully enforced until FR-601 ships | See R-1 |
| Encryption at rest for connector credentials | `InstalledSkill.credentials` uses an existing encrypted-at-rest pattern (`CryptoService`) | Any future field storing a national ID/bank account (e.g., for real payroll processing) MUST use the same pattern — explicitly required, not optional (doc 03 §3.1.11) |
| SLA (uptime commitment) | **NOT DEFINED in any reviewed document.** No formal SLA exists to quote to an enterprise buyer today | Open question, §21 |
| Persistent-host requirement | **Real, not a footnote.** BullMQ workers and the WebSocket gateway cannot run on serverless-only infrastructure; a customer requiring a fully air-gapped or fully-serverless deployment cannot be served without a dedicated worker host | Must be disclosed during any enterprise deployment-shape conversation |
| Compliance certifications (SOC 2, ISO 27001, HIPAA, etc.) | **NOT ADDRESSED by any architecture document reviewed for this PRD.** No mention found. | Open question, §21 — likely a hard blocker for regulated-industry enterprise deals until pursued |

---

## 20. Future Scope

**Respecting doc 00 §0.9's explicit non-goals — these are NOT planned, and why:**

| Non-goal | Why it stays out |
|---|---|
| Matching n8n's 400+ node catalogue | Orlixa is not a general-purpose iPaaS; breadth comes from the Skills/connector layer, not node count (doc 00 §0.9 #1) |
| User-authored arbitrary code execution (JS/Python nodes) | Sandboxing/RCE surface in a multi-tenant runtime is larger than its v1 value; `TRANSFORM` stays a safe declarative evaluator (doc 00 §0.9 #2) |
| Cross-company workflow sharing beyond the curated template catalogue | Third-party marketplace publishing needs a review pipeline that does not exist; `visibility: PUBLIC` stays platform-curated-only in v1 (doc 00 §0.9 #3; doc 01 §1.E.10) |
| Visual debugger / step-through breakpoints | The Execution Timeline shows what happened; it does not pause a live run at a breakpoint (doc 00 §0.9 #4) |
| Adopting Temporal | Rejected for now (ADR-001) — would require a second stateful cluster (Temporal server + its own Postgres + Elasticsearch) against Orlixa's current footprint; the node-attempt boundary is kept Temporal-compatible as a documented escape hatch, not a near-term plan (doc 00 §0.9 #5) |

**Planned (designed, sequenced beyond MVP, not excluded on principle):**

- Semantic/embedding-based memory recall (today's memory is recency-only) — doc 07 §7.3 sketches the migration cost explicitly.
- Real document-AI (layout-aware PDF/DOCX parsing) for resume screening and document verification — currently an honest limitation (§18).
- A real payroll-provider connector (Gusto/ADP-style) replacing the current `http`/`gmail` hand-off — Payroll Coordination stays coordination-only until then.
- Listmonk-backed bulk email with proper suppression-list handling, replacing the one-at-a-time `gmail`/`email` loop.
- Real SEO connector (Google Search Console / rank-tracking) and real Paid Ads connector (Google Ads/Meta Ads APIs) — both currently advisory-only, honestly labeled N/A rather than simulated.
- Git-style branching and environment promotion (dev/staging/prod versions) for workflows.
- Explicit-deny permission grants and ABAC-style conditional permissions (e.g., "run only during business hours").
- Custom roles beyond `OWNER`/`ADMIN`/`MEMBER`.
- Delegation ("approve on my behalf while on leave") for approvals.
- Working-hours enforcement for AI Employees (deferred until Phase 6's scheduling-expression semantics exist).
- The remaining 7 of 10 researched AI Workforce Engines (n8n, Metabase, Meilisearch, Novu, Listmonk, a MinIO replacement, Keycloak) — each follows the proven 3-engine build pattern but is not scoped into this PRD's MVP.

---

## 21. Open questions / decisions needed

| # | Question | Owner | By when |
|---|---|---|---|
| Q-1 | Does Orlixa's use of AGPL-licensed Postiz/Plane as backend engines create a corresponding-source obligation given customers interact with their functionality via API? | Founder/CEO + external legal counsel | Before GA of any Marketing capability that depends on Postiz (i.e., before MVP ships) |
| Q-2 | What is Orlixa's actual data-residency commitment (EU-only option, etc.), given Neon/Upstash/Vercel region configuration is not addressed in any architecture document reviewed? | Eng lead (infra) + Founder | Before the first enterprise security review that asks |
| Q-3 | What SLA (uptime %, incident response time) can Orlixa credibly commit to today, given no formal SLA exists in any reviewed document? | Founder/CEO | Before the first enterprise contract negotiation |
| Q-4 | Which compliance certifications (SOC 2 Type I/II, ISO 27001, HIPAA if payroll/PII scope expands) will be pursued, and on what timeline? | Founder/CEO + Security lead | Before targeting regulated-industry enterprise segments |
| Q-5 | Should `preventSelfApproval` default to `true` rather than `false` for new companies, given the segregation-of-duties expectation most enterprise buyers assume by default? | Product + Security lead | Before Wave W6 (approvals/permissions) ships |
| Q-6 | Is the current plan-tier gating (`STARTER`/`PRO`/`BUSINESS`/`ENTERPRISE`) the final pricing structure, or will HR/Marketing Employee access itself become plan-gated (e.g., Marketing only on `BUSINESS`+)? | Founder/CEO | Before GA pricing page is finalized |
| Q-7 | Who is accountable for re-verifying each phase document's "current state" claims before every planning cycle, given the confirmed documentation-drift finding (R-10)? | Eng lead (documentation owner) | Immediately — recommend before build kickoff |
| Q-8 | Should the MVP explicitly commit to a prompt-injection test suite (adversarial CVs, poisoned webhook payloads) before GA, given no architecture document addresses this attack surface? | Security lead | Before Wave W5 (HR/Marketing Employees) exits |
| Q-9 | What is the actual target date/customer commitment for SSO (gated behind the unbuilt Keycloak engine), since several enterprise deals in BG-6 are explicitly conditioned on it? | Founder/CEO + Eng lead | Before any enterprise deal is closed that references SSO in the contract |

---

## 22. Appendix

### 22.1 Glossary

| Term | Meaning |
|---|---|
| **AI Employee** | A digital worker (`AiEmployee`) with a role, department, manager, budget, permissions, connected Skills, knowledge access, and memory — the platform's primary abstraction (doc 00 §0.2) |
| **Skill** | A connector/tool integration an Employee can be granted (e.g., Gmail, Postiz, HubSpot) — catalog-defined, 14 today |
| **Workflow** | A multi-step graph of nodes an Employee executes on the company's behalf |
| **WorkflowVersion** | An immutable, versioned snapshot of a workflow's graph — the unit a `WorkflowRun` pins (ADR-002) |
| **NodeType** | One of the 8 existing (`TRIGGER`, `AI_STEP`, `CONDITION`, `WAIT`, `TOOL_ACTION`, `APPROVAL`, `RETRIEVE`, `NOTIFY`) plus 18 new types this architecture adds (26 total canonical, doc 00 §0.7.1) |
| **NodeRegistry** | The typed `NodeDefinition` catalogue replacing the engine's `switch` statement (ADR-003) |
| **ApprovalRequest** | The row gating a high-risk tool call (`TOOL`-kind) or a paused workflow run (`WORKFLOW`-kind) pending human decision |
| **EmployeeRole** | The Prisma enum classifying an Employee's job function: `SUPPORT`, `SALES`, `RECRUITER`, `HR`, `ACCOUNTANT`, `PROJECT_MANAGER`, `CUSTOM`, and `MARKETING` (NEW, this PRD's hard MVP prerequisite) |
| **StaffMember** | NEW roster model representing the customer's human workforce (candidate → active → exited), distinct from `User` (platform logins) and `AiEmployee` |
| **AI Workforce Engine** | A proven open-source product (Postiz, Chatwoot, Plane, etc.) wrapped invisibly behind an AI Employee — the customer never sees the underlying product's own branding |
| **G-numbers / F-numbers** | The architecture's own verified gap-audit identifiers: G1–G30 in doc 00 §0.3.2 (engine-level), F1–F6 in doc 03 (employee-model-level) |
| **Wave (W0–W9)** | The architecture's recommended implementation build order (doc 00 §0.10) |
| **Plan tier** | `STARTER \| PRO \| BUSINESS \| ENTERPRISE` — the existing Prisma `Plan` enum gating feature access |

### 22.2 Traceability matrix (requirement group → architecture source)

| Requirement group | Architecture document | Section |
|---|---|---|
| FR-101–FR-110 (Employee model) | `03-ai-employees.md` | §3.0, §3.1, §3.2 |
| FR-201–FR-207 (Versioning/lifecycle) | `01-workflow-core.md` | §1.A–§1.F |
| FR-301–FR-312 (Node/execution engine) | `02-node-architecture.md`, `05-execution-engine.md` | §2.A–§2.C, §5.A–§5.E |
| FR-401–FR-405 (Connectors) | `04-skills-connectors.md` | §4.0–§4.7 |
| FR-501–FR-504 (Variables/knowledge) | `06-variables.md`, `07-knowledge-memory.md` | §6.1–§6.4, §7.1–§7.3 |
| FR-601–FR-607 (Approvals) | `08-approvals.md` | §8.0–§8.3 |
| FR-701–FR-706 (Permissions) | `09-permissions.md` | §9.A–§9.F |
| FR-801–FR-804 (Audit/cost) | `10-audit.md` | §10.A–§10.F |
| FR-901–FR-903 (Analytics) | `11-analytics.md` | §11.A–§11.F |
| FR-1001–FR-1004 (Frontend/canvas) | `15-frontend.md` | §15.0–§15.K |
| NFR-501–NFR-512 | `00-overview-and-canonical-contracts.md` | §0.8 |
| Risk register R-1, R-2 | `00-overview-and-canonical-contracts.md` | §0.3.2 (G25, G29) |
| Risk register R-3 | `docs/architecture/engines/postiz-engine.md`, `plane-engine.md` | licensing sections (external to the workflow-system doc set) |
| Company/deployment constraints (§19) | `00-overview-and-canonical-contracts.md`; `docs/status/2026-07-27-complete-progress-documentation.md` | §0.8 (isolation), §8 (deployment) |

### 22.3 What this PRD deliberately did not verify first-hand

Per this document's honesty requirement: the Feature Breakdown's SHIPPED/IN PROGRESS/PROPOSED markers are reconciled against the architecture docs' own verified-against-source claims and the 2026-07-27 progress snapshot, not against a fresh independent code read for every single row. Where an architecture document itself marks a finding "NOT VERIFIED" (e.g., whether Postiz enforces `postizCustomerId` scoping on every endpoint, doc 03 §3.2.11), this PRD carries that qualification forward rather than resolving it.
