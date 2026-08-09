import { createContext } from 'react';
import type { StepRunStatus, WorkflowStepRunDto } from '@vaep/types';

/** nodeId → latest step status, shared with node cards via context (no rebuild). */
export type RunStatusMap = Map<string, StepRunStatus>;

export const RunOverlayContext = createContext<RunStatusMap | null>(null);

/**
 * Collapse a run's steps to one status per node (last write wins, so a retried
 * node shows its newest attempt). Pure + unit-tested — the canvas passes the
 * result through context so per-poll status updates don't rebuild the graph.
 */
export function stepStatusByNodeId(
  steps: WorkflowStepRunDto[] | undefined,
): RunStatusMap {
  const map: RunStatusMap = new Map();
  for (const step of steps ?? []) {
    map.set(step.nodeId, step.status);
  }
  return map;
}

// Literal dot classes per step status (Tailwind JIT), mapped onto the status-*
// tokens. RUNNING pulses so an in-flight node is obvious at a glance.
export const STEP_DOT: Record<StepRunStatus, string> = {
  PENDING: 'bg-status-pending',
  RUNNING: 'bg-status-running animate-pulse',
  COMPLETED: 'bg-status-succeeded',
  FAILED: 'bg-status-failed',
  SKIPPED: 'bg-status-cancelled',
  RETRYING: 'bg-status-escalated animate-pulse',
  WAITING: 'bg-status-waiting',
  COMPENSATED: 'bg-status-escalated',
};
