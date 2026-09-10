import type { EmployeeReadinessDto, EmployeeSetupState } from '@vaep/types';

/**
 * `setupState` badge — answers "can this thing actually do any work?", which
 * `AiEmployee.status` (ACTIVE/PAUSED/DISABLED) never did. See
 * `apps/api/.../readiness/employee-readiness.ts` for why this is derived on
 * every read rather than a fourth status value.
 */
const SETUP_STATE_STYLES: Record<EmployeeSetupState, string> = {
  READY: 'bg-status-active/15 text-sl-active',
  NEEDS_SETUP: 'bg-status-warning/15 text-sl-warning',
  BLOCKED: 'bg-status-failed/15 text-sl-failed',
};

const SETUP_STATE_LABELS: Record<EmployeeSetupState, string> = {
  READY: 'Ready',
  NEEDS_SETUP: 'Needs setup',
  BLOCKED: 'Blocked',
};

export function ReadinessBadge({
  setupState,
}: {
  setupState: EmployeeSetupState;
}) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${SETUP_STATE_STYLES[setupState]}`}
    >
      {SETUP_STATE_LABELS[setupState]}
    </span>
  );
}

/**
 * One line naming the single most important reason this employee isn't fully
 * set up — for a card/list context where there's no room for the full issue
 * list. `null` when there's nothing to say (READY, or still loading).
 *
 * Picks the first BLOCKER over the first WARNING, since a blocker is the
 * reason a workflow using this employee will actually fail.
 */
export function topReadinessMessage(
  readiness: EmployeeReadinessDto | undefined,
): string | null {
  if (!readiness || readiness.issues.length === 0) return null;
  const blocker = readiness.issues.find((i) => i.severity === 'BLOCKER');
  return (blocker ?? readiness.issues[0]).message;
}
