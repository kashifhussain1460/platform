import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_JOBS } from './cron.controller';

/**
 * Phase 1 — deployment-scheduler drift guard.
 *
 * `CronController` is the ONLY thing that drives time-based work on the
 * serverless deployment: `QUEUE_WORKERS_ENABLED=false` removes the BullMQ
 * consumer, so a repeatable that nothing curls simply never happens.
 *
 * Six jobs were in exactly that state — routed, tested, and scheduled by
 * nothing:
 *
 *   imap-poll                            → IMAP inbound never polled
 *   credit-reservation-sweep             → orphaned credit holds never released
 *   subscription-credit-renewal          → PAYING customers never got their
 *                                          monthly included credits
 *   enterprise-credit-agreement-renewal  → Enterprise allotments never renewed
 *   credit-reconciliation                → no daily ledger reconciliation
 *   credit-finance-rollup                → no finance rollup
 *
 * Nothing failed. Nothing logged. The jobs were simply never invoked, which is
 * the most expensive kind of bug to find in production. This test makes the
 * next omission a red build instead.
 */
describe('cron schedule coverage (CronController ↔ vercel.json)', () => {
  const vercelJsonPath = join(__dirname, '..', '..', '..', 'vercel.json');
  const manifest = JSON.parse(readFileSync(vercelJsonPath, 'utf8')) as {
    crons?: Array<{ path: string; schedule: string }>;
    '//crons-disabled'?: Array<{ path: string; schedule: string }>;
  };

  /**
   * The definitions live under `crons` when they are registered with Vercel,
   * and under `//crons-disabled` while they are parked — currently the case,
   * because the Hobby plan rejects any cron running more than once per day
   * (see docs/runbooks/deployment.md §7).
   *
   * This guard deliberately reads WHICHEVER key holds them. Parking the
   * schedules is a billing decision; letting their CONTENT rot is not. The day
   * someone re-enables them by renaming the key, the set must already be
   * complete, typo-free and correctly ordered — which is exactly what the
   * assertions below check.
   */
  const crons = manifest.crons ?? manifest['//crons-disabled'] ?? [];
  const scheduledJobs = crons.map((c) => c.path.replace('/admin/cron/', ''));

  it('keeps the schedules under exactly one key, never both', () => {
    // Two copies would drift, and the parked one is the copy a future reader
    // trusts. Renaming to re-enable must MOVE the list, not duplicate it.
    const active = manifest.crons !== undefined;
    const parked = manifest['//crons-disabled'] !== undefined;
    expect(active && parked).toBe(false);
    expect(active || parked).toBe(true);
  });

  it('schedules every job the controller can run', () => {
    const missing = CRON_JOBS.filter((job) => !scheduledJobs.includes(job));
    expect(missing).toEqual([]);
  });

  it('schedules nothing the controller cannot run', () => {
    // The other direction matters too: a typo'd path is a cron that 400s once a
    // minute for ever, and Vercel will not tell anyone.
    const unknown = scheduledJobs.filter(
      (job) => !(CRON_JOBS as readonly string[]).includes(job),
    );
    expect(unknown).toEqual([]);
  });

  it('gives every cron a non-empty 5-field schedule expression', () => {
    for (const cron of crons) {
      expect(cron.schedule.trim().split(/\s+/)).toHaveLength(5);
    }
  });

  it('has no duplicate schedules for the same job', () => {
    expect(new Set(scheduledJobs).size).toBe(scheduledJobs.length);
  });

  it('runs the finance rollup AFTER reconciliation for the same closed day', () => {
    // Both read the PREVIOUS UTC day. The rollup consumes what reconciliation
    // has already checked, so ordering them the other way round would roll up
    // numbers nobody had verified yet.
    const hourOf = (job: string): number => {
      const cron = crons.find((c) => c.path.endsWith(`/${job}`));
      if (!cron) throw new Error(`${job} is not scheduled`);
      const [minute, hour] = cron.schedule.split(/\s+/);
      return Number(hour) * 60 + Number(minute);
    };
    expect(hourOf('credit-finance-rollup')).toBeGreaterThan(
      hourOf('credit-reconciliation'),
    );
  });
});
