import type { EmployeeStatus } from '@prisma/client';

/**
 * Employee lifecycle enforcement for the workflow engine.
 *
 * ## The gap this closes
 *
 * Pausing, disabling or archiving an AI Employee did NOT stop workflow
 * execution. The only status check in the whole codebase gated **chat**
 * (`agent-runtime.service.ts`), so a paused employee's scheduled and
 * event-triggered workflows kept creating runs and kept executing with that
 * employee's persona, model, budget and skill connections. The
 * `EmployeeCard` "Remove" button's own copy — *"It will stop working
 * immediately"* — was factually false for any employee still referenced by an
 * ACTIVE workflow.
 *
 * Worse, `TOOL_ACTION` — the one node type with `hasSideEffects`, i.e. the one
 * that sends email, posts publicly and charges cards — never queried
 * `AiEmployee` at all, so there was nothing between "employee paused" and
 * "irreversible side effect executes as that employee".
 *
 * ## Why a pure rule plus a typed error
 *
 * This file is deliberately shaped like `authorization.policy.ts`,
 * `workflow-readiness.ts` and `billing.plans.ts`: a pure decision with a thin
 * I/O shell around it. It has no Nest decorators and imports only a Prisma
 * *type*, so `retry-policy.service.ts` (a different module) can import the
 * error class without a dependency edge.
 *
 * Each call site keeps its own `select` — the handlers select genuinely
 * different columns, and forcing them onto one widest shape would lose Prisma's
 * generated types. `assertEmployeeWorkable` is therefore generic over anything
 * that carries the four lifecycle columns.
 *
 * ## Why BOTH status and archivedAt
 *
 * `remove()` sets `status: 'DISABLED'` **and** `archivedAt` together, so today
 * an archived employee is also disabled. But `PATCH /employees/:id` writes
 * `status` with no transition validation and **without clearing `archivedAt`**,
 * and `findOwnedEmployee` does not filter `archivedAt` — so
 * `PATCH { status: 'ACTIVE' }` on an archived employee yields a row that is
 * ACTIVE with `archivedAt` still set: invisible in the roster, fully "active" to
 * any check that reads only `status`. Checking one field is not enough.
 */

/** The lifecycle columns every execution-path lookup must now select. */
export interface EmployeeLifecycleState {
  id: string;
  name: string;
  status: EmployeeStatus;
  archivedAt: Date | null;
}

export type NotWorkableReason = 'PAUSED' | 'DISABLED' | 'ARCHIVED' | 'MISSING';

/**
 * Thrown when a node names an AI Employee that cannot work.
 *
 * Its own class so `RetryPolicyService.classifyError` can classify it by
 * `instanceof` rather than by message text — the same reason
 * `EmployeeBudgetExceededError` is a class. Message-substring classification
 * would be doubly wrong here: the sentence is customer-facing copy that will be
 * reworded, and "employee is paused" is a lifecycle decision that retrying can
 * never change.
 */
export class EmployeeNotWorkableError extends Error {
  constructor(
    readonly employeeId: string,
    readonly nodeId: string | null,
    readonly reason: NotWorkableReason,
    readonly employeeName: string | null,
  ) {
    super(employeeNotWorkableMessage(reason, employeeName, nodeId));
    this.name = 'EmployeeNotWorkableError';
  }
}

/**
 * Plain-language failure text. Names the employee, its state and the fix,
 * because this lands in `WorkflowRun.error` and is rendered verbatim on the run
 * page by `RunFailureCard` — an operator reading it should not have to guess.
 */
export function employeeNotWorkableMessage(
  reason: NotWorkableReason,
  employeeName: string | null,
  nodeId: string | null,
): string {
  const who = employeeName ? `"${employeeName}"` : 'the assigned AI Employee';
  const step = nodeId ? `Step "${nodeId}"` : 'This step';
  if (reason === 'MISSING') {
    return (
      `${step} is assigned to an AI Employee that no longer exists. ` +
      `Assign this step to a current AI Employee.`
    );
  }
  if (reason === 'ARCHIVED') {
    return (
      `${step} is assigned to ${who}, which has been archived. ` +
      `Assign this step to a different AI Employee.`
    );
  }
  const state = reason === 'PAUSED' ? 'paused' : 'disabled';
  const undo = reason === 'PAUSED' ? 'Resume' : 'Re-enable';
  return (
    `${step} is assigned to ${who}, which is ${state}. ` +
    `${undo} ${employeeName ? who : 'it'}, or assign this step to a different AI Employee.`
  );
}

/**
 * Pure. `null` in → `'MISSING'` — never a silent fall-through.
 *
 * `archivedAt` is checked FIRST because it is the more specific and more
 * actionable state: an archived employee reads as DISABLED too, and telling a
 * customer "it is disabled" when the real answer is "you archived it" sends
 * them to the wrong control.
 */
export function employeeWorkableReason(
  employee: EmployeeLifecycleState | null | undefined,
): NotWorkableReason | null {
  if (!employee) return 'MISSING';
  if (employee.archivedAt != null) return 'ARCHIVED';
  if (employee.status === 'PAUSED') return 'PAUSED';
  if (employee.status === 'DISABLED') return 'DISABLED';
  return null;
}

/**
 * Narrowing assert for the node handlers.
 *
 * Generic so each call site keeps the exact type of its own `select`. Replaces
 * both the `if (!employee) throw` blocks AND — more importantly — the two
 * fail-OPEN paths: `ai-step.handler.ts` silently degraded a missing employee to
 * a generic "the workflow assistant" persona with no budget check, and
 * `skills.service.ts`'s `if (!employee) return null` meant "no permission
 * denial found", i.e. the tool was allowed.
 */
export function assertEmployeeWorkable<T extends EmployeeLifecycleState>(
  employee: T | null | undefined,
  ctx: { employeeId: string; nodeId?: string | null },
): T {
  const reason = employeeWorkableReason(employee);
  if (reason) {
    throw new EmployeeNotWorkableError(
      ctx.employeeId,
      ctx.nodeId ?? null,
      reason,
      employee?.name ?? null,
    );
  }
  return employee as T;
}

/**
 * The `select` every execution-path employee lookup must include, so a site
 * cannot accidentally omit a lifecycle column and re-open this gap.
 *
 * Spread it into an existing `select` rather than replacing it:
 * `select: { ...EMPLOYEE_LIFECYCLE_SELECT, approvalRules: true }`.
 */
export const EMPLOYEE_LIFECYCLE_SELECT = {
  id: true,
  name: true,
  status: true,
  archivedAt: true,
} as const;
