# Cluster 2 — AI Employee Complete Audit

Source: direct code read, 2026-09-08. Evidence hierarchy: executable code > schema > controllers/services > frontend > e2e fixtures > docs/comments. All paths relative to `d:/Vertical AI/platform` unless noted. `CLAUDE.md` claims are treated as hypotheses, not fact — several are shown stale below.

---

## A. Every AI Employee definition source

There are **three independent, hand-maintained catalogs** that all describe roughly the same roster, plus the runtime `AiEmployee` DB table. None of the three catalogs imports from another — each is a hand-mirrored copy, which is itself a maintenance-hazard finding (see §D).

1. **`AiEmployee` DB model** (`apps/api/prisma/schema.prisma:687-744`) — the only real runtime record. `role: EmployeeRole` (`schema.prisma:39-51`): `SUPPORT, SALES, RECRUITER, HR, ACCOUNTANT, PROJECT_MANAGER, CUSTOM, MARKETING` (8 values; `MARKETING` added later "to close gap G10").
2. **Onboarding catalog** (`apps/api/src/modules/onboarding/onboarding.catalog.ts:8-70`) — 7 role templates surfaced by the hiring wizard, filtered by department: RECRUITER, SALES, SUPPORT, HR, ACCOUNTANT, MARKETING, PROJECT_MANAGER. No CUSTOM entry.
3. **Marketplace catalog** (`apps/api/src/modules/marketplace/marketplace.catalog.ts:17-163`) — 10 employee templates: the same 7 roles as onboarding, plus 3 **CUSTOM**-role templates (ProcurementAI, OperationsAI, LegalAI) with no dedicated enum value.
4. **Public marketing-site catalog** (`apps/web/src/features/marketing/ai-employees.ts:1-280`) — a **fourth, hand-copied restatement** of the same 10 roles for the public `/ai-employees` marketing page, explicitly commented "isn't reachable from `apps/web`'s build, so this file restates it as marketing copy... If a role is added, renamed or retired [in the marketplace catalog], mirror the change here." This is a real drift risk with a concrete instance found (§D1).
5. **Hire dialog** (`apps/web/src/features/employees/components/EmployeeForm.tsx:87-99`, backed by `EMPLOYEE_ROLES` from `@vaep/types`) — exposes **all 8** `EmployeeRole` enum values directly, including `CUSTOM`, independent of the marketplace/onboarding catalogs. This is the widest of the four surfaces: a customer can hire a bare `CUSTOM`-role employee with no persona at all, bypassing every named template.

### A.1 Inventory table

| AI Employee (template/role) | Source(s) | DB record via | Skills assignable | 1st-party Workflow templates | Runtime chat | UI visible | Status |
|---|---|---|---|---|---|---|---|
| RecruitAI (`RECRUITER`) | Onboarding, Marketplace (`recruit-ai`), Hire form, Marketing site | All 3 hire paths (`EmployeesService.create`) | Yes (any skill) | **0** — the only real recruiting workflows require role `HR`, not `RECRUITER` (see §C2) | Real (`AgentRuntimeService`) | `/employees`, `/marketplace`, `/ai-employees` | **PARTIALLY IMPLEMENTED** — hireable and chattable, but the role is a workflow-automation dead end |
| SalesAI (`SALES`) | Onboarding, Marketplace (`sales-ai`), Hire form, Marketing site | 3 hire paths | Yes | **2** (`sales-workflow-templates.catalog.ts`, `minPlan: BUSINESS`) | Real | Same | **FULLY IMPLEMENTED** |
| SupportAI (`SUPPORT`) | Onboarding, Marketplace (`support-ai`), Hire form, Marketing site | 3 hire paths | Yes | **0** — the only Support template (`support-triage`) was retired (§C1) | Real | Same | **PARTIALLY IMPLEMENTED** — same dead-end pattern as RECRUITER |
| HRAI (`HR`) | Onboarding, Marketplace (`hr-ai`), Hire form, Marketing site | 3 hire paths | Yes | **11** (`hr-workflow-templates.catalog.ts`, `minPlan: BUSINESS`) | Real | Same | **FULLY IMPLEMENTED** |
| FinanceAI (`ACCOUNTANT`) | Onboarding, Marketplace (`finance-ai`), Hire form, Marketing site | 3 hire paths | Yes | **0** | Real | Same | **PARTIALLY IMPLEMENTED / never tested** (§B) |
| PMAI (`PROJECT_MANAGER`) | Onboarding, Marketplace (`pm-ai`), Hire form, Marketing site | 3 hire paths | Yes | **0** | Real | Same | **PARTIALLY IMPLEMENTED / never tested** (§B) |
| MarketingAI (`MARKETING`) | Onboarding, Marketplace (`marketing-ai`), Hire form, Marketing site | 3 hire paths | Yes | **11** (`marketing-workflow-templates.catalog.ts`, `minPlan: BUSINESS`) | Real | Same | **FULLY IMPLEMENTED** |
| ProcurementAI / OperationsAI / LegalAI (`CUSTOM`) | Marketplace only, Hire form (bare `CUSTOM`), Marketing site | 2 hire paths (not onboarding) | Yes | **0** | Real | `/marketplace`, `/ai-employees` (never `/onboarding`) | **DEMO ONLY** — installable, chattable, but zero e2e coverage and zero packaged automation (§B) |

**Runtime confirmation (point 4 of the assignment):** both execution surfaces genuinely delegate to the same real agent loop — no shortcut found.
- Chat: `EmployeesService.sendMessage` → `AgentRuntimeService.run` (`apps/api/src/modules/employees/employees.service.ts:471-496` → `apps/api/src/modules/employees/runtime/agent-runtime.service.ts:120-227`) runs the full **plan → retrieve → memory → act (bounded tool loop, `MAX_ACT_ITERATIONS`) → validate** pipeline, with credit reservation/settlement, budget checks, sensitive-scenario detection, and out-of-scope role-boundary refusal.
- Workflow `AI_EMPLOYEE_STEP` node: `AiEmployeeStepNodeHandler.execute` (`apps/api/src/modules/employees/runtime/ai-employee-step.handler.ts:59-213`) creates a real `Conversation` and calls the **exact same** `AgentRuntimeService.run` (`:124-137`), only with `disableTools: true` (so it can recommend but not autonomously act — side effects are separate `TOOL_ACTION` nodes) and workflow-specific credit/usage attribution. It correctly **fails the step** (not silently succeeds) when the employee refuses the work as out-of-role (`:193-199`) — this is the "silent-success" defect class this codebase has fixed elsewhere, and it is fixed here too.
- No hardcoded/static/fake employee response path was found anywhere in either surface. The only "mock" in this domain is the swappable `LLM_PROVIDER=mock` deterministic provider (`llm/mock-llm.provider.ts`), which is an explicit, documented, offline/test default — not a disguised fake execution path. **Classification: none of the 8 roles has fake execution — all run through the real `AgentRuntimeService`.**

---

## B. Unused / never-exercised AI Employees

Grepped `apps/api/test/**` (101 e2e suites) for `role:\s*['"]<ROLE>['"]` per role:

| Role | Files referencing it in e2e | Verdict |
|---|---|---|
| `HR` | 17 | Exercised (HR domain wave, HR workflow templates) |
| `SUPPORT` | 16 | Exercised (mostly `engines-support` Chatwoot integration, not the role's own workflow automation) |
| `SALES` | 9 | Exercised (marketplace install test, sales workflow templates) |
| `MARKETING` | 8 | Exercised (marketing workflow wave) |
| `CUSTOM` | 3 (`engines-marketing`, `engines-support`, `marketplace.e2e-spec.ts`) | Exercised only incidentally — **none of the 3** files installs/tests `procurement-ai`, `operations-ai`, or `legal-ai` specifically (confirmed: `grep -rn "procurement-ai\|operations-ai\|legal-ai"` across `apps/api/src`, `apps/api/test`, `e2e` returns **zero matches** outside the catalog/marketing-page definitions themselves) |
| `RECRUITER` | 2 (`learning.e2e-spec.ts`, `workflow-generator.e2e-spec.ts`) | Barely exercised — never as the subject of a hiring-flow or workflow-install test |
| `ACCOUNTANT` | **0** | **Never hired in any e2e test** |
| `PROJECT_MANAGER` | **0** | **Never hired in any e2e test** |

### Classification

| Role/template | Verdict | Reason |
|---|---|---|
| `HR`, `MARKETING`, `SALES` | **KEEP** | Real e2e coverage, real workflow templates, real business use case |
| `SUPPORT` | **KEEP, FIX** | Heavily used for the Chatwoot *engine* integration, but the standalone AI-Employee automation path (a Support AI employee driving a workflow) has zero templates since `support-triage` was retired — the role is live but its packaged automation is gone |
| `RECRUITER` | **FIX** | Hireable, chattable, marketed with a specific example workflow ("Resume → score → schedule") that does not exist as a template anywhere in the current catalog (§C1); the actual recruiting automation that does exist requires `HR`, not `RECRUITER` (§C2) — the role and its marketing promise are currently disconnected from any shippable automation |
| `ACCOUNTANT`, `PROJECT_MANAGER` | **KEEP, but currently DEMO ONLY** | Hireable via all 3 entry points, real chat runtime, zero e2e coverage of any kind, zero workflow templates. Nothing is broken, but nothing beyond generic chat has ever been proven to work either |
| `CUSTOM` (Procurement/Operations/Legal) | **DEMO ONLY** | Only reachable via `/marketplace` or a bare Hire-form `CUSTOM` pick (never onboarding); zero e2e install/run coverage; zero workflow templates; persona-only differentiation with no tests exercising that persona |

---

## C. Where the chain breaks

Traced Employee → Skills → Connections → Knowledge → Workflow → Runtime → Execution for every role. The chain is genuinely intact for `HR`/`MARKETING`/`SALES` (skills install → per-employee/company-wide connection → `AI_EMPLOYEE_STEP`/`TOOL_ACTION` nodes → real `AgentRuntimeService`/skill executor, matching CLAUDE.md's per-employee-skill-connections and skill-connection-framework entries). For the other 5 roles the chain is intact through Skills/Connections/Knowledge/Runtime, but breaks specifically at the **Workflow layer**, for two distinct reasons found by direct code read:

### C1. Marketing-site promises a workflow that was deliberately deleted from the product

`apps/api/src/modules/marketplace/marketplace.catalog.ts:165-182` explicitly documents that three legacy workflow templates were **retired**, by name:
```
export const MARKETPLACE_RETIRED_WORKFLOWS: readonly string[] = [
  'recruiting-resume-score-schedule',
  'sales-outreach',
  'support-triage',
] as const;
```
They used the banned `AI_STEP`/`NOTIFY` node vocabulary (doc 27 §0.4) and were never ported to the current `AI_EMPLOYEE_STEP`/`TOOL_ACTION` vocabulary.

Yet `apps/web/src/features/marketing/ai-employees.ts` — whose own doc-comment (`:23-24`) states `exampleWorkflow` is "**Only set when a real, shipped workflow template demonstrates this role**" — still ships:
- `recruit-ai.exampleWorkflow` = "Resume → score → schedule" (`:45-53`)
- `sales-ai.exampleWorkflow` = "Sales outreach" (`:75-83`)
- `support-ai.exampleWorkflow` = "Support triage" (`:105-113`)

All three correspond by name to the exact templates the API catalog says were retired. The real, currently-shipped Sales template (`sales.whatsapp-lead-qualify`) has a *different* name and shape than the marketing page's "Sales outreach" description (Slack-post outreach vs. WhatsApp qualify/nurture). **The public marketing site is describing product capability that does not exist in the current codebase, in direct violation of its own stated content rule.** This is the single most severe finding of this cluster (see Top 5).

### C2. Recruiting workflow automation requires the wrong role

All 11 HR templates in `hr-workflow-templates.catalog.ts` — including the ones that are explicitly about candidate-facing recruiting work ("HR: recruitment intake → acknowledge applicant" `:16`, "HR: candidate screening → recruiter approval → notify" `:45`, "HR: interview scheduling → book → invite" `:74`) — declare `requires: { employeeRoles: ['HR'], ... }` (grepped every `requires:` line in the file: all 11 say `['HR']`, none say `['RECRUITER']`).

`workflow-templates.service.ts:365-374` (`assertPrerequisites`) checks this literally: it queries `aiEmployee` rows for the company and requires the exact role string to be present. A company that hired **RecruitAI** (role `RECRUITER`, per the marketplace/onboarding catalogs) but no `HR` employee **cannot install any of these templates** — the prerequisite check reports the `HR` role missing, even though a recruiting employee is sitting right there. The `RECRUITER` `EmployeeRole` enum value therefore has **zero** first-party workflow template it can satisfy; every recruiting automation the product ships is gated on hiring an `HR`-role employee instead.

---

## D. Marketplace vs. onboarding catalog drift (found, not hypothesized)

The marketplace catalog's own in-code comment (`marketplace.catalog.ts:103-110`) documents a **real historical bug of this exact class**: `MarketingAI` used to be `role: 'CUSTOM'` before the `MARKETING` enum value existed, which meant an employee hired from the marketplace (as opposed to onboarding) satisfied *zero* Marketing workflow templates' `employeeRoles: ['MARKETING']` requirement — "installable in the gallery, unusable in every Marketing template." This was fixed for `MarketingAI` specifically. The **exact same defect class is still live today for `RecruitAI`** (§C2) — it was fixed for one role and not generalized to catch the other.

Additionally, `CLAUDE.md`'s module-status line (§ "HR + Marketing workflow templates (Waves P3-03 + P3-04)") claims **"22 first-party templates — 11 HR + 11 Marketing"**. Direct read of `workflow-templates.catalog.ts:1-14` shows the aggregation is now `[...HR_WORKFLOW_TEMPLATES, ...MARKETING_WORKFLOW_TEMPLATES, ...SALES_WORKFLOW_TEMPLATES]` — **24 templates**, not 22 (the file's own comment at `:9` is itself stale too, saying "1 Sales" when `sales-workflow-templates.catalog.ts` defines **2**: `sales.whatsapp-lead-qualify` and `realestate.whatsapp-lead-qualify`). CLAUDE.md predates the Sales wave and was never updated — a second concrete instance (after Cluster 1's credit-table comment) of this codebase's docs/comments overstating or understating what the code actually does.

---

## E. Role-based hiring plan seat gating vs. the catalog (assignment point 5)

`docs/product/2026-09-04-role-based-hiring-plans.md` + `apps/api/src/modules/billing/billing.plans.ts:34-112`:

| Plan | `maxRoles` | `maxPerRole` | Distinct roles reachable at once |
|---|---|---|---|
| STARTER (Free) | **2** | 1 | 2 of the 8 `EmployeeRole` values |
| PRO (Starter $20) | **2** | 1 | 2 of 8 |
| BUSINESS (Growth $40) | **2** | 2 | 2 of 8 (more headcount per role, still only 2 distinct roles) |
| ENTERPRISE | unlimited | unlimited | all 8 |

`checkSeatFor` (`billing.plans.ts:160-181`) enforces this atomically inside `EmployeesService.create()`'s advisory-locked transaction — verified real, not just documented.

**The catalog vs. the gate, combined:**
- The catalog offers **8 distinct roles** (10 templates counting the 3 CUSTOM variants). Every plan below Enterprise — i.e. every self-serve paid tier that exists today — can only ever have **2 of them hired simultaneously**. A customer who wants HR + Marketing + Sales automation (all three now have real 1st-party workflow templates, all three `minPlan: BUSINESS`) **cannot reach all three on any priced plan**: Growth ($40) still caps at 2 roles, so the third role is structurally unreachable without Enterprise (custom pricing, no self-serve path).
- Every Sales/HR/Marketing template additionally requires `minPlan: 'BUSINESS'` (`requires.minPlan`, checked in `assertPrerequisites` at `:375-384`), so a Starter/Free customer (2 roles, but not gated to HR/Marketing/Sales specifically) can hire e.g. HR + Marketing employees yet still can't install **any** of their workflow templates until upgrading to Growth — the chat-only "PARTIALLY IMPLEMENTED" experience is what Free/Starter customers actually get for the roles with real automation, not a defect, but worth stating plainly since the plan doc's own customer-flow example (§4) glosses over this: it shows the wizard picking "HR + Marketing" on the **free** plan and does not mention that the workflow layer for either is inert until Growth.
- `RECRUITER`, `ACCOUNTANT`, `PROJECT_MANAGER`, and the 3 `CUSTOM` templates have **no** `minPlan` gate at all (no workflow templates exist for them to gate) — so plan tier is irrelevant to them; the ceiling on their usefulness is entirely the missing-template gap in §B/§C, not billing.

---

## Top 5 most severe findings

1. **The public marketing site advertises example workflows for RecruitAI, SalesAI and SupportAI that were deliberately deleted from the product.** `apps/web/src/features/marketing/ai-employees.ts` ships `exampleWorkflow` copy ("Resume → score → schedule", "Sales outreach", "Support triage") matching, by name, the exact three templates `marketplace.catalog.ts:165-182` documents as retired for using a banned node vocabulary — in direct violation of the marketing file's own doc-comment rule that `exampleWorkflow` is only set when a real, shipped template demonstrates it. A prospect reading the public site is told about automation that does not exist anywhere in the current codebase.
2. **The `RECRUITER` `EmployeeRole` has zero workflow templates it can ever satisfy.** All 11 candidate-facing HR/recruiting templates (`hr-workflow-templates.catalog.ts`) require `employeeRoles: ['HR']`, never `['RECRUITER']`. A company that hires RecruitAI (the product's flagship recruiting persona, marketed since onboarding) and no separate HR employee cannot install a single one of the recruiting automations the product ships — the exact "installable in the gallery, unusable in every template" bug the marketplace catalog's own comments say was already found and fixed once for `MarketingAI`, recurring unnoticed for `RECRUITER`.
3. **Below Enterprise, no plan can ever hire more than 2 distinct roles, but 3 roles (HR/Marketing/Sales) now have real, `minPlan:BUSINESS`-gated workflow automation.** A Growth ($40) customer wanting HR + Marketing + Sales automation — all now real, shipped capability — cannot reach all three without a custom Enterprise deal; the role-based-hiring plan doc's own customer-flow narrative doesn't mention this interaction.
4. **`ACCOUNTANT` and `PROJECT_MANAGER` roles have zero e2e coverage of any kind** (`grep` across all 101 e2e suites in `apps/api/test` returns 0 files for `role: 'ACCOUNTANT'` or `role: 'PROJECT_MANAGER'`) despite being hireable through all 3 production entry points (Hire form, onboarding wizard, marketplace) and marketed on the public site with specific responsibilities and outcomes. Nothing is known to be broken, but nothing beyond generic chat has ever been exercised either.
5. **Four independent, hand-maintained copies of the same AI-Employee roster exist** (Prisma enum, onboarding catalog, marketplace catalog, marketing-site catalog) with no shared import between the API-side two and the web-side marketing copy (documented as unavoidable — the marketing page's own comment says the API package "isn't reachable from `apps/web`'s build"). This is a structural drift risk, not a hypothetical one: findings #1 and #2 above are both concrete instances of exactly this drift already having happened.
