/** BullMQ identifiers for the approval SLA sweep (P3-05 §8.2). */

/** Queue carrying the repeatable approval-SLA sweep. */
export const APPROVAL_SLA_QUEUE = 'approval-sla';

/** Stable scheduler id for `queue.upsertJobScheduler` (idempotent on boot). */
export const APPROVAL_SLA_SCHEDULER = 'approval-sla-scheduler';

/** Job name for a single sweep. */
export const APPROVAL_SLA_SWEEP_JOB = 'approval-sla-sweep';

/** Sweep cadence — 5 min, same as the workflow-run watchdog (doc 08 §8.2.3). */
export const APPROVAL_SLA_SWEEP_EVERY_MS = 5 * 60 * 1000;

/** Max breached rows handled per sweep tick (keeps one tick bounded). */
export const APPROVAL_SLA_SWEEP_BATCH = 200;

export interface ApprovalSlaJobData {
  sweep: true;
}
