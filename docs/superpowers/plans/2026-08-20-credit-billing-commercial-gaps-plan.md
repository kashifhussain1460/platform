# Credit Billing Commercial Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the confirmed, code-verified commercial gaps in the Orlixa credit billing system —
one live "phantom control" bug, one fragmented plan-entitlement check, and two customer-facing
transparency additions — without touching the credit engine itself (ledger, reservation,
settlement, idempotency, lot expiry, refunds, concurrency guard all verified CONFIRMED and out of
scope).

**Architecture:** Every task extends an existing service in place. No new services, no new
Prisma models, no rewrite of `CreditLimitsService`/`PlanGuard`/`CreditLedgerService`. Task 2
(ceiling enforcement) adds one parameter and one branch to an existing method with three known
call sites. Task 3 (subscription-status) adds one check to an existing guard. Task 4 removes a
duplicate local lookup table in favour of one already-adjacent to the canonical plan catalog.
Tasks 5-6 add read-only aggregation methods over data that already exists (`CreditLot.remaining`,
`CreditLedger` grouped by `employeeId`/`workflowId`) — no new write paths.

**Tech Stack:** NestJS + Prisma (`apps/api`), Jest (unit specs colocated as `*.spec.ts`), shared
DTOs in `@vaep/types` (`packages/types/src`).

**Spec:** `docs/status/2026-08-20-credit-billing-commercial-gap-audit.md` (the gap audit this plan
implements — read it first; every task below cites the same file:line evidence).

## Global Constraints

- Do not modify `CreditLedger`, `CreditLot`, `CreditReservation`, or any other Prisma model in
  this plan — every task reads existing columns or adds a new nullable/optional field to an
  existing model at most (Tasks 2 needs none; schema already has `maxCreditsPerExecution`/
  `maxCreditsPerTask`).
- Every new/changed error message must stay classifiable by `RetryPolicyService` via BOTH
  `instanceof` (the direct call path) and a string-fallback pattern (the TOOL_ACTION re-wrap path,
  `tool-action.handler.ts:197-213`) — this codebase has already been bitten twice by forgetting
  the second one.
- No task may change `EmployeeBudgetExceededError`'s or `WorkflowLimitExceededError`'s existing
  message text — `agent-runtime.service.ts`'s §35.5 verbatim-text rule (`credit-limits.service.ts:21-27`).
- After Task 4 or Task 5 changes `packages/types`, run `pnpm --filter @vaep/types build` before
  manually smoke-testing `apps/api` outside Jest (Jest itself maps `@vaep/types` to source — see
  `platform/CLAUDE.md`'s monorepo-build gotcha — so unit tests do not need this step, but a real
  `pnpm dev` boot does).
- Run the full `pnpm test` (e2e, both `pnpm test` default engine and
  `WORKFLOW_ENGINE_MODE=legacy_walk pnpm test`) once at the end of Task 6, not after every task —
  per this project's own "implement fully, then verify once" convention.

---

### Task 1: Founder Pricing Decision Record

**Files:**
- Create: `docs/product/2026-08-20-credit-economics-decision.md`

This is a decision artifact, not code — no TDD cycle applies. The architecture for versioned
pricing (`ModelCostRate`, `ToolCostRate`, `CreditPack`, all effective-dated) is already built and
confirmed correct (audit Gap 4). What's missing is a founder sign-off on the actual numbers, which
today are live defaults with a `FOUNDER-PENDING` comment and no enforced boot-time block. This
task surfaces the real current values (not invented ones) so the sign-off is a lock-in decision,
not a blank slate.

- [ ] **Step 1: Write the decision record**

```markdown
# Credit Economics — Founder Decision Record

Status: AWAITING SIGN-OFF. `CREDIT_ENFORCEMENT_ENABLED` must not be flipped for a real paying
company until every row below is either checked "Lock as-is" or replaced with a real number.

| # | Parameter | Current default | Source | Decision |
|---|-----------|------------------|--------|----------|
| 1 | $/credit peg | $0.01 (`DEFAULT_CREDITS_PER_USD=100`) | `apps/api/src/modules/credits/credit-rates.defaults.ts:18` | ☐ Lock as-is ☐ Override: ____ |
| 2 | Safety margin on provider cost | 10% | `credit-rates.defaults.ts:22`, `credit-cost-calculator.service.ts:70` | ☐ Lock as-is ☐ Override: ____ |
| 3 | Free signup credit grant | 1,000 credits | `apps/api/src/common/config/credit-config.ts:32` | ☐ Lock as-is ☐ Override: ____ |
| 4 | Signup grant expiry | 30 days | `credit-config.ts:38` | ☐ Lock as-is ☐ Override: ____ |
| 5 | Signup abuse domain cap | 3 signups/domain | `credit-config.ts:44` | ☐ Lock as-is ☐ Override: ____ |
| 6 | PRO plan monthly allotment | 4,000 credits | `apps/api/src/modules/billing/billing.plans.ts:38` | ☐ Lock as-is ☐ Override: ____ |
| 7 | BUSINESS plan monthly allotment | 18,000 credits | `billing.plans.ts:53` | ☐ Lock as-is ☐ Override: ____ |
| 8 | Credit pack: SMALL | $10 / 1,000 credits | `apps/api/src/modules/billing/credit-packs.ts:16` | ☐ Lock as-is ☐ Override: ____ |
| 9 | Credit pack: MEDIUM | $50 / 5,500 credits | `credit-packs.ts:27` | ☐ Lock as-is ☐ Override: ____ |
| 10 | Credit pack: LARGE | $100 / 12,000 credits | `credit-packs.ts:27` | ☐ Lock as-is ☐ Override: ____ |
| 11 | Nav badge Low/Critical thresholds | 25% / 10% of trailing spend | `apps/web/src/components/app-shell/CreditBadge.tsx:10-23` | ☐ Lock as-is ☐ Override: ____ |
| 12 | Company concurrency cap | see `company-concurrency-guard.service.ts:7` default | same file | ☐ Lock as-is ☐ Override: ____ |
| 13 | Reconciliation drift tolerance | see `credit-reconciliation.service.ts:7` default | same file | ☐ Lock as-is ☐ Override: ____ |

**Signed off by:** _______________  **Date:** _______________

Once every row is checked, update the corresponding constant (removing its `FOUNDER-PENDING`
comment) in a follow-up commit — this record is the sign-off, not the code change.
```

- [ ] **Step 2: Get the founder's actual sign-off on the table above (blocks nothing else in this plan — Tasks 2-6 are independent bug fixes/additions that hold regardless of the final numbers)**

- [ ] **Step 3: Commit**

```bash
git add docs/product/2026-08-20-credit-economics-decision.md
git commit -m "docs: credit economics founder decision record"
```

---

### Task 2: Enforce per-execution/per-task credit ceilings (fixes the phantom control)

**Files:**
- Modify: `apps/api/src/modules/credits/credit-limits.service.ts:96-151`
- Modify: `apps/api/src/modules/employees/runtime/agent-runtime.service.ts:408-412`
- Modify: `apps/api/src/modules/workflows/engine/nodes/ai-step.handler.ts:157-161`
- Modify: `apps/api/src/modules/skills/skills.service.ts:699-703`
- Modify: `apps/api/src/modules/workflow-runtime/retry-policy.service.ts`
- Modify: `apps/api/src/modules/workflow-runtime/retry-policy.service.spec.ts`
- Test (new): `apps/api/src/modules/credits/credit-limits.service.spec.ts`

**Interfaces:**
- Consumes: `EmployeeExecutionCeilingExceededError`/`EmployeeTaskCeilingExceededError` (already
  defined, `credit-limits.service.ts:50-75`), `AiEmployee.maxCreditsPerExecution`/`maxCreditsPerTask`
  (already in schema, `schema.prisma:694-695`).
- Produces: `CreditLimitsService.checkAndReserveEmployeeBudget` gains a required `costKind:
  'EXECUTION' | 'TASK'` field on its input — every caller in the codebase (there are exactly 3)
  must be updated in this task.

- [ ] **Step 1: Write the failing unit test**

```typescript
// apps/api/src/modules/credits/credit-limits.service.spec.ts
import {
  CreditLimitsService,
  EmployeeExecutionCeilingExceededError,
  EmployeeTaskCeilingExceededError,
  EmployeeBudgetExceededError,
} from './credit-limits.service';

function makePrisma(employee: {
  budgetLimit: number | null;
  maxCreditsPerExecution: number | null;
  maxCreditsPerTask: number | null;
}) {
  const findUniqueOrThrow = jest.fn().mockResolvedValue(employee);
  const findUnique = jest.fn().mockResolvedValue(null);
  const create = jest.fn().mockResolvedValue({
    spent: 0,
    budgetLimitSnapshot: employee.budgetLimit,
  });
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    aiEmployee: { findUniqueOrThrow },
    employeeCreditPeriodCounter: { findUnique, create, updateMany },
  } as unknown as import('../../common/prisma/prisma.service').PrismaService;
  return { prisma, findUniqueOrThrow, updateMany };
}

describe('CreditLimitsService — per-execution/per-task ceilings', () => {
  it('blocks an EXECUTION over maxCreditsPerExecution without touching the monthly counter', async () => {
    const { prisma, updateMany } = makePrisma({
      budgetLimit: null,
      maxCreditsPerExecution: 50,
      maxCreditsPerTask: null,
    });
    const service = new CreditLimitsService(prisma);

    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 75,
        costKind: 'EXECUTION',
      }),
    ).rejects.toThrow(EmployeeExecutionCeilingExceededError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('blocks a TASK over maxCreditsPerTask', async () => {
    const { prisma } = makePrisma({
      budgetLimit: null,
      maxCreditsPerExecution: null,
      maxCreditsPerTask: 10,
    });
    const service = new CreditLimitsService(prisma);

    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 11,
        costKind: 'TASK',
      }),
    ).rejects.toThrow(EmployeeTaskCeilingExceededError);
  });

  it('allows a cost at or under the ceiling, and a null ceiling is unlimited', async () => {
    const { prisma } = makePrisma({
      budgetLimit: null,
      maxCreditsPerExecution: 50,
      maxCreditsPerTask: null,
    });
    const service = new CreditLimitsService(prisma);

    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 50,
        costKind: 'EXECUTION',
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 999,
        costKind: 'TASK',
      }),
    ).resolves.toBeUndefined();
  });

  it('an EXECUTION-ceiling pass still runs the existing monthly-budget check afterward', async () => {
    const { prisma, updateMany } = makePrisma({
      budgetLimit: 1, // $1 → 100 credits at DEFAULT_CREDITS_PER_USD
      maxCreditsPerExecution: 200,
      maxCreditsPerTask: null,
    });
    const service = new CreditLimitsService(prisma);

    updateMany.mockResolvedValueOnce({ count: 0 }); // simulate monthly budget exhausted
    await expect(
      service.checkAndReserveEmployeeBudget({
        employeeId: 'emp_1',
        companyId: 'co_1',
        cost: 50,
        costKind: 'EXECUTION',
      }),
    ).rejects.toThrow(EmployeeBudgetExceededError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @vaep/api exec jest credit-limits.service.spec.ts`
Expected: FAIL — `checkAndReserveEmployeeBudget` doesn't accept `costKind` yet and never throws
either ceiling error (TypeScript will also flag the missing property if you typecheck first).

- [ ] **Step 3: Implement the ceiling check in `credit-limits.service.ts`**

Replace the start of `checkAndReserveEmployeeBudget` (lines 96-110 today):

```typescript
  async checkAndReserveEmployeeBudget(input: {
    employeeId: string;
    companyId: string;
    cost: number;
    /**
     * Kill-critic audit gap fix (2026-08-20, round 2) — `maxCreditsPerExecution`/
     * `maxCreditsPerTask` existed since Task 9.8 with an explicit "not yet
     * enforced" comment, and the ceiling error classes below had no caller.
     * Every call site now states which ceiling applies to ITS granularity —
     * a whole AI turn/run vs. one tool call.
     */
    costKind: 'EXECUTION' | 'TASK';
  }): Promise<void> {
    const employee = await this.prisma.aiEmployee.findUniqueOrThrow({
      where: { id: input.employeeId },
      select: {
        budgetLimit: true,
        maxCreditsPerExecution: true,
        maxCreditsPerTask: true,
      },
    });

    const ceiling =
      input.costKind === 'EXECUTION'
        ? employee.maxCreditsPerExecution
        : employee.maxCreditsPerTask;
    if (ceiling != null && input.cost > ceiling) {
      if (input.costKind === 'EXECUTION') {
        throw new EmployeeExecutionCeilingExceededError(input.employeeId, input.cost, ceiling);
      }
      throw new EmployeeTaskCeilingExceededError(input.employeeId, input.cost, ceiling);
    }

    if (employee.budgetLimit == null) {
      return; // unlimited
    }
```

(the rest of the method — `periodStart`, the counter create/guard — is unchanged; it already
starts from `employee.budgetLimit` which is still selected above).

- [ ] **Step 4: Update the 3 call sites**

`apps/api/src/modules/employees/runtime/agent-runtime.service.ts:408-412` (a whole AI-employee
turn):

```typescript
            await this.creditLimits.checkAndReserveEmployeeBudget({
              employeeId: employee.id,
              companyId,
              cost: priced.credits,
              costKind: 'EXECUTION',
            });
```

`apps/api/src/modules/workflows/engine/nodes/ai-step.handler.ts:157-161` (one AI_STEP node — a
full LLM call, same granularity as an agent turn):

```typescript
            await this.creditLimits.checkAndReserveEmployeeBudget({
              employeeId,
              companyId,
              cost: priced.credits,
              costKind: 'EXECUTION',
            });
```

`apps/api/src/modules/skills/skills.service.ts:699-703` (one tool call):

```typescript
              await this.creditLimits.checkAndReserveEmployeeBudget({
                employeeId: ctx.employeeId,
                companyId: ctx.companyId,
                cost: priced.credits,
                costKind: 'TASK',
              });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @vaep/api exec jest credit-limits.service.spec.ts`
Expected: PASS (all 4 cases)

- [ ] **Step 6: Write the failing retry-classification test**

Add to `apps/api/src/modules/workflow-runtime/retry-policy.service.spec.ts`'s `it.each` table
(after the existing `WORKFLOW_LIMIT_EXCEEDED` row):

```typescript
      [
        'Tool postiz/schedule_post did not succeed: would cost 75 credits, over its configured per-execution ceiling of 50 — lower the request\'s scope or raise the employee\'s "Max credits / execution" setting.',
        'EMPLOYEE_EXECUTION_CEILING_EXCEEDED',
        false,
      ],
      [
        'Tool postiz/schedule_post did not succeed: This task would cost 11 credits, over this employee\'s configured per-task ceiling of 10.',
        'EMPLOYEE_TASK_CEILING_EXCEEDED',
        false,
      ],
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @vaep/api exec jest retry-policy.service.spec.ts`
Expected: FAIL — `FailureClass` has no such members yet, both messages fall through to
`NODE_ERROR` (retryable: true), mismatching the expected `false`.

- [ ] **Step 8: Add the two failure classes to `retry-policy.service.ts`**

```typescript
import { InsufficientCreditsError } from '../credits/credit-ledger.service';
import {
  EmployeeBudgetExceededError,
  WorkflowLimitExceededError,
  EmployeeExecutionCeilingExceededError,
  EmployeeTaskCeilingExceededError,
} from '../credits/credit-limits.service';
```

In the `FailureClass` union, after `'WORKFLOW_LIMIT_EXCEEDED'`:

```typescript
  | 'WORKFLOW_LIMIT_EXCEEDED'
  /** Kill-critic gap fix (2026-08-20, round 2) — a single execution/task cost more than the employee's own configured ceiling, independent of the monthly budget. */
  | 'EMPLOYEE_EXECUTION_CEILING_EXCEEDED'
  | 'EMPLOYEE_TASK_CEILING_EXCEEDED'
```

In `isRetryable`'s non-retryable case list, alongside `'WORKFLOW_LIMIT_EXCEEDED'`:

```typescript
      case 'EMPLOYEE_BUDGET_EXCEEDED':
      case 'WORKFLOW_LIMIT_EXCEEDED':
      case 'EMPLOYEE_EXECUTION_CEILING_EXCEEDED':
      case 'EMPLOYEE_TASK_CEILING_EXCEEDED':
        return false;
```

In `classifyError`, add `instanceof` checks alongside the existing two:

```typescript
    if (error instanceof EmployeeBudgetExceededError) return 'EMPLOYEE_BUDGET_EXCEEDED';
    if (error instanceof WorkflowLimitExceededError) return 'WORKFLOW_LIMIT_EXCEEDED';
    if (error instanceof EmployeeExecutionCeilingExceededError) return 'EMPLOYEE_EXECUTION_CEILING_EXCEEDED';
    if (error instanceof EmployeeTaskCeilingExceededError) return 'EMPLOYEE_TASK_CEILING_EXCEEDED';
```

And string-fallback patterns (same TOOL_ACTION re-wrap reasoning as the existing
`'run out of credits'`/`'configured credit limit'` patterns just above them):

```typescript
    if (lower.includes('configured credit limit')) {
      return 'WORKFLOW_LIMIT_EXCEEDED';
    }
    if (lower.includes('per-execution ceiling')) {
      return 'EMPLOYEE_EXECUTION_CEILING_EXCEEDED';
    }
    if (lower.includes('per-task ceiling')) {
      return 'EMPLOYEE_TASK_CEILING_EXCEEDED';
    }
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @vaep/api exec jest retry-policy.service.spec.ts`
Expected: PASS (all cases, including the 2 new ones)

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/credits/credit-limits.service.ts \
        apps/api/src/modules/credits/credit-limits.service.spec.ts \
        apps/api/src/modules/employees/runtime/agent-runtime.service.ts \
        apps/api/src/modules/workflows/engine/nodes/ai-step.handler.ts \
        apps/api/src/modules/skills/skills.service.ts \
        apps/api/src/modules/workflow-runtime/retry-policy.service.ts \
        apps/api/src/modules/workflow-runtime/retry-policy.service.spec.ts
git commit -m "fix: enforce AiEmployee per-execution/per-task credit ceilings (were stored, never checked)"
```

---

### Task 3: PlanGuard must check subscription status, not just tier

**Files:**
- Modify: `apps/api/src/modules/billing/plan.guard.ts`
- Modify: `apps/api/src/modules/billing/plan.guard.spec.ts`

**Interfaces:**
- Consumes: `BillingService.getSubscription(companyId): Promise<SubscriptionDto>` (unchanged;
  `SubscriptionDto.status` already exists — `billing.service.ts:72`, `:483`).
- Produces: no signature change — `PlanGuard.canActivate` behavior only.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/modules/billing/plan.guard.spec.ts` (and update the two existing
`getSubscription` mocks that omit `status` to include `status: 'ACTIVE'`, so they keep testing
the tier check specifically rather than accidentally passing through an `undefined` status):

```typescript
  it('throws ForbiddenException for a PAST_DUE company even when its plan matches', async () => {
    const reflector = {
      getAllAndOverride: () => ['BUSINESS', 'ENTERPRISE'],
    } as unknown as Reflector;
    const billing = {
      getSubscription: jest
        .fn()
        .mockResolvedValue({ plan: 'BUSINESS', status: 'PAST_DUE' } as SubscriptionDto),
    } as unknown as BillingService;
    const guard = new PlanGuard(reflector, billing);

    await expect(guard.canActivate(makeContext('co_1'))).rejects.toThrow(ForbiddenException);
  });
```

And update the existing "throws ForbiddenException when the company plan is not in the allowed
list" test's mock to `{ plan: 'STARTER', status: 'ACTIVE' } as SubscriptionDto`, and the "allows a
company whose plan is in the allowed list" test's mock to `{ plan: 'BUSINESS', status: 'ACTIVE' }
as SubscriptionDto`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @vaep/api exec jest plan.guard.spec.ts`
Expected: FAIL — the new PAST_DUE test resolves `true` today (status is never checked).

- [ ] **Step 3: Implement the status check in `plan.guard.ts`**

```typescript
    const subscription = await this.billing.getSubscription(companyId);
    if (subscription.status !== 'ACTIVE') {
      throw new ForbiddenException(
        `Your subscription is ${subscription.status.replace('_', ' ').toLowerCase()} — resolve billing before using this feature.`,
      );
    }
    if (!allowed.includes(subscription.plan)) {
      throw new ForbiddenException(
        `This feature requires the ${allowed.join(' or ')} plan`,
      );
    }
    return true;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @vaep/api exec jest plan.guard.spec.ts`
Expected: PASS (all 4 cases)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/billing/plan.guard.ts apps/api/src/modules/billing/plan.guard.spec.ts
git commit -m "fix: PlanGuard now blocks PAST_DUE/CANCELLED subscriptions, not just wrong-tier ones"
```

---

### Task 4: Consolidate the duplicate plan-tier ranking logic

**Files:**
- Modify: `apps/api/src/modules/billing/billing.plans.ts`
- Create: `apps/api/src/modules/billing/billing.plans.spec.ts`
- Modify: `apps/api/src/modules/workflow-templates/workflow-templates.service.ts`

**Interfaces:**
- Produces: `planMeetsMinimum(plan: Plan, minPlan: Plan): boolean` exported from
  `billing.plans.ts` — the one canonical plan-rank comparison. (`subscription-credit-renewal.service.ts:58`'s
  direct `PLAN_CATALOG[sub.plan].includedCreditsPerMonth` read is a catalog *lookup*, not a rank
  *comparison* — it already reads the canonical source directly and is left alone.)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/billing/billing.plans.spec.ts
import { planMeetsMinimum } from './billing.plans';

describe('planMeetsMinimum', () => {
  it('a plan meets its own tier', () => {
    expect(planMeetsMinimum('BUSINESS', 'BUSINESS')).toBe(true);
  });

  it('a higher plan meets a lower minimum', () => {
    expect(planMeetsMinimum('ENTERPRISE', 'PRO')).toBe(true);
  });

  it('a lower plan does not meet a higher minimum', () => {
    expect(planMeetsMinimum('STARTER', 'BUSINESS')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @vaep/api exec jest billing.plans.spec.ts`
Expected: FAIL — `planMeetsMinimum` doesn't exist yet.

- [ ] **Step 3: Add the canonical helper to `billing.plans.ts`**

Append to the end of the file:

```typescript
const PLAN_RANK: Record<Plan, number> = {
  STARTER: 0,
  PRO: 1,
  BUSINESS: 2,
  ENTERPRISE: 3,
};

/**
 * The single canonical plan-tier comparison — kill-critic gap fix (2026-08-20):
 * `workflow-templates.service.ts` previously kept its own copy of this exact
 * table (`PLAN_RANK`) rather than importing from here, the source of truth
 * for plan tier order.
 */
export function planMeetsMinimum(plan: Plan, minPlan: Plan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[minPlan];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @vaep/api exec jest billing.plans.spec.ts`
Expected: PASS

- [ ] **Step 5: Remove the duplicate in `workflow-templates.service.ts`**

Delete the local table (lines 35-40):

```typescript
const PLAN_RANK: Record<Plan, number> = {
  STARTER: 0,
  PRO: 1,
  BUSINESS: 2,
  ENTERPRISE: 3,
};
```

Add to the existing import block from `./workflow-templates.util` area — a new import:

```typescript
import { planMeetsMinimum } from '../billing/billing.plans';
```

Replace the comparison (around line 387):

```typescript
      if (!planMeetsMinimum(current, requires.minPlan)) {
        missingPlan = requires.minPlan;
      }
```

- [ ] **Step 6: Run the full workflow-templates e2e suite to confirm no behavior change**

Run: `cd apps/api && pnpm test -- workflow-templates.e2e-spec`
Expected: PASS, same as before this task (the comparison semantics are identical — this is a
pure refactor, so the existing prereq-check 422 e2e coverage is the regression guard; no new e2e
case is needed since no new behavior was added).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/billing/billing.plans.ts \
        apps/api/src/modules/billing/billing.plans.spec.ts \
        apps/api/src/modules/workflow-templates/workflow-templates.service.ts
git commit -m "refactor: one canonical planMeetsMinimum helper instead of a second PLAN_RANK copy"
```

---

### Task 5: Customer-facing included-vs-purchased balance split

**Files:**
- Modify: `packages/types/src/credits.ts`
- Modify: `apps/api/src/modules/credits/credit-balance.service.ts`
- Modify: `apps/api/src/modules/billing/billing.controller.ts`
- Test (new): `apps/api/src/modules/credits/credit-balance.service.spec.ts`

**Interfaces:**
- Produces: `CreditBalanceService.getLotBalanceBreakdown(companyId: string): Promise<{
  includedBalance: number; purchasedBalance: number }>`. `CreditBalanceDto` gains
  `includedBalance`/`purchasedBalance` fields.

- [ ] **Step 1: Write the failing unit test**

```typescript
// apps/api/src/modules/credits/credit-balance.service.spec.ts
import { Prisma } from '@prisma/client';
import { CreditBalanceService } from './credit-balance.service';

describe('CreditBalanceService.getLotBalanceBreakdown', () => {
  it('sums PACK_PURCHASE lots as purchasedBalance and everything else as includedBalance', async () => {
    const groupBy = jest.fn().mockResolvedValue([
      { grantKind: 'PACK_PURCHASE', _sum: { remaining: new Prisma.Decimal(500) } },
      { grantKind: 'PLAN_ALLOTMENT', _sum: { remaining: new Prisma.Decimal(300) } },
      { grantKind: 'PROMOTIONAL', _sum: { remaining: new Prisma.Decimal(200) } },
    ]);
    const prisma = {
      creditLot: { groupBy },
    } as unknown as import('../../common/prisma/prisma.service').PrismaService;
    const service = new CreditBalanceService(prisma, {} as import('./credit-ledger.service').CreditLedgerService);

    const result = await service.getLotBalanceBreakdown('co_1');

    expect(groupBy).toHaveBeenCalledWith({
      by: ['grantKind'],
      where: { companyId: 'co_1', remaining: { gt: 0 } },
      _sum: { remaining: true },
    });
    expect(result).toEqual({ includedBalance: 500, purchasedBalance: 500 });
  });

  it('returns zeros when the company has no active lots', async () => {
    const groupBy = jest.fn().mockResolvedValue([]);
    const prisma = {
      creditLot: { groupBy },
    } as unknown as import('../../common/prisma/prisma.service').PrismaService;
    const service = new CreditBalanceService(prisma, {} as import('./credit-ledger.service').CreditLedgerService);

    await expect(service.getLotBalanceBreakdown('co_1')).resolves.toEqual({
      includedBalance: 0,
      purchasedBalance: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @vaep/api exec jest credit-balance.service.spec.ts`
Expected: FAIL — `getLotBalanceBreakdown` doesn't exist yet.

- [ ] **Step 3: Implement `getLotBalanceBreakdown` in `credit-balance.service.ts`**

Add after `getTrailingMonthlyDebits`:

```typescript
  /**
   * Phase 9 kill-critic gap fix — `GET /billing/credits` returned only the
   * single fungible `balance`; a customer asking "how much of that is
   * credits I bought vs. credits my plan gave me" had no answer.
   * `CreditLot.remaining` is the same per-grant shrinking pool the expiry
   * sweep already maintains, so this is a read, not a new accounting
   * mechanism — and it is purely additive: it can drift from `balance` only
   * as much as `balance` itself can drift from the ledger sum, which the
   * existing nightly `reconcile()` already corrects.
   */
  async getLotBalanceBreakdown(
    companyId: string,
  ): Promise<{ includedBalance: number; purchasedBalance: number }> {
    const rows = await this.prisma.creditLot.groupBy({
      by: ['grantKind'],
      where: { companyId, remaining: { gt: 0 } },
      _sum: { remaining: true },
    });
    let includedBalance = 0;
    let purchasedBalance = 0;
    for (const row of rows) {
      const amount = decimalToNumber(row._sum.remaining ?? new Prisma.Decimal(0));
      if (row.grantKind === 'PACK_PURCHASE') {
        purchasedBalance += amount;
      } else {
        includedBalance += amount;
      }
    }
    return { includedBalance, purchasedBalance };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @vaep/api exec jest credit-balance.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Add the fields to `CreditBalanceDto` in `packages/types/src/credits.ts`**

```typescript
export interface CreditBalanceDto {
  companyId: string;
  balance: number;
  reservedBalance: number;
  lastReconciledAt: string | null;
  updatedAt: string;
  trailingMonthlyDebits: number;
  /**
   * Additive breakdown of `balance` by grant origin (PACK_PURCHASE vs.
   * everything else — plan allotments, promos, enterprise, manual admin).
   * May not sum to exactly `balance` if a lot record and the balance cache
   * have ever drifted; `balance` is always the authoritative spendable
   * figure, this is presentation only.
   */
  includedBalance: number;
  purchasedBalance: number;
}
```

- [ ] **Step 6: Wire it into `billing.controller.ts`'s `credits()` endpoint**

```typescript
  @Get('credits')
  async credits(@CurrentTenant() companyId: string): Promise<CreditBalanceDto> {
    const [snapshot, trailingMonthlyDebits, lotBreakdown] = await Promise.all([
      this.creditBalance.getBalance(companyId),
      this.creditBalance.getTrailingMonthlyDebits(companyId),
      this.creditBalance.getLotBalanceBreakdown(companyId),
    ]);
    return {
      companyId: snapshot.companyId,
      balance: snapshot.balance,
      reservedBalance: snapshot.reservedBalance,
      lastReconciledAt: snapshot.lastReconciledAt?.toISOString() ?? null,
      updatedAt: snapshot.updatedAt.toISOString(),
      trailingMonthlyDebits,
      includedBalance: lotBreakdown.includedBalance,
      purchasedBalance: lotBreakdown.purchasedBalance,
    };
  }
```

- [ ] **Step 7: Rebuild `@vaep/types` and typecheck `apps/api`**

Run: `pnpm --filter @vaep/types build && pnpm --filter @vaep/api exec tsc --noEmit -p tsconfig.json`
Expected: no errors (any other consumer of `CreditBalanceDto` that builds the object literal
directly, e.g. test fixtures, will now show a missing-property error — fix those fixtures by
adding the two fields).

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/credits.ts \
        apps/api/src/modules/credits/credit-balance.service.ts \
        apps/api/src/modules/credits/credit-balance.service.spec.ts \
        apps/api/src/modules/billing/billing.controller.ts
git commit -m "feat: split GET /billing/credits balance into included vs purchased"
```

---

### Task 6: Per-employee / per-workflow usage summary endpoint

**Files:**
- Modify: `packages/types/src/credits.ts`
- Modify: `apps/api/src/modules/credits/credit-ledger.service.ts`
- Modify: `apps/api/src/modules/billing/billing.controller.ts`
- Test (new): `apps/api/src/modules/credits/credit-ledger.service.spec.ts`

**Interfaces:**
- Consumes: nothing new — reads existing `CreditLedger` rows via `groupBy`.
- Produces: `CreditLedgerService.summarizeDebits(input: { companyId: string; since: Date; until:
  Date }): Promise<{ byEmployee: Array<{ employeeId: string; totalDebited: number }>; byWorkflow:
  Array<{ workflowId: string; totalDebited: number }> }>`. New DTO `CreditUsageSummaryDto`.

- [ ] **Step 1: Write the failing unit test**

```typescript
// apps/api/src/modules/credits/credit-ledger.service.spec.ts
import { Prisma } from '@prisma/client';
import { CreditLedgerService } from './credit-ledger.service';

describe('CreditLedgerService.summarizeDebits', () => {
  it('groups DEBIT rows by employee and by workflow, flipping the stored-negative sign to a positive spend figure', async () => {
    const groupBy = jest
      .fn()
      .mockResolvedValueOnce([
        { employeeId: 'emp_1', _sum: { amount: new Prisma.Decimal(-420) } },
        { employeeId: 'emp_2', _sum: { amount: new Prisma.Decimal(-80) } },
      ])
      .mockResolvedValueOnce([
        { workflowId: 'wf_1', _sum: { amount: new Prisma.Decimal(-160) } },
      ]);
    const prisma = {
      creditLedger: { groupBy },
    } as unknown as import('../../common/prisma/prisma.service').PrismaService;
    const metrics = {} as import('../../common/observability/metrics.registry').MetricsRegistry;
    const service = new CreditLedgerService(prisma, metrics);

    const since = new Date('2026-07-21T00:00:00.000Z');
    const until = new Date('2026-08-20T00:00:00.000Z');
    const result = await service.summarizeDebits({ companyId: 'co_1', since, until });

    expect(result.byEmployee).toEqual([
      { employeeId: 'emp_1', totalDebited: 420 },
      { employeeId: 'emp_2', totalDebited: 80 },
    ]);
    expect(result.byWorkflow).toEqual([{ workflowId: 'wf_1', totalDebited: 160 }]);
    expect(groupBy).toHaveBeenNthCalledWith(1, {
      by: ['employeeId'],
      where: {
        companyId: 'co_1',
        transactionType: 'DEBIT',
        employeeId: { not: null },
        createdAt: { gte: since, lte: until },
      },
      _sum: { amount: true },
    });
  });
});
```

(Check `CreditLedgerService`'s real constructor signature — it takes `(prisma, metrics)` per
`credit-ledger.service.ts:1-10`'s imports; if a wider `AuditLogService` or similar dependency was
added since this plan was written, mock it the same way as `metrics` above.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @vaep/api exec jest credit-ledger.service.spec.ts`
Expected: FAIL — `summarizeDebits` doesn't exist yet.

- [ ] **Step 3: Implement `summarizeDebits` in `credit-ledger.service.ts`**

Add near `listEntries`:

```typescript
  /**
   * Phase 9 kill-critic gap fix — `GET /billing/credits/usage` returns flat,
   * filterable rows only; there was no grouped "spend per employee" / "spend
   * per workflow" total anywhere, so the Usage page could not answer "which
   * employee is costing us the most this month" without the customer
   * summing rows themselves.
   */
  async summarizeDebits(input: {
    companyId: string;
    since: Date;
    until: Date;
  }): Promise<{
    byEmployee: Array<{ employeeId: string; totalDebited: number }>;
    byWorkflow: Array<{ workflowId: string; totalDebited: number }>;
  }> {
    const [byEmployeeRows, byWorkflowRows] = await Promise.all([
      this.prisma.creditLedger.groupBy({
        by: ['employeeId'],
        where: {
          companyId: input.companyId,
          transactionType: 'DEBIT',
          employeeId: { not: null },
          createdAt: { gte: input.since, lte: input.until },
        },
        _sum: { amount: true },
      }),
      this.prisma.creditLedger.groupBy({
        by: ['workflowId'],
        where: {
          companyId: input.companyId,
          transactionType: 'DEBIT',
          workflowId: { not: null },
          createdAt: { gte: input.since, lte: input.until },
        },
        _sum: { amount: true },
      }),
    ]);
    // DEBIT amounts are stored negative (same convention
    // credit-balance.service.ts's getTrailingMonthlyDebits already flips) —
    // flip so the customer-facing figure reads as a positive spend total.
    return {
      byEmployee: byEmployeeRows.map((r) => ({
        employeeId: r.employeeId as string,
        totalDebited: Math.abs(decimalToNumber(r._sum.amount ?? new Prisma.Decimal(0))),
      })),
      byWorkflow: byWorkflowRows.map((r) => ({
        workflowId: r.workflowId as string,
        totalDebited: Math.abs(decimalToNumber(r._sum.amount ?? new Prisma.Decimal(0))),
      })),
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @vaep/api exec jest credit-ledger.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Add `CreditUsageSummaryDto` to `packages/types/src/credits.ts`**

```typescript
export interface CreditUsageSummaryDto {
  companyId: string;
  since: string;
  until: string;
  byEmployee: Array<{ employeeId: string; totalDebited: number }>;
  byWorkflow: Array<{ workflowId: string; totalDebited: number }>;
}
```

- [ ] **Step 6: Add the endpoint to `billing.controller.ts`**

```typescript
  /**
   * Credit system kill-critic gap fix — grouped totals the row-level
   * `/credits/usage` ledger never provided. Defaults to the trailing 30
   * days, matching `getTrailingMonthlyDebits`'s window.
   */
  @Get('credits/usage/summary')
  @Roles('OWNER', 'ADMIN')
  async creditsUsageSummary(
    @CurrentTenant() companyId: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ): Promise<CreditUsageSummaryDto> {
    const untilDate = until ? new Date(until) : new Date();
    const sinceDate = since
      ? new Date(since)
      : new Date(untilDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const summary = await this.creditLedger.summarizeDebits({
      companyId,
      since: sinceDate,
      until: untilDate,
    });
    return {
      companyId,
      since: sinceDate.toISOString(),
      until: untilDate.toISOString(),
      ...summary,
    };
  }
```

Add `CreditUsageSummaryDto` to the `@vaep/types` import list at the top of `billing.controller.ts`.

- [ ] **Step 7: Rebuild `@vaep/types` and typecheck**

Run: `pnpm --filter @vaep/types build && pnpm --filter @vaep/api exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/credits.ts \
        apps/api/src/modules/credits/credit-ledger.service.ts \
        apps/api/src/modules/credits/credit-ledger.service.spec.ts \
        apps/api/src/modules/billing/billing.controller.ts
git commit -m "feat: add GET /billing/credits/usage/summary grouped by employee and workflow"
```

- [ ] **Step 9: Run the full e2e suite in both engine modes (last task only — per project convention)**

Run: `cd apps/api && pnpm test && WORKFLOW_ENGINE_MODE=legacy_walk pnpm test`
Expected: PASS, same count as before this plan (Tasks 1-6 touch no engine behavior other than
Task 2's new non-retryable failure classes, which only ever fire when a ceiling that was
previously silently ignored is actually configured — no existing e2e fixture sets
`maxCreditsPerExecution`/`maxCreditsPerTask`, so no existing test's outcome changes).

---

## Explicitly not in this plan

- **Gap 5 (task-level estimated credit ranges)** and **Gap 6 (enterprise department budgets)** —
  both DEFERRED per the audit; no task above touches them. Gap 6's prerequisite
  (`AiEmployee.departmentId` FK) is a separate, larger, already-known-deferred item.
- **Gap 1's actual dollar figures** — Task 1 above produces the decision record, not a number;
  nothing in Tasks 2-6 depends on the figures being finalized.
- **A runtime guard blocking `CREDIT_ENFORCEMENT_ENABLED` while `FOUNDER-PENDING` markers remain**
  — considered and rejected as unnecessary complexity: the existing per-company allowlist
  (`credit-config.ts:82-86`) is a deliberate manual gate from Phase 12's rollout runbook, and
  no company has been enrolled in it yet.
