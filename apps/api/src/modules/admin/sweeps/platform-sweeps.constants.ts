import type { CronJob } from '../cron.controller';

/** Queue carrying every periodic platform sweep that has no queue of its own. */
export const PLATFORM_SWEEPS_QUEUE = 'platform-sweeps';

/**
 * The sweeps this queue owns, with the cadence each one runs at.
 *
 * ## Why this file exists
 *
 * Ten of the eighteen `/admin/cron/*` jobs already have a BullMQ repeatable
 * behind them — `workflow-schedules` (per-workflow repeatables from
 * `WorkflowsService.addSchedule`), `workflow-watchdog`, `approval-sla`,
 * `hr-retention`, `gmail-poll`, `imap-poll`, `connector-reconcile`,
 * `marketing-sync`, `campaign-generation` and `credit-reservation-sweep`. Those
 * fire by themselves the moment a persistent worker exists.
 *
 * The other **eight had no repeatable at all**. They existed only as HTTP
 * routes, which means a worker deployment — the configuration this platform is
 * moving to — would still never run them:
 *
 *   alerts                               → nothing evaluates alerts; nobody is paged
 *   audit-retention                      → audit log grows for ever
 *   data-retention                       → no GDPR retention on 10 data classes
 *   marketing-analytics                  → no daily Postiz analytics snapshot
 *   subscription-credit-renewal          → PAYING customers never receive their
 *                                          monthly included credits
 *   enterprise-credit-agreement-renewal  → Enterprise allotments never renew
 *   credit-reconciliation                → no daily ledger reconciliation
 *   credit-finance-rollup                → no nightly finance rollup
 *
 * The audit of 2026-09-02 recorded "the cron problem is solved for free by
 * deploying a worker." That was true for ten jobs and false for these eight.
 * This queue closes the gap, so a worker deployment needs **no external
 * scheduler at all** and the HTTP routes go back to being what they should be:
 * a manual ops escape hatch, not the only clock.
 *
 * ## Cadences
 *
 * Deliberately identical to `apps/api/vercel.crons.json`, so the two drivers
 * cannot disagree about when a sweep should happen.
 * `platform-sweeps.spec.ts` asserts that, and asserts that every job in
 * `CRON_JOBS` has exactly one worker-mode driver.
 *
 * Times are UTC and staggered on purpose: the four credit jobs read the same
 * ledger tables for the same closed UTC day, and running them concurrently on a
 * small database is how a nightly job becomes a nightly incident.
 */
export interface PlatformSweepDefinition {
  /** Matches the `/admin/cron/:job` name exactly — one sweep, two drivers. */
  readonly job: Extract<
    CronJob,
    | 'alerts'
    | 'audit-retention'
    | 'data-retention'
    | 'marketing-analytics'
    | 'subscription-credit-renewal'
    | 'enterprise-credit-agreement-renewal'
    | 'credit-reconciliation'
    | 'credit-finance-rollup'
  >;
  /** BullMQ cron pattern (UTC), or `every` in ms for sub-hourly work. */
  readonly cron?: string;
  readonly every?: number;
  /** Why this cadence — kept next to the number so it survives a refactor. */
  readonly why: string;
}

export const PLATFORM_SWEEPS: readonly PlatformSweepDefinition[] = [
  {
    job: 'alerts',
    every: 15 * 60 * 1000,
    why: 'Alert rules are only useful if someone hears them promptly.',
  },
  {
    job: 'subscription-credit-renewal',
    cron: '15 2 * * *',
    why: 'Daily fallback for tenants with no Stripe invoice event to grant on.',
  },
  {
    job: 'enterprise-credit-agreement-renewal',
    cron: '30 2 * * *',
    why: "Enterprise's own recurring allotment; 15 min after the self-serve one.",
  },
  {
    job: 'audit-retention',
    cron: '30 3 * * *',
    why: 'Audit has its own floor and legal-hold rule; separate from HR retention (03:00).',
  },
  {
    job: 'data-retention',
    cron: '0 4 * * *',
    why: 'Never touches an in-flight run, so it goes after the retention pair above.',
  },
  {
    job: 'marketing-analytics',
    cron: '0 5 * * *',
    why: "Daily, not with marketing-sync: folding it in would blow Postiz's instance-wide rate cap.",
  },
  {
    job: 'credit-reconciliation',
    cron: '0 6 * * *',
    why: 'Reconciles the PREVIOUS closed UTC day, so every reservation for it has settled.',
  },
  {
    job: 'credit-finance-rollup',
    cron: '30 6 * * *',
    why: 'Rolls up the same closed day; must run after reconciliation, never beside it.',
  },
] as const;

export type PlatformSweepJob = PlatformSweepDefinition['job'];

/** Stable scheduler id per sweep — `upsertJobScheduler` is idempotent on boot. */
export function schedulerIdFor(job: PlatformSweepJob): string {
  return `platform-sweep:${job}`;
}

export interface PlatformSweepJobData {
  readonly job: PlatformSweepJob;
}
