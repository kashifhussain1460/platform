/** BullMQ queue + repeatable-scheduler identifiers for the HR domain (P3-01). */

/** Queue that carries the daily HR data-retention sweep. */
export const HR_RETENTION_QUEUE = 'hr-retention';

/** Stable scheduler id passed to `queue.upsertJobScheduler` (idempotent on boot). */
export const HR_RETENTION_SCHEDULER = 'hr-retention-scheduler';

/** Job name for a single retention sweep. */
export const HR_RETENTION_JOB = 'hr-retention-sweep';

/** Sweep cadence — once per day. Retention is coarse-grained (day precision). */
export const HR_RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;

export interface HrRetentionJobData {
  retention: true;
}
