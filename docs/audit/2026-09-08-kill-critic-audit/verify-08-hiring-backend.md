# Verify-08 — The AI Employee HIRING chain (backend baseline)

**Task:** establish, read-only, what the hiring chain **actually is today** so that Phase 2 implements only
real gaps. Nothing was modified except this file.

**Method:** direct code/schema/test read, 2026-09-10. Every claim cites `file:line`, paths relative to
`d:/Vertical AI/platform`. Where I could not determine something it is flagged, not guessed.

**Given as verified and not re-derived** (per the task): 3 hire entry points all funnel into
`EmployeesService.create()`; `checkSeatFor()` is enforced inside a per-company `pg_advisory_xact_lock`
transaction; role-based hiring plans are real and server-enforced; `AiEmployee.status` is
`ACTIVE|PAUSED|DISABLED` + a separate `archivedAt`; workflow-engine employee-status enforcement
(`engine/employee-lifecycle.ts`) is DONE. All four were spot-checked in passing and hold.

**Headline:** the hire chain is a **single-row insert plus a seat check**. There is no pre-active state, no
activation step, no readiness concept, no default skill/workflow provisioning, no role/skill/workflow/
connection entitlement, and no audit row for hire or for a status change. Three findings are new to this
pass: the marketplace hire route has **no role guard at all**, department scoping is **absent on PATCH /
DELETE / dependencies**, and the readiness advisory (`verify-02` Step 5) was **not implemented** while the
rest of `verify-02` was.

---

## 1. The hire API surface

### 1.1 `POST /employees` — the canonical hire — **IMPLEMENTED**

| Aspect | Evidence |
|---|---|
| Route | `employees.controller.ts:41-48` (`@Controller('employees')` at `:36`) |
| Guards | `@UseGuards(JwtAuthGuard, AuthorizationGuard)` at `:37`; `@RequirePermission('employee:manage')` at `:42` |
| Floor | `employee:manage` → `'ADMIN'` (`authorization/authorization.policy.ts:42`). The guard is a **pre-load floor check only** — no id, no scope (`authorization.guard.ts:58-64`, and its own doc at `:14-24`) |
| Service | `EmployeesService.create()` `employees.service.ts:83-134` |
| Tenant | `companyId` comes from `@CurrentTenant()`, read off the JWT (`auth/decorators/current-tenant.decorator.ts:6-12`) |

**DTO, quoted verbatim** (`employees/dto/create-employee.dto.ts:9-27`):

```ts
export class CreateEmployeeDto implements ICreateEmployeeDto {
  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  @IsIn(EMPLOYEE_ROLES)
  role!: EmployeeRole;

  @IsOptional() @IsString() @MaxLength(2000)
  persona?: string;

  @IsOptional() @IsString() @MaxLength(120)
  model?: string;
}
```

Four fields only. There is **no** `companyId` field on any hire DTO (grepped across
`employees/dto`, `marketplace/dto`, `onboarding/dto` — zero hits), so nothing trusts a client-supplied tenant.

**What it writes** (`employees.service.ts:122-131`) — one `AiEmployee` row:
`companyId`, `name`, `role`, `persona ?? null`, `model ?? null`, `budgetLimit`. Nothing else. No
`EmployeeSkill`, no `InstalledSkill`, no `Workflow`, no `Department` link, no audit row.

Pre-checks, in order:
1. `subscription.status !== 'ACTIVE'` → `ForbiddenException` (`:87-92`).
2. `pg_advisory_xact_lock(hashtext(companyId))` (`:98`), roster read inside the lock (`:105-108`),
   `checkSeatFor(plan, roster, dto.role)` (`:109`) → `ForbiddenException` with the plain-language
   `seatRefusal(...)` (`:111`, function at `:577-604`).
3. `budgetLimit` stamped (`:118-120`) — see §5.

### 1.2 `PATCH /employees/:id` — **PARTIALLY IMPLEMENTED** (real gaps)

Route `employees.controller.ts:69-77`, `@RequirePermission('employee:manage')` at `:70`.
Service `employees.service.ts:189-238`.

DTO (`employees/dto/update-employee.dto.ts:24-124`) is the wide config surface: `name`, `status`
(`@IsIn(EMPLOYEE_STATUSES)` at `:32-33`), `persona`, `model` (nullable via `@ValidateIf`), `department`,
`managerName`, `workingHoursStart/End`, `timezone`, `language`, `knowledgeAccess`, `budgetLimit`,
`maxCreditsPerExecution`, `maxCreditsPerTask`, `permissions`, `approvalRules`, `goals`, `kpiTargets`.

Writes exactly those columns (`:196-236`). Only guard beyond the ADMIN floor is
`assertBudgetWithinPlan` (`:195`, impl `:555-570`).

Three confirmed defects:
- **No audit row.** Re-verified: `employees.service.ts` contains only two `audit.record` calls —
  `'employee.hard_delete'` (`:385`) and `'employee.archive'` (`:413`). A repo-wide grep for
  `action: '` filtered to employee/hire/skill returns only those two plus
  `onboarding.ai_employees_selected` (`onboarding.service.ts:252`) and `skill.install`
  (`skills.service.ts:196`). **"Who paused Emma, and when" is unanswerable.** The prior finding stands.
- **No status transition validation, and `archivedAt` is never cleared.** `findOwnedEmployee`
  (`:500-511`) does not filter `archivedAt`, so `PATCH { status: 'ACTIVE' }` on an archived employee
  yields `ACTIVE` + `archivedAt` set — invisible in `list()` (which filters `archivedAt: null`, `:145`)
  but "active" to any status-only check. There is no restore/unarchive endpoint.
- **No department scoping.** `get()` calls `assertEmployeeScope` (`:172-177`); `update()` does **not**.
  See §9.

### 1.3 `DELETE /employees/:id` — **IMPLEMENTED**

Route `employees.controller.ts:103-122`, `@RequirePermission('employee:manage')` at `:104`,
`@HttpCode(204)`. `?hard=true` additionally requires `user.role === 'OWNER'` in the controller
(`:112-118`). Service `employees.service.ts:350-418`.

- Blocks on `deps.inFlightRuns > 0` → 409 (`:361-366`) and `deps.pendingApprovals > 0` → 409 (`:367-372`).
- Soft path writes `{ status: 'DISABLED', archivedAt: new Date() }` (`:402-405`) + audit
  `employee.archive` (`:410-417`). Idempotent (`:393-396`).
- Hard path `prisma.aiEmployee.delete` (`:375`) + `logger.warn` + audit `employee.hard_delete` (`:382-389`).

### 1.4 `GET /employees/:id/dependencies` — **IMPLEMENTED, UNUSED by the UI**

`employees.controller.ts:84-90` (no `@RequirePermission` → any member). Service `:247-298`. Counts owned
connections, conversations, memories, skill grants, skill executions, approvals, pending approvals,
referencing workflows, in-flight runs. Confirmed orphaned on the frontend (prior audit finding #5).

### 1.5 The onboarding `complete` path — **IMPLEMENTED**

`POST /onboarding/complete` → `onboarding.controller.ts:85-92`,
`@UseGuards(JwtAuthGuard, RolesGuard)` at `:27` + `@Roles('OWNER','ADMIN')` at `:86`.
Service `onboarding.service.ts:300-446`.

- Idempotent short-circuit on `onboardedAt` (`:311-316`).
- Departments upserted via `createMany({ skipDuplicates })` (`:326-331`).
- **Whole-selection seat pre-flight** simulating the roster and returning ONE `422` naming every problem
  (`:349-380`).
- Hires per-role, skipping roles already staffed, **by calling `this.employees.create(...)`**
  (`:397`) — so the advisory-locked seat check still runs per hire (comment `:394-396`).
- Name resolution: `entry.name?.trim() || ONBOARDING_CATALOG.suggestedName || entry.role` (`:390-393`).
- Free-credit grant (`:407-410`), then profile + `onboardedAt` + `onboardingStep: 'COMPLETED'`
  (`:413-422`), audit `onboarding.completed` (`:423-429`), welcome notification (`:431`).

Note the ordering comment at `:401-406`: the grant runs before the stamp deliberately.

### 1.6 The marketplace install path — 🔴 **BROKEN (authorization)**

`POST /marketplace/employees/:key/install` → `marketplace.controller.ts:42-49`.
Service `marketplace.service.ts:41-55` → `this.employees.create({ name, role, persona })`.
DTO: `marketplace/dto/install-employee.dto.ts` (optional `name` override only).

🔴 **The controller is guarded by `@UseGuards(JwtAuthGuard)` and nothing else**
(`marketplace.controller.ts:31`). There is no `@RequirePermission`, no `@Roles`, and no global
authorization guard — the only `APP_GUARD` in the app is `TenantAwareThrottlerGuard`
(`app.module.ts:93`). So:

> **Any authenticated MEMBER can hire an AI Employee through the marketplace**, consuming a plan seat and
> creating a persona-bearing identity, on a surface whose canonical sibling (`POST /employees`) enforces an
> ADMIN floor. Seat/plan enforcement still applies (it lives in `create()`), so this is a **privilege**
> gap, not a billing bypass.

Classification: **BROKEN** — the hire surface has inconsistent authorization. Not previously reported in
`00-FINAL-REPORT.md` or `verify-02`.

---

## 2. Employee lifecycle states

**There is no pre-active hiring state of any kind. MISSING.**

- Enum, verbatim (`apps/api/prisma/schema.prisma:53-57`):
  ```prisma
  enum EmployeeStatus {
    ACTIVE
    PAUSED
    DISABLED
  }
  ```
- Column + default: `status EmployeeStatus @default(ACTIVE)` (`schema.prisma:693`, inside
  `model AiEmployee` at `:687-745`). Soft delete `archivedAt DateTime?` at `:730`.
- Indexes: `@@index([companyId])`, `@@index([companyId, archivedAt])` (`:743-744`). No `[companyId, status]`.
- Exhaustive search for a pre-active concept — `PENDING_SETUP|CONFIGURING|\bDRAFT\b|activationStatus|onboardingStatus|READY_TO_WORK|employeeReadiness|activateEmployee` across `apps/api/src`: **every hit
  belongs to another domain** — `WorkflowVersion.status DRAFT`, `ScheduledPost`/`Campaign`/`ContentItem`
  `DRAFT`, `PerformanceReview` `DRAFT`, and a provider-adapter comment `CONFIGURING_INBOUND`
  (`skills/providers/provider-adapter.ts:119`). Zero hits relate to `AiEmployee`.
- A second search for `employeeReadiness|employee-readiness|needsSetup|isReadyToWork|readyToWork` across
  `apps/api/src`, `apps/web/src` and `packages/types/src`: **zero hits.**

**Is an employee usable the instant it is created?** Yes, unconditionally. `create()` never writes
`status`, so the DB default `ACTIVE` applies (`employees.service.ts:122-131`), and every consumer treats
`ACTIVE` as workable — chat (`agent-runtime.service.ts` status guard) and now the workflow engine
(`engine/employee-lifecycle.ts:118-126`).

**Is there an explicit activation endpoint or step for an employee?** **No — stated plainly.** The only
routes on the employee resource are `POST /`, `GET /`, `GET /:id`, `PATCH /:id`, `GET /:id/dependencies`,
`DELETE /:id`, `POST /:id/conversations`, `GET /:id/conversations`
(`employees.controller.ts:41,50,60,69,84,103,124,133`), plus the learning/feedback/memory routes
(`learning.controller.ts:34,43,53,61,70,82`) and the conversation-message routes
(`conversations.controller.ts:23,43`). "Activation" exists only for **workflows**
(`POST /workflows/:id/activate`), which is a different entity. The nearest thing to employee activation is
`PATCH /employees/:id { status: 'ACTIVE' }` — an unvalidated generic field write (§1.2).

---

## 3. Employee readiness

**MISSING.** There is no employee-level equivalent of `workflow-readiness.ts`.

What exists for workflows, for comparison — `workflows/readiness/workflow-readiness.ts`:
- Pure evaluator, `ReadinessInput` at `:34-45` (`definition`, `triggerType`, `triggerConfig`,
  `skillRequirements`, `warnings`).
- Six-to-seven `checks[]` (`:259-292`): `STRUCTURE`, `TRIGGER`, `NODE_CONFIG`, `AI_EMPLOYEE`, `SKILLS`,
  `APPROVAL`, plus `SCHEDULE`.
- 🔴 The `AI_EMPLOYEE` check at `:275-279` is hardcoded `status: 'PASS'` and only ever flips to `FAIL`
  when the *structural validator's* `employeeId` rule fired (`:298-306`, matched by
  `/employeeId/i.test(i.message)`). **It never reads employee state.** `ReadinessInput` has no
  `employees` field. So the check labelled "AI employees" tells the user nothing about their AI employees.
  Classification: **PARTIALLY IMPLEMENTED / misleading label.**
- `verify-02` Step 5 specified adding a `WARNING`-severity `EMPLOYEE_NOT_ACTIVE` issue here. Grep for
  `EMPLOYEE_NOT_ACTIVE` across `apps/api/src`: **zero hits.** **NOT IMPLEMENTED** — the one part of the
  `verify-02` plan that did not land.

**Are required connections / skills / knowledge validated at hire time or activation time?** No, on all
three counts:
- Hire: `create()` (`employees.service.ts:83-134`) touches only subscription status, the seat rule, and
  `budgetLimit`. No skill, connection or knowledge query at all.
- Activation: there is no activation step (§2).
- The only place required connections are validated is **per workflow, at publish**:
  `SkillRequirementsService.assertPublishable` (`skill-requirements.service.ts:128-145`), called from
  `workflow-version.service.ts:193`.

### What building an employee readiness check would cost

**Free from `SkillRequirementsService` today** (`skills/skill-requirements.service.ts`):
- `forSkillKeys(companyId, skillKeys, { canManageConnection })` (`:73-86`) — takes a **bare list of skill
  keys, no workflow needed**, and returns the full `WorkflowSkillRequirementsDto`. This is exactly the
  shape an employee-level check needs.
- `buildRequirements` (`:88-120`) resolves each skill through
  `SkillsService.findInstalledConnection(companyId, skillKey, scopedEmployeeId)` (`skills.service.ts:225-236`),
  which delegates to `resolveInstalledForExecution` — **the same lookup execution uses**, so the answer
  cannot drift from runtime (doc comment `:216-224`).
- `toRequirement` (`:188-219`) already yields per-skill `requiresConnection`, `connectionType`,
  `capabilities`, `compatibleSkillKeys`, `credentialsSet`, `installedSkillId`, `canManageConnection`.
- `projectStatus` (`:227-251`) already maps `CONNECTED/DEGRADED/DISCONNECTED/NOT_CONNECTED` →
  `READY/DEGRADED/DISCONNECTED/NOT_CONNECTED`, and returns `'READY'` for a `none`-connection skill and
  `'ERROR'` for a skill outside the catalog.
- `missingRequiredCount` / `allRequiredReady` roll-up (`:115-119`).

**What would have to be new:**
1. **The skill list itself.** `forSkillKeys` needs keys; nothing derives "the skills this employee needs".
   The only per-employee skill fact that exists is the *assigned* set
   (`SkillsService.getToolsForEmployee`, `skills.service.ts:484-507`, reads `EmployeeSkill` joined to
   `installedSkill.enabled`). There is **no** declaration of skills a role *requires*.
   `EMPLOYEE_ROLE_CAPABILITIES` (`product-context/relevance.map.ts:~145+`) is the closest thing — a
   role → capability table — and its own docstring says it is sourced from `ROLE_SCOPE` and the
   marketplace templates' `suggestedSkills` (`relevance.map.ts:136-142`). It drives *recommendations*,
   never a requirement.
2. **A knowledge check.** Nothing anywhere evaluates "does this employee have knowledge to work from".
   `knowledgeAccess` is a per-employee `ALL|NONE` switch, not a readiness input.
3. **The pure evaluator + DTO + route**, mirroring `workflow-readiness.ts` /
   `workflow-readiness.service.ts` / `GET /workflows/:id/readiness`.
4. **A decision on whether readiness blocks anything.** For workflows the invariant is
   `ready === (publish would succeed)` (`platform/CLAUDE.md`, pinned by
   `test/workflow-ux-simplification.e2e-spec.ts`). An employee has no publish, so an employee readiness
   check has no equivalent invariant to satisfy and would be purely advisory unless a new gate is
   invented. **Flagged as a product decision, not determinable from code.**

---

## 4. Entitlement enforcement beyond seats

**Seats: server-enforced.** `checkSeatFor` (`billing/billing.plans.ts:160-181`) is called from
`EmployeesService.create()` inside the advisory lock (`employees.service.ts:109`), from the onboarding
pre-flight (`onboarding.service.ts:360`), and (via `resolveSeats`) from the resolver
(`capability-resolver.ts:239-256`). It returns `TOTAL | PER_ROLE | NEW_ROLE | null`.

The complete set of plan knobs that exist at all (`packages/types/src/index.ts:2514-2545`, values in
`billing.plans.ts:34-112`): `maxRoles`, `maxPerRole`, `maxEmployees` (derived),
`creditsPerEmployeePerMonth`, `includedCreditsPerMonth`, `features[]`, `priceMonthlyUsd`.
**Nothing else.** There is no per-plan skill list, workflow cap, or connection cap to enforce.

| Entitlement | Server-refuses? | Resolver display hint? | Verdict |
|---|---|---|---|
| **Seats (total / per-role / new-role)** | ✅ `employees.service.ts:109-112` (403), `onboarding.service.ts:360-380` (422) | ✅ `entitlements.seats` via `resolveSeats` (`capability-resolver.ts:227,239-256`) | **IMPLEMENTED** |
| **Role entitlement — "may this plan hire this ROLE at all?"** | ❌ **The concept does not exist.** `checkSeatFor` counts *how many distinct roles* are in use (`billing.plans.ts:168-178`); it never asks *which*. `PLAN_CATALOG` has no allowed-roles field. `CreateEmployeeDto` accepts any of the 8 `EMPLOYEE_ROLES` (`create-employee.dto.ts:15-16`; enum `schema.prisma:39-51`) on every plan, STARTER included. | ❌ nothing hides a role by plan | **MISSING** — every plan can hire every role, capped only by count |
| **Skill entitlement — "may this plan use this skill?"** | ❌ `POST /skills/install` is gated by `@RequirePermission('skill:connect')` (`skills.controller.ts:74-75`, floor ADMIN at `authorization.policy.ts:45`) and by catalog membership (`skills.service.ts:138-141`) — **never by plan**. `install()` (`:133-202`) reads no subscription. Grep `maxSkills\|maxConnections`: zero hits in `apps/api/src`. | Partly: `skillStatuses` labels `SIMULATED_ONLY` for executor-less skills (`capability-resolver.ts:368-379`), which is an *execution-support* fact, not an entitlement | **MISSING** |
| **Workflow entitlement — count/complexity cap** | ❌ No workflow-count cap anywhere. Grep `maxWorkflows\|workflowLimit`: zero product hits — the only matches are the *credit* failure class `WORKFLOW_LIMIT_EXCEEDED` (`workflow-runtime/retry-policy.service.ts:34,143,171,206`), which is a per-run **credit** ceiling, and `credit-reconciliation.service.ts:222-227` itself logs that `WorkflowRun.creditLimit` is never set (matching §29 of the final report: permanently dead). | n/a | **MISSING** (count) / **BROKEN** (the credit-denominated one has no writer) |
| **Template min-plan** | ✅ enforced at install: `workflow-templates.service.ts` prereq check → 422, using the canonical `planMeetsMinimum` (`billing.plans.ts:196-198`) | ✅ `resolveTemplates` sets `requiresPlan` (`capability-resolver.ts:470-482`) | **IMPLEMENTED** (this is the one non-seat entitlement that is genuinely both) |
| **Product-area plan gating** | ⚠️ Only where a `@RequirePlan` decorator exists — and there are exactly **two**: the whole `AssistController` (`assist/assist.controller.ts:50-51`, `BUSINESS`/`ENTERPRISE`) and `POST /workflows/generate` (`workflows.controller.ts:164-165`). | ✅ `AREA_MIN_PLAN = { ASSIST: 'BUSINESS' }` (`relevance.map.ts:108-110`) — one entry, whose docstring at `:100-107` says it "mirrors the server-side `@RequirePlan` decorators EXACTLY", and it does | **IMPLEMENTED, narrow** — the table and the decorators agree because both cover only ASSIST |
| **Connection entitlement — cap on connectors** | ❌ absent everywhere | ❌ | **MISSING** |

**The precise answer the task asks for:** for role, skill, workflow-count and connection entitlement, it
is neither "the resolver hides it" nor "the server refuses it" — **the entitlement does not exist as a
concept in the plan catalog**, so there is nothing to hide and nothing to refuse. The resolver is
correctly labelled advisory-only (`capability-resolver.ts:40-53`: `RELEVANT ∧ ENTITLED ∧ AUTHORIZED`, and
`:41-45` "It is not an authorization layer … can only ever REMOVE"), and it faithfully surfaces the two
entitlements that do exist (seats, template min-plan) plus the one plan-gated area.

---

## 5. Default configuration at hire

**What is created besides the row: nothing.** `create()`'s single write is the `aiEmployee.create`
at `employees.service.ts:122-131`.

| Thing | State |
|---|---|
| **`EmployeeSkill` rows (default skills)** | **MISSING.** `create()` performs no `employeeSkill` write. The only automatic `EmployeeSkill` creation in the codebase is inside `SkillsService.install()` when an install is employee-scoped (`skills.service.ts:186-190`) — i.e. triggered by connecting a skill, never by hiring. |
| **Default workflows** | **MISSING.** No `workflow.create` or template install anywhere in the hire path (`employees.service.ts`, `marketplace.service.ts`, `onboarding.service.ts` — none import `WorkflowsService` or `WorkflowTemplatesService`; `marketplace.service.ts:11-17` explicitly records that workflow templates were removed from that module). |
| **`budgetLimit`** | ✅ **IMPLEMENTED, and the ~$5/500-credit figure is CONFIRMED.** `employees.service.ts:118-120`: `const defaultCredits = creditsPerEmployeeFor(plan); const budgetLimit = defaultCredits === null ? null : Math.ceil(defaultCredits / DEFAULT_CREDITS_PER_USD);`. `creditsPerEmployeePerMonth` is **500 on STARTER, PRO and BUSINESS** and **null on ENTERPRISE** (`billing.plans.ts:42,60,77,95`). At `DEFAULT_CREDITS_PER_USD = 100` (the $0.01/credit peg documented at `billing.plans.ts:23-26`) that is **$5**. Enterprise gets `null` = unlimited, which is the same "bounded by nothing" hole §29 of the final report names. `assertBudgetWithinPlan` (`employees.service.ts:555-570`) makes 500 credits also the **maximum** a customer may PATCH it to. Pinned by `test/employees-seats.e2e-spec.ts:71` ("stamps the plan ceiling (500 credits = $5)") and `:117-144`. |
| **`status`** | Not written; DB default `ACTIVE` (`schema.prisma:693`). |
| **`knowledgeAccess`** | Not written; DB default `ALL` (`schema.prisma:707`). |
| **Everything else** (`department`, `managerName`, `workingHours*`, `timezone`, `language`, `permissions`, `approvalRules`, `goals`, `kpiTargets`, `maxCreditsPer*`) | Left `NULL`. Reachable **only** through a follow-up `PATCH /employees/:id` — `CreateEmployeeDto` has no fields for any of them. |

**Does the onboarding catalog declare default skills/workflows per role?** **No.**
`onboarding/onboarding.catalog.ts:8-70` — every one of the 7 entries carries exactly
`{ role, suggestedName, title, description, departments }`. No skills, no workflows.
(Note: the catalog lists **7** roles — `CUSTOM` is absent — while the Prisma enum has 8.)

**Does the marketplace catalog declare them, and does anything consume the declarations?**
It declares `suggestedSkills` on all 10 templates (`marketplace/marketplace.catalog.ts:29,42,55,68,81,94,118,131,144,159`).
**DISPLAY-ONLY — confirmed.** The only consumers of that field anywhere in the repo are:
- `apps/web/src/features/marketplace/components/EmployeeTemplateList.tsx:48-51` — renders
  `Suggested skills: {template.suggestedSkills.join(', ')}` as text;
- `apps/api/src/modules/product-context/relevance.map.ts:141` — a **code comment** citing it as the
  source it was hand-derived from;
- the type declaration `packages/types/src/index.ts:2617`.

`MarketplaceService.installEmployee` (`marketplace.service.ts:41-55`) passes only
`{ name, role, persona }` to `create()` — `suggestedSkills` is dropped on the floor. So the marketplace
UI tells a customer which skills an employee needs and then hires it with none of them, silently.
Classification: **UNUSED (declaration) / display-only**.

`persona` **is** consumed (`marketplace.service.ts:53`) — the marketplace is the only hire path that
supplies one automatically.

---

## 6. Skill assignment chain

**Endpoints** (`skills/employee-skills.controller.ts`, `@Controller('employees/:id/skills')` at `:27`,
`@UseGuards(JwtAuthGuard, AuthorizationGuard)` at `:28`):

| Route | Line | Guard | Service |
|---|---|---|---|
| `GET /employees/:id/skills` | `:32-39` | none beyond JWT (any member) | `SkillsService.listEmployeeSkills` `skills.service.ts:467-479` |
| `POST /employees/:id/skills` | `:41-49` | `@RequirePermission('skill:connect')` (floor ADMIN, `authorization.policy.ts:45`) | `SkillsService.assign` `skills.service.ts:432-450` |
| `DELETE /employees/:id/skills/:installedSkillId` | `:51-60` | `@RequirePermission('skill:connect')` | `SkillsService.unassign` `skills.service.ts:452-465` |

DTO (`skills/dto/assign-skill.dto.ts:5-9`) is a single field:
```ts
export class AssignSkillDto implements IAssignSkillDto {
  @IsString() @MinLength(1)
  installedSkillId!: string;
}
```

**What `assign()` validates** (`skills.service.ts:432-450`):
1. `assertEmployee(companyId, employeeId)` (`:437`, impl `:1547-1558`) — the employee exists **in this
   tenant**. `select: { id: true }`; **no `status`/`archivedAt` filter**, so a paused, disabled or
   archived employee can still be granted a skill.
2. `findOwnedInstalled(companyId, installedSkillId)` (`:438`) — the `InstalledSkill` belongs to this
   tenant. Implicitly: the skill **is installed**, since `EmployeeSkill` points at an `InstalledSkill` row.
3. Idempotency via the `employeeId_installedSkillId` compound unique (`:440-445`).

**What it does NOT validate:**

| Check | State |
|---|---|
| Skill installed? | ✅ implicit (an `installedSkillId` must resolve) |
| Allowed for this plan? | ❌ **MISSING** — no subscription read anywhere in `assign()`, and no per-plan skill entitlement exists (§4) |
| Compatible with the employee's role? | ❌ **MISSING** — `role` is never read. `EMPLOYEE_ROLE_CAPABILITIES` exists (`relevance.map.ts:145+`) but is advisory-only |
| Requires a connection, and is it connected? | ❌ **MISSING at assign time.** `assign()` reads neither `connectionStatus` nor `enabled`. `SkillCapabilities.requiresConnection` and the `projectStatus` machinery exist (`skill-requirements.service.ts:199,227-251`) but are only invoked per *workflow* at publish. The `enabled` flag *is* honoured later, at execution: `getToolsForEmployee` filters `installedSkill: { enabled: true }` (`skills.service.ts:488-490`) |
| Employee workable (ACTIVE, not archived)? | ❌ **MISSING at assign time** — but enforced at execution, see below |
| Audit row? | ❌ **MISSING.** `assign`/`unassign` write no audit row (only `skill.install` does, `:196`) |

**Execution-time enforcement is now real** (this is part of the DONE lifecycle work):
`employeePermissionDenial` (`skills.service.ts:607-645`) selects
`{ ...EMPLOYEE_LIFECYCLE_SELECT, permissions: true }` (`:614-616`) and **fails closed** —
`employeeWorkableReason(employee)` non-null (or a null row) returns a denial reason (`:623-635`), with the
old `if (!employee) return null` fail-open path removed and documented in place (`:617-622`).

---

## 7. Employee → workflows

**Re-verified. Both prior findings stand.**

- **No exposed API returns the workflows for a given employee. MISSING.** The employee controller's
  complete route list (§2) contains nothing of the kind, and `workflows.controller.ts` has **zero**
  occurrences of `employeeId` (grepped) — so there is no `GET /workflows?employeeId=` filter either.
- `EmployeesService.workflowsReferencing` is still **`private`** (`employees.service.ts:309-323`), and a
  repo-wide grep across `apps/api/src` + `apps/api/test` finds exactly **two** hits: the declaration at
  `:309` and the single call at `:271` inside `dependencies()`. Classification: **UNUSED beyond
  `dependencies()`** — confirmed, unchanged.
  Its mechanism is a substring match on the serialized graph:
  `definition: { string_contains: employeeId }` with `archivedAt: null` (`:313-321`), with the rationale
  documented at `:300-308`.
- **`Workflow` has no FK or relation to `AiEmployee`. CONFIRMED.** Extracting `model Workflow` from
  `apps/api/prisma/schema.prisma` and grepping it for `employee|AiEmployee` returns **no matches**; the
  only lines matched were `@@index([companyId])`. The single employee↔workflow FK in the schema is on the
  *run*: `WorkflowRun.actingEmployeeId` → `AiEmployee.workflowRuns @relation("WorkflowRunActingEmployee")`
  (`schema.prisma:740`). "Which employees does this workflow involve" is therefore **derived from graph
  JSON only**, at read time, by `engine/employee-references.ts`.

---

## 8. Audit events for employee lifecycle

**Complete list of audit action strings written for employee lifecycle operations — there are two.**

| Operation | Audit action | Site |
|---|---|---|
| **create / hire** | — | **MISSING**. `create()` (`employees.service.ts:83-134`) contains no `audit.record` call on any of its 3 entry paths |
| **update (name/persona/model/config)** | — | **MISSING**. `update()` (`:189-238`) contains no `audit.record` call — **re-verified, the prior finding is correct** |
| **status change (ACTIVE↔PAUSED↔DISABLED)** | — | **MISSING**. Status is just another field written by `update()` at `:200`, so a pause/disable/resume is unattributable |
| **archive (soft delete)** | `employee.archive` | `:410-417`; metadata `{ name, previousStatus, retained: {...deps} }` |
| **hard delete** | `employee.hard_delete` | `:382-389`; metadata `{ name, destroyed: {...deps}, historyDestroyed: true }` |
| **skill assign / unassign** | — | **MISSING**. `assign()` `skills.service.ts:432-450` and `unassign()` `:452-465` write nothing. The adjacent `install()` **does** (`skill.install`, `:193-200`) |

Adjacent, for completeness: `onboarding.ai_employees_selected` (`onboarding.service.ts:250-256`) records
the *wizard selection* of roles, not the hires; `onboarding.completed` (`:423-429`) records completion
with credit metadata but **does not list the employees hired**;
`onboarding.departments_selected` (`:195-201`).

**Versus the event names an implementation would want** — `employee.hired`/`employee.created`,
`employee.updated`, `employee.status_changed` (or `employee.paused`/`.disabled`/`.resumed`),
`employee.activated`, `employee.skill_assigned`/`.skill_unassigned`: **all MISSING**. Only
`employee.archive` and `employee.hard_delete` exist, and their naming style is imperative-verb
(`archive`, `hard_delete`) rather than past-tense — a new set should match the existing two or the two
should be renamed, not silently diverge.

---

## 9. Security / tenant isolation on the hiring surface

**Tenant isolation: sound. Department scoping: incomplete.**

`companyId` is always taken from the JWT via `@CurrentTenant()`
(`auth/decorators/current-tenant.decorator.ts:6-12` — `return req.user.companyId`). **Nothing on the
hiring surface trusts a client-supplied `companyId`**: a grep for `companyId` across
`employees/dto/*.ts`, `marketplace/dto/*.ts` and `onboarding/dto/*.ts` returns **zero** hits.

| Endpoint | Scoping mechanism | Cross-tenant id → |
|---|---|---|
| `POST /employees` | n/a (creates with JWT `companyId`) | n/a |
| `GET /employees` | `where: { companyId, archivedAt: null }` (`employees.service.ts:141-148`), then `authz.filter(actor, 'employee:read', …, scope: e.role)` (`:154-162`) | rows from another tenant are never selected |
| `GET /employees/:id` | `findOwnedEmployee` (`:500-511`) → `findFirst({ where: { id, companyId } })`; null → `NotFoundException('Employee not found')` | **404, not a leak.** Plus `assertEmployeeScope(..., 'employee:read')` at `:172-177` |
| `PATCH /employees/:id` | `findOwnedEmployee` at `:194` → 404 | **404, not a leak.** ⚠️ **but no `assertEmployeeScope`** |
| `GET /employees/:id/dependencies` | `findOwnedEmployee` at `:251` → 404; every count query carries `companyId` (`:262-270`) | **404, not a leak.** ⚠️ no `assertEmployeeScope`; no `@RequirePermission` either, so any member reads it |
| `DELETE /employees/:id` | `findOwnedEmployee` at `:356` → 404 | **404, not a leak.** ⚠️ no `assertEmployeeScope` |
| `POST /onboarding/complete` | JWT `companyId` throughout; `@Roles('OWNER','ADMIN')` (`onboarding.controller.ts:86`) | n/a |
| `POST /marketplace/employees/:key/install` | JWT `companyId`; `create()` scopes everything | 🔴 **no role/permission guard at all** (§1.6) |
| `POST /employees/:id/skills` | `assertEmployee(companyId, employeeId)` (`skills.service.ts:1547-1558`) → 404; `findOwnedInstalled(companyId, id)` → 404 | **404, not a leak** |

**Two named gaps, neither a cross-tenant leak:**

1. 🔴 **`POST /marketplace/employees/:key/install` has no authorization guard** — see §1.6. A MEMBER can
   hire. **BROKEN.**
2. ⚠️ **Department scoping is enforced on employee READS only.** `AuthorizationGuard` is explicitly a
   pre-load floor check and cannot scope a resource it has not read (`authorization.guard.ts:14-24`,
   `:58-64` — "No id and no scope: this is the pre-load floor check"). `get()` and `list()` therefore call
   the resource-level `assertEmployeeScope`/`authz.filter`; `update()`, `remove()` and `dependencies()`
   **do not**. Net effect: an ADMIN whose department scope is HR can `PATCH` or `DELETE` a MARKETING
   employee they are not permitted to *read* (`GET /employees/:id` would 403 for them, per
   `test/phase1-safety.e2e-spec.ts:508-527`). Classification: **PARTIALLY IMPLEMENTED.** Note this only
   bites tenants that have actually configured `Department.scopes` — which ship empty/unrestricted by
   design (final report §5), so it is latent for most tenants today.
3. Minor, for completeness: `remove()`'s `?hard=true` OWNER check lives in the **controller**
   (`employees.controller.ts:112-118`), not the service, so any future non-HTTP caller of
   `remove(..., { hard: true })` bypasses it. Pinned at the HTTP level by
   `test/phase1-safety.e2e-spec.ts:377`.

---

## 10. Existing test coverage of hiring

### Unit

| File:line | What it actually proves |
|---|---|
| `src/modules/billing/billing.plans.spec.ts:23` | `maxEmployees === maxRoles × maxPerRole` on every plan — the derived value can't disagree with the rule |
| `…:33` | `PLAN_CATALOG` matches the founder-approved matrix (2×1 / 2×1 / 2×2 / ∞) |
| `…:56` | included credits stay ≤ 50 % of price value on paid tiers (the margin guard) |
| `…:63`, `:71` | each rule is exposed through one helper; `PLAN_RANK` tier order is stable |
| `…:81-124` (7 cases) | `checkSeatFor` in isolation: first hire allowed; `PER_ROLE`; `NEW_ROLE` even with seats free; second-in-role on a 2-per-role plan; `TOTAL` takes precedence; **DISABLED frees a seat AND a role slot**; **PAUSED still occupies**; unlimited plan never refuses |
| `src/modules/workflows/engine/employee-lifecycle.spec.ts:20-122` (12 cases) | the new pure rule: ACTIVE-unarchived allowed; PAUSED/DISABLED/ARCHIVED blocked; **ACTIVE-but-archived blocked** (the split state); ARCHIVED reported ahead of DISABLED; null → `MISSING` never "allowed"; the assert preserves the caller's `select` type and throws a typed error; the message names employee/state/fix; `EMPLOYEE_LIFECYCLE_SELECT` is exactly four columns |
| `src/modules/workflow-runtime/retry-policy.service.spec.ts:34` | `AUTHORIZATION_DENIED` (what `EmployeeNotWorkableError` maps to at `retry-policy.service.ts:167`) is **non-retryable** |
| `src/modules/product-context/capability-resolver.spec.ts` | the A–H scenario matrix incl. `entitlements.seats` — proves the **display** hint matches the rule |

### E2E (`apps/api/test/`)

| File:line | What it actually proves |
|---|---|
| `employees-seats.e2e-spec.ts:71` | first HR hire succeeds **and stamps `budgetLimit` = 500 credits = $5** — the only test of the hire-time default |
| `…:77`, `:87` | second same-role hire refused (per-role); third hire refused once both seats taken |
| `…:83` | a second *different* role is allowed |
| `…:92` | `PATCH { status: 'DISABLED' }` frees both the seat **and** the role slot |
| `…:101` | `/billing/usage` and `/product-context` report the **same** seat picture as the enforcer |
| `…:117`, `:126`, `:136` | R5 ceiling: lowering allowed; raising above the plan refused *naming the number*; `null` (unlimited) refused on a capped plan |
| `…:149`, `:153`, `:159` | BUSINESS: per-role went 1→2; a third distinct role still refused with a seat free; last seat fillable by an existing role |
| `…:167` | downgrade grandfathers every employee, caps ceilings, blocks the next hire |
| `…:190` | **onboarding pre-flight returns one 422 for an over-plan selection and hires nobody** — the only test of the wizard's whole-selection check |
| `employees.e2e-spec.ts:83` | `POST /employees` creates a SUPPORT employee and a conversation starts |
| `…:104`, `:142` | the agent loop returns a grounded result; history persists |
| `…:152` | `PATCH { status: 'PAUSED' }` → posting a chat message returns **409** — the *chat-only* status guard |
| `…:166` | employee routes 401 without a token |
| `onboarding.e2e-spec.ts:93` | `POST /onboarding/complete` hires the selected employees, updates the business profile and stamps `onboardedAt` |
| `…:76`, `:130` | the role-template catalog is served; status flips to completed |
| `…:138` | rich employee config round-trips through `PATCH /employees/:id` — i.e. it proves the config is only reachable *after* hire |
| `onboarding-steps.e2e-spec.ts:45` | the 3 wizard steps walk, goals reconcile on a role change, and state resumes after re-login |
| `employee-lifecycle-enforcement.e2e-spec.ts:150` | baseline: an ACTIVE employee's workflow CAN start (proves the fixture is real) |
| `…:163`, `:180` | PAUSED / DISABLED → run refused **409**, message names the employee |
| `…:194` | **ARCHIVED-but-ACTIVE still blocked** — the split state a status-only check misses |
| `…:225` | SCHEDULE: a paused employee stops the schedule firing **without throwing** |
| `…:277` | a workflow naming nobody is unaffected (back-compat) |
| `…:318` | an author-`disabled` node does not block the run, because the engine skips it anyway |
| `phase1-safety.e2e-spec.ts:329` | `GET /employees/:id/dependencies` reports what a delete would take |
| `…:339`, `:358`, `:364`, `:369` | DELETE archives by default (row/conversations/connection survive); the archived employee leaves the roster; repeat DELETE is not an error; an `employee.archive` audit row is written |
| `…:377`, `:400` | ADMIN hard delete refused; OWNER hard delete really erases and is audited |
| `…:413` | any delete blocked while an approval raised by the employee is pending (409) |
| `…:491-527` | department scoping of the employee **roster/read** — an HR-scoped admin sees HR and not Marketing, and `/analytics` agrees with `GET /employees` |
| `marketplace.e2e-spec.ts:87` | `POST /marketplace/employees/:key/install` hires an employee that appears in `/employees` |
| `…:107` | `marketing-ai` installs as role `MARKETING`, not `CUSTOM` (the regression from the catalog comment) |
| `…:123`, `:131` | unknown key → 404; no token → 401 |

### Gaps in the test coverage itself

- 🔴 **No test asserts the authorization floor on any hire route.** `marketplace.e2e-spec.ts` tests 401
  (no token) and 404 (bad key) but never a MEMBER — which is exactly why §1.6 went unnoticed. Nothing
  tests that `POST /employees` refuses a MEMBER either.
- **No test drives the seat limit through the marketplace path.** `employees-seats.e2e-spec.ts:16` states
  in its own header comment that it "drive[s] the Hire form path" only; `grep marketplace` on that file
  returns just that comment. The claim "all 3 hire paths are seat-checked" is proven by *code sharing*
  (both call `create()`), not by a test.
- **No test asserts an audit row for hire or for a status change** — consistent with §8: there is none to
  assert.
- **No test of department scoping on `PATCH`/`DELETE`/`dependencies`** — consistent with §9.
- **Zero e2e coverage of `ACCOUNTANT` and `PROJECT_MANAGER`** (pre-existing finding, final report §6-8).

---

## Things I could NOT determine (flagged, not guessed)

1. **Whether the marketplace route's missing guard is deliberate.** No comment, ledger entry or test
   explains it, and the controller's long docstring (`marketplace.controller.ts:8-29`) discusses workflow
   templates at length while never mentioning authorization. Treating it as a miss, matching how
   `verify-02` treated the analogous unfiltered generator query.
2. **Whether `update()`'s missing `assertEmployeeScope` is deliberate.** `get()` has it and `update()`
   does not, in the same file, with no comment either way. Could be an intentional "manage is company-wide,
   read is scoped" split — but nothing says so, and `authz.assert` accepts `'employee:manage'` as an
   action (`employees.service.ts:523`), i.e. the plumbing for the scoped check already exists and is
   simply not called.
3. **Whether an employee readiness check should gate anything.** Workflows have the
   `ready === (publish would succeed)` invariant to satisfy; an employee has no publish, so there is no
   equivalent anchor. This is a product call.
4. **Whether "role entitlement" is wanted at all.** The plan model deliberately sells *N distinct roles of
   the customer's choosing* rather than *these specific roles* (`billing.plans.ts:7-20`). A per-plan
   allowed-role list may be a deliberate non-feature rather than a gap. Flagged rather than assumed.
5. **Whether `CUSTOM`'s absence from `ONBOARDING_CATALOG`** (7 entries vs the enum's 8) is deliberate. The
   marketplace covers it with 3 CUSTOM templates and `EMPLOYEE_ROLE_CAPABILITIES.CUSTOM = []` is
   explicitly commented as intentional (`relevance.map.ts:95-97`), so probably yes — but the wizard offers
   no path to a CUSTOM hire and nothing says that is on purpose.

---

# REAL GAPS vs ALREADY DONE

## A. REAL GAPS — the only list the implementation may touch

Ordered by severity within each block.

**Security / correctness**
1. 🔴 **`POST /marketplace/employees/:key/install` has no authorization guard.** Any MEMBER can hire.
   `marketplace.controller.ts:31,42-49`. Needs `@UseGuards(JwtAuthGuard, AuthorizationGuard)` +
   `@RequirePermission('employee:manage')` to match `employees.controller.ts:37,42`, plus a MEMBER-403
   e2e case (none exists on any hire route). **BROKEN.**
2. ⚠️ **Department scoping missing on `PATCH /employees/:id`, `DELETE /employees/:id` and
   `GET /employees/:id/dependencies`.** `employees.service.ts:189-238`, `:350-418`, `:247-298` — none call
   `assertEmployeeScope`, which `get()` does at `:172-177`. Latent for tenants with empty
   `Department.scopes`. **PARTIALLY IMPLEMENTED.**
3. **`PATCH /employees/:id` has no status-transition validation and never clears `archivedAt`.**
   `employees.service.ts:196-236` + `findOwnedEmployee` `:500-511`. Produces the ACTIVE-but-archived split
   state. No restore/unarchive endpoint exists. **BROKEN.**

**Observability**
4. **No audit row for hire.** `create()` `employees.service.ts:83-134`. **MISSING.**
5. **No audit row for update, and therefore none for a status change.** `update()` `:189-238`.
   Re-verified — "who paused Emma, and when" is unanswerable. **MISSING.**
6. **No audit row for skill assign/unassign.** `skills.service.ts:432-450`, `:452-465`, while the sibling
   `install()` audits at `:193-200`. **MISSING.**

**Lifecycle / readiness**
7. **No pre-active employee state.** `EmployeeStatus` is `ACTIVE|PAUSED|DISABLED` (`schema.prisma:53-57`),
   default `ACTIVE` (`:693`), and an employee is usable the instant the row exists. No `DRAFT`,
   `CONFIGURING`, `PENDING_SETUP` or `READY` exists anywhere. **MISSING.**
8. **No employee activation endpoint or step.** Route inventory in §2. **MISSING.**
9. **No employee readiness computation.** No employee-level `workflow-readiness.ts`; nothing validates
   required connections/skills/knowledge at hire or activation. **MISSING.**
10. **`workflow-readiness.ts`'s `AI_EMPLOYEE` check is a hardcoded `PASS`** that only ever FAILs off the
    structural validator's `employeeId` rule (`workflow-readiness.ts:275-279`, `:298-306`), and
    `ReadinessInput` (`:34-45`) has no employee state. `verify-02` Step 5's `EMPLOYEE_NOT_ACTIVE`
    `WARNING` was **not implemented** (grep: zero hits) — the one part of that plan still open.
    **PARTIALLY IMPLEMENTED.**

**Hire-time configuration**
11. **No default skills assigned at hire.** `create()` writes no `EmployeeSkill`. **MISSING.**
12. **No default workflows at hire.** No template install in any hire path. **MISSING.**
13. **`marketplace.catalog.ts`'s `suggestedSkills` is declared for all 10 templates and consumed by
    nothing but a text label** (`EmployeeTemplateList.tsx:48-51`) — `installEmployee` drops it
    (`marketplace.service.ts:50-54`). The UI names the skills an employee needs, then hires it with none.
    **UNUSED / display-only.**
14. **`ONBOARDING_CATALOG` declares no skills or workflows per role**
    (`onboarding.catalog.ts:8-70` — only `role/suggestedName/title/description/departments`).
    **MISSING** (nothing to consume).
15. **All rich employee config is unreachable at hire** — `CreateEmployeeDto` has 4 fields
    (`create-employee.dto.ts:9-27`); `department`, `permissions`, `approvalRules`, `knowledgeAccess`,
    working hours etc. require a follow-up PATCH. **PARTIALLY IMPLEMENTED.**

**Entitlements beyond seats**
16. **Role entitlement does not exist.** `checkSeatFor` counts distinct roles, never *which*
    (`billing.plans.ts:160-181`); `PLAN_CATALOG` has no allowed-role field; `CreateEmployeeDto` accepts all
    8 roles on every plan. **MISSING** (see undetermined item #4 — confirm intent first).
17. **Skill entitlement does not exist.** `POST /skills/install` reads no subscription
    (`skills.service.ts:133-202`); no `maxSkills`/`maxConnections` anywhere. **MISSING.**
18. **Workflow-count entitlement does not exist**; the only `WORKFLOW_LIMIT_EXCEEDED` is a *credit*
    ceiling whose writer is dead (`credit-reconciliation.service.ts:222-227`). **MISSING / BROKEN.**
19. **Connection entitlement does not exist.** **MISSING.**
20. **Skill assignment validates nothing but tenancy** — not plan, not role compatibility, not
    connection-required-and-connected, not employee workability
    (`skills.service.ts:432-450`, `assertEmployee` `:1547-1558`). **PARTIALLY IMPLEMENTED.**

**Employee ↔ workflow visibility**
21. **No API returns the workflows for an employee.** `workflowsReferencing` is still `private` with one
    caller (`employees.service.ts:271`, `:309-323`); `workflows.controller.ts` has no `employeeId` filter.
    **MISSING.**
22. **`Workflow` has no relation to `AiEmployee`** — confirmed by extracting the model from
    `schema.prisma`; ownership is derived from graph JSON only. Architectural fact, only a gap if a
    persistent view is wanted.

**Test coverage**
23. No test of the authorization floor on any hire route (which is why gap #1 survived).
24. No test drives the seat limit through the **marketplace** path (`employees-seats.e2e-spec.ts:16`
    header states it covers the hire-form path only).
25. No test of department scoping on `PATCH`/`DELETE`/`dependencies`.

## B. ALREADY DONE — do not re-implement

1. **All 3 hire entry points funnel into one `EmployeesService.create()`** — direct
   (`employees.controller.ts:47`), onboarding (`onboarding.service.ts:397`), marketplace
   (`marketplace.service.ts:50`). One enforcement point, not three.
2. **Seat/role/plan enforcement is real, atomic and race-safe** — `checkSeatFor` inside
   `pg_advisory_xact_lock` with the roster read *inside* the lock (`employees.service.ts:95-112`), the one
   pure rule shared with `BillingService.usage()` and `capability-resolver.ts:239-256`. Listed on the
   final report's own "do not touch" list (§42).
3. **Onboarding's whole-selection seat pre-flight** — one 422 naming every problem, no partial hire
   (`onboarding.service.ts:349-380`), on top of the per-hire race-safe check.
4. **Onboarding `complete()` is idempotent** — `onboardedAt` short-circuit (`:311-316`), department
   `skipDuplicates` (`:326-331`), role-level "already hired" skip (`:384-388`), and deliberate write
   ordering (`:296-299`, `:401-406`).
5. **`budgetLimit` stamped at hire** — 500 credits → $5 via `DEFAULT_CREDITS_PER_USD`
   (`employees.service.ts:118-120`; `billing.plans.ts:42,60,77,95`), and `assertBudgetWithinPlan` makes it
   the ceiling on PATCH too (`:555-570`). Tested at `employees-seats.e2e-spec.ts:71,117-144`. (Enterprise
   `null` = unbounded is a *known, separate* item in the final report §29 — not a hiring gap.)
6. **Employee lifecycle enforcement in the workflow engine — DONE, and thoroughly.** Verified present at
   every site `verify-02` named:
   `engine/employee-lifecycle.ts` (pure rule + typed error + `EMPLOYEE_LIFECYCLE_SELECT`);
   `retry-policy.service.ts:167` classifies it `AUTHORIZATION_DENIED` **by `instanceof`** (non-retryable);
   `ai-step.handler.ts:113` — the "the workflow assistant" silent degrade is **deleted**, with the old
   behaviour documented in place at `:100-112`;
   `tool-action.handler.ts:125-131` — a lookup was **added** where there was none, deliberately **before**
   the dry-run short-circuit; `memory.handlers.ts:64,122`; `retrieve.handler.ts:160`;
   `approval-gate.service.ts:201` **and** its legacy twin `workflow-engine.service.ts:652`;
   `ai-employee-step.handler.ts:96`; `skills.service.ts:623-635` — the fail-open
   `if (!employee) return null` is **fixed to fail closed**; and the `enqueueRun` chokepoint guard
   `assertGraphEmployeesWorkable` (`workflows.service.ts:1045`, impl `:1397-1424`) which filters
   author-`disabled` nodes and throws a 409. Covered by
   `employee-lifecycle-enforcement.e2e-spec.ts` (7 cases) + `employee-lifecycle.spec.ts` (12 cases).
   **Only `verify-02` Step 5 (the readiness WARNING) is outstanding — listed as gap #10.**
7. **Tenant isolation on the whole hiring surface** — `companyId` always from the JWT
   (`current-tenant.decorator.ts:6-12`); zero `companyId` fields in any hire DTO; every cross-tenant id
   resolves to `NotFoundException`, never a leak (`findOwnedEmployee` `:500-511`, `assertEmployee`
   `skills.service.ts:1547-1558`, `findOwnedInstalled`).
8. **Archive-vs-hard-delete safety** — `?hard=true` is OWNER-only (`employees.controller.ts:112-118`),
   blocked on `inFlightRuns` and `pendingApprovals` (`employees.service.ts:361-372`), idempotent
   (`:393-396`), and both paths are audited (`:382-389`, `:410-417`). Tested at
   `phase1-safety.e2e-spec.ts:339-430`.
9. **`GET /employees/:id/dependencies`** exists and is rich (`:247-298`). It is *orphaned on the
   frontend* — a UI wiring item already tracked as final-report P1 #9, **not** a backend gap.
10. **Department-scoped employee READS** — `list()` filters via `authz.filter` (`:154-162`), `get()`
    asserts via `assertEmployeeScope` (`:172-177`), proven by `phase1-safety.e2e-spec.ts:491-527`.
11. **`SkillRequirementsService` is reusable as-is for an employee readiness check** —
    `forSkillKeys(companyId, skillKeys, opts)` (`skill-requirements.service.ts:73-86`) already resolves
    connections through the same lookup execution uses and projects the 5-value status. Do not build a
    second connection-status evaluator.
12. **`capability-resolver.ts` correctly reports the entitlements that exist** (seats, template min-plan,
    the one plan-gated area) and is correctly labelled advisory-only (`:31-53`). Final report §42 says
    don't rebuild it to "add enforcement" — enforcement belongs in the endpoints. That still holds.
13. **`AREA_MIN_PLAN` and the `@RequirePlan` decorators genuinely agree** — one entry
    (`ASSIST: 'BUSINESS'`, `relevance.map.ts:108-110`), two decorator sites
    (`assist.controller.ts:50-51`, `workflows.controller.ts:164-165`). No drift to fix.
