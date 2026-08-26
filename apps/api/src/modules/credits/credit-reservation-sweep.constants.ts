/** BullMQ identifiers for the credit reservation-leak sweep (Phase 2, Task 2.8). */

/** Queue carrying the repeatable sweep. */
export const CREDIT_RESERVATION_SWEEP_QUEUE = 'credit-reservation-sweep';

/** Stable scheduler id for `queue.upsertJobScheduler` (idempotent on boot). */
export const CREDIT_RESERVATION_SWEEP_SCHEDULER = 'credit-reservation-sweep-scheduler';

/** Job name for a single sweep. */
export const CREDIT_RESERVATION_SWEEP_JOB = 'credit-reservation-sweep-run';

/** Sweep cadence — 5 min, same as the approval SLA sweep / workflow-run watchdog. */
export const CREDIT_RESERVATION_SWEEP_EVERY_MS = 5 * 60 * 1000;

/** Max stale rows handled per sweep tick (keeps one tick bounded), matching `APPROVAL_SLA_SWEEP_BATCH`'s shape. */
export const CREDIT_RESERVATION_SWEEP_BATCH = 200;

export interface CreditReservationSweepJobData {
  sweep: true;
}
