import type {
  EmployeeReadinessCheckDto,
  EmployeeReadinessDto,
  EmployeeReadinessIssueDto,
  EmployeeSetupState,
  EmployeeStatus,
  WorkflowSkillRequirementDto,
} from '@vaep/types';

/**
 * EMPLOYEE READINESS — the pure evaluator behind `GET /employees/:id/readiness`.
 *
 * ## Why this exists
 *
 * Hiring an AI Employee was a single row insert plus a seat check. The employee
 * landed `ACTIVE` immediately with no skills, no connections, no knowledge and
 * no workflows — and the UI showed it the same green `ACTIVE` pill as a fully
 * configured one. "Active" answered "has this row been switched off?", never
 * "can this thing actually do any work?".
 *
 * ## Why DERIVED and not a stored status
 *
 * The obvious shape is more `EmployeeStatus` values (DRAFT / CONFIGURING /
 * PENDING_SETUP / READY). That was deliberately rejected:
 *
 *  - `EmployeeStatus` is load-bearing for **seat accounting** (`checkSeatFor`:
 *    PAUSED occupies a seat, DISABLED frees one) and for the **execution kill
 *    switch** (`engine/employee-lifecycle.ts`). Overloading it with setup
 *    progress couples three unrelated concerns to one column.
 *  - A stored readiness value is wrong the moment a connector drops, a skill is
 *    unassigned, or a plan changes. It would need every one of those paths to
 *    remember to recompute it — and a column that silently goes stale while the
 *    UI keeps rendering it is the exact defect class this codebase keeps
 *    producing ("never treat a DB column as a feature").
 *
 * So this mirrors `workflow-readiness.ts`, which solved the identical problem
 * for workflows: a pure function over already-fetched state, computed on read.
 *
 * ## What it does NOT do
 *
 * It does not gate execution. Execution is gated by
 * `engine/employee-lifecycle.ts` (status/archivedAt) and by the skill/connection
 * layer at call time. This is an honesty surface, not a second enforcement
 * point — two enforcement points that can disagree is how the two-engine
 * approval bug happened.
 */

export interface EmployeeReadinessInput {
  employeeId: string;
  name: string;
  status: EmployeeStatus;
  archivedAt: Date | null;
  /** Skill keys assigned to this employee (EmployeeSkill join). */
  assignedSkillKeys: string[];
  /**
   * Connection state for those skills, from the SAME `SkillRequirementsService`
   * the workflow publish gate uses — so "connected" means the same thing here
   * as it does there rather than becoming a second opinion.
   */
  skillRequirements: WorkflowSkillRequirementDto[];
  /** Workflows whose graph names this employee. */
  workflowCount: number;
  activeWorkflowCount: number;
  /** Documents readable in this employee's role scope (+ shared). */
  knowledgeDocumentCount: number;
  /** False when the employee's own permissions switch knowledge off. */
  knowledgeAccessEnabled: boolean;
}

/**
 * Statuses that mean "this connection is usable right now".
 *
 * `NO_CONNECTION_REQUIRED` is not in this list only because it does not exist
 * yet — the audit found `SkillRequirementsService` reports plain `READY` for
 * every `connection.type: 'none'` skill, including two (chatwoot, plane) that
 * can never actually be connected. When that is fixed, add the new value here
 * rather than widening the test to `!== 'NOT_CONNECTED'`.
 */
const USABLE_CONNECTION_STATUSES = new Set(['READY']);

export function evaluateEmployeeReadiness(
  input: EmployeeReadinessInput,
): EmployeeReadinessDto {
  const issues: EmployeeReadinessIssueDto[] = [];
  const add = (
    code: string,
    severity: EmployeeReadinessIssueDto['severity'],
    message: string,
    skillKey: string | null = null,
  ): void => {
    issues.push({ code, severity, message, skillKey });
  };

  // ── 1. Lifecycle ──────────────────────────────────────────────────────────
  // A BLOCKER, because it is the one thing that genuinely stops all work, and
  // it is the same rule the execution kill switch applies. Archived is reported
  // ahead of the status for the same reason employee-lifecycle.ts does: it is
  // the more specific and more actionable state.
  let statusFailed = false;
  if (input.archivedAt != null) {
    statusFailed = true;
    add(
      'EMPLOYEE_ARCHIVED',
      'BLOCKER',
      `${input.name} has been archived, so it will not run any work. Restore it, or move its workflows to a different AI Employee.`,
    );
  } else if (input.status === 'PAUSED') {
    statusFailed = true;
    add(
      'EMPLOYEE_PAUSED',
      'BLOCKER',
      `${input.name} is paused. Nothing it is assigned to will run until you resume it.`,
    );
  } else if (input.status === 'DISABLED') {
    statusFailed = true;
    add(
      'EMPLOYEE_DISABLED',
      'BLOCKER',
      `${input.name} is disabled. Nothing it is assigned to will run until you re-enable it.`,
    );
  }

  // ── 2. Skills ─────────────────────────────────────────────────────────────
  // Not a blocker: an employee with no skills is a perfectly valid thing to
  // hire — it can still hold a conversation. It just cannot DO anything, and
  // saying so is the whole point of this surface.
  const skillsMissing = input.assignedSkillKeys.length === 0;
  if (skillsMissing) {
    add(
      'NO_SKILLS_ASSIGNED',
      'WARNING',
      `${input.name} has no skills yet, so it can answer questions but cannot take any action. Add a skill to let it do real work.`,
    );
  }

  // ── 3. Connections ────────────────────────────────────────────────────────
  // A skill whose connector is not usable is a REAL failure: the workflow will
  // publish, fire, and fail at the first call. Blocking here is what stops
  // "Active" from meaning "will work".
  const unreadySkillKeys: string[] = [];
  for (const req of input.skillRequirements) {
    if (!input.assignedSkillKeys.includes(req.skillKey)) continue;
    if (!req.requiresConnection) continue;
    if (USABLE_CONNECTION_STATUSES.has(req.status)) continue;
    unreadySkillKeys.push(req.skillKey);
    add(
      'SKILL_NOT_CONNECTED',
      'BLOCKER',
      `${req.displayName} is not connected, so ${input.name} cannot use it yet. Connect it to finish setting this employee up.`,
      req.skillKey,
    );
  }

  // ── 4. Knowledge ──────────────────────────────────────────────────────────
  // Advisory only. Plenty of useful employees need no documents.
  if (input.knowledgeAccessEnabled && input.knowledgeDocumentCount === 0) {
    add(
      'NO_KNOWLEDGE',
      'WARNING',
      `${input.name} can read the knowledge base, but there are no documents it can see yet. Upload one to give it company context.`,
    );
  }

  // ── 5. Workflows ──────────────────────────────────────────────────────────
  // Advisory: chat-only is a legitimate way to use an employee.
  if (input.workflowCount === 0) {
    add(
      'NO_WORKFLOWS',
      'WARNING',
      `${input.name} is not used by any workflow yet, so it only works in chat. Assign it to a workflow to let it work on its own.`,
    );
  } else if (input.activeWorkflowCount === 0) {
    add(
      'NO_ACTIVE_WORKFLOWS',
      'WARNING',
      `${input.name} is only used by workflows that are switched off, so nothing will run automatically.`,
    );
  }

  const ready = issues.every((i) => i.severity !== 'BLOCKER');

  // BLOCKED is reserved for "cannot work at all", which is a lifecycle fact.
  // A connection gap is NEEDS_SETUP (blocking on its own terms — `ready` is
  // false — but the employee itself is fine; its wiring is not). Note `ready`
  // and `setupState` answer different questions on purpose: `ready` is
  // "would every configured thing actually work", `setupState` is the coarse
  // badge the UI renders, and a paused-but-fully-wired employee is READY in
  // neither sense while a fully-wired ACTIVE one with a dead connector is
  // NEEDS_SETUP, not READY, even though nothing about its lifecycle is wrong.
  const setupState: EmployeeSetupState = statusFailed
    ? 'BLOCKED'
    : issues.length === 0
      ? 'READY'
      : 'NEEDS_SETUP';

  const checks: EmployeeReadinessCheckDto[] = [
    {
      key: 'STATUS',
      label: 'Status',
      status: statusFailed ? 'FAIL' : 'PASS',
    },
    {
      key: 'SKILLS',
      label: 'Skills',
      status: skillsMissing ? 'WARN' : 'PASS',
    },
    {
      key: 'CONNECTIONS',
      label: 'Connections',
      status: unreadySkillKeys.length > 0 ? 'FAIL' : 'PASS',
    },
    {
      key: 'KNOWLEDGE',
      label: 'Knowledge',
      status:
        input.knowledgeAccessEnabled && input.knowledgeDocumentCount === 0
          ? 'WARN'
          : 'PASS',
    },
    {
      key: 'WORKFLOWS',
      label: 'Workflows',
      status: input.workflowCount === 0 ? 'WARN' : 'PASS',
    },
  ];

  return {
    employeeId: input.employeeId,
    ready,
    setupState,
    checks,
    issues,
    summary: {
      name: input.name,
      skillKeys: input.assignedSkillKeys,
      unreadySkillKeys,
      workflowCount: input.workflowCount,
      activeWorkflowCount: input.activeWorkflowCount,
      knowledgeDocumentCount: input.knowledgeDocumentCount,
    },
  };
}
