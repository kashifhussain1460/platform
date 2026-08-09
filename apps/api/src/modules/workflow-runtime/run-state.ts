import type { StepRunStatus, WorkflowRunStatus } from '@vaep/types';

/**
 * P1-04 — the run/step state machine (doc 16 §7).
 *
 * Today the legacy engine writes `status` in roughly ten scattered places, none
 * of them guarded. Nothing stops a COMPLETED run being flipped back to RUNNING
 * by a late job, and when that happens there is no error — just a run in a state
 * nobody can explain later.
 *
 * These tables make the legal transitions explicit and make every illegal one
 * THROW. Terminal states have an empty array, which is what turns "a COMPLETED
 * run can never be reopened" from a convention into a mechanical guarantee.
 */

export class IllegalStateTransitionError extends Error {
  constructor(
    readonly entity: 'run' | 'step',
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} → ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

export const RUN_TRANSITIONS: Readonly<
  Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>
> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: [
    'WAITING',
    'COMPLETED',
    'FAILED',
    'TIMED_OUT',
    'CANCELLED',
    'COMPENSATING',
  ],
  // A WAITING run resumes (timer fired / approval decided), or ends.
  WAITING: ['RUNNING', 'FAILED', 'TIMED_OUT', 'CANCELLED'],
  // Compensation is a one-way street: it can only finish or be abandoned.
  COMPENSATING: ['FAILED', 'CANCELLED'],
  // Terminal.
  COMPLETED: [],
  FAILED: [],
  TIMED_OUT: [],
  CANCELLED: [],
};

export const STEP_TRANSITIONS: Readonly<
  Record<StepRunStatus, readonly StepRunStatus[]>
> = {
  PENDING: ['RUNNING', 'SKIPPED', 'WAITING'],
  RUNNING: ['COMPLETED', 'FAILED', 'RETRYING', 'WAITING', 'SKIPPED'],
  RETRYING: ['RUNNING', 'FAILED'],
  WAITING: ['RUNNING', 'FAILED', 'SKIPPED'],
  // A completed step can still be rolled back by a saga compensation.
  COMPLETED: ['COMPENSATED'],
  // Terminal.
  FAILED: [],
  SKIPPED: [],
  COMPENSATED: [],
};

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function isTerminalStepStatus(status: StepRunStatus): boolean {
  return STEP_TRANSITIONS[status].length === 0;
}

export function canTransitionRun(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionStep(
  from: StepRunStatus,
  to: StepRunStatus,
): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

/**
 * Throws rather than silently no-op'ing. A silent no-op here is precisely how a
 * run ends up in a state that cannot be explained from the audit trail — the
 * write "succeeds", nothing is logged, and the bug surfaces days later as a
 * stuck run.
 */
export function assertRunTransition(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
): void {
  if (!canTransitionRun(from, to)) {
    throw new IllegalStateTransitionError('run', from, to);
  }
}

export function assertStepTransition(
  from: StepRunStatus,
  to: StepRunStatus,
): void {
  if (!canTransitionStep(from, to)) {
    throw new IllegalStateTransitionError('step', from, to);
  }
}
