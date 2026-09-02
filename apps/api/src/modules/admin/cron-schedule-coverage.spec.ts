import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_JOBS } from './cron.controller';
import { PLATFORM_SWEEPS } from './sweeps/platform-sweeps.constants';

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
  const parkedPath = join(__dirname, '..', '..', '..', 'vercel.crons.json');
  type Cron = { path: string; schedule: string };
  const manifest = JSON.parse(readFileSync(vercelJsonPath, 'utf8')) as {
    crons?: Cron[];
  };
  const parked = JSON.parse(readFileSync(parkedPath, 'utf8')) as { crons?: Cron[] };

  /**
   * The definitions live in `vercel.json` under `crons` when registered with
   * Vercel, and in the `vercel.crons.json` sidecar while parked — currently the
   * case, because the Hobby plan rejects any cron running more than once per
   * day (docs/runbooks/deployment.md §7).
   *
   * A sidecar rather than a commented-out key because **vercel.json has a
   * CLOSED schema** (`additionalProperties: false`): `vercel deploy` rejects any
   * unrecognised top-level property, and JSON has no comments. `vercel build`
   * does NOT enforce this, so a stray key passes the build and only blows up at
   * deploy — which is exactly how it was discovered.
   *
   * This guard reads WHICHEVER place holds them. Parking the schedules is a
   * billing decision; letting their content rot is not. On the day someone
   * re-enables them, the set must already be complete, typo-free and correctly
   * ordered — which is what the assertions below check.
   */
  const crons = manifest.crons ?? parked.crons ?? [];
  const scheduledJobs = crons.map((c) => c.path.replace('/admin/cron/', ''));

  it('keeps the schedules in exactly one place, never both', () => {
    // Two copies would drift, and the parked one is what a future reader
    // trusts. Re-enabling must MOVE the list into vercel.json, not copy it.
    const active = manifest.crons !== undefined;
    const isParked = parked.crons !== undefined;
    expect(active && isParked).toBe(false);
    expect(active || isParked).toBe(true);
  });

  it('keeps vercel.json free of keys Vercel does not recognise', () => {
    // `vercel.json` validates against a CLOSED schema (additionalProperties:
    // false). Anything unrecognised — including a `//`-prefixed pseudo-comment
    // — is rejected at DEPLOY time with "should NOT have additional property".
    //
    // This is worth a test because `vercel build` does not enforce it: a bad
    // key builds cleanly and then fails the deploy, which is a slow and
    // confusing way to find out. That is precisely what happened when the
    // parked crons were first stashed under a `//crons` key.
    const allowed = new Set([
      '$schema',
      'buildCommand',
      'installCommand',
      'devCommand',
      'outputDirectory',
      'framework',
      'functions',
      'rewrites',
      'redirects',
      'headers',
      'crons',
      'git',
      'regions',
      'ignoreCommand',
      'cleanUrls',
      'trailingSlash',
      'images',
      'public',
      'fluid',
    ]);
    const unknown = Object.keys(manifest).filter((k) => !allowed.has(k));
    expect(unknown).toEqual([]);
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

  /**
   * The worker-deployment half of the same question, and the gap the
   * 2026-09-02 audit found: eight jobs had an HTTP route and NO repeatable, so
   * a worker deployment ran none of them — including
   * `subscription-credit-renewal`, which is how paying customers get their
   * monthly credits.
   *
   * Every job must have a driver in BOTH shapes. `WORKER_DRIVEN` is the
   * hand-verified list of jobs whose repeatable lives in its own module;
   * `PLATFORM_SWEEPS` covers the rest. Adding a job to `CRON_JOBS` without a
   * repeatable now fails here instead of silently never running.
   */
  describe('worker-mode driver coverage', () => {
    /** Jobs whose BullMQ repeatable is registered by their own module. */
    const WORKER_DRIVEN: readonly string[] = [
      // WorkflowsService.addSchedule registers one repeatable per ACTIVE
      // SCHEDULE workflow; WorkflowProcessor consumes them.
      'workflow-schedules',
      // workflow.processor.ts — upsertJobScheduler on the run queue.
      'workflow-watchdog',
      'approval-sla', // approvals/sla/approval-sla.processor.ts
      'hr-retention', // hr/hr-retention.processor.ts
      'gmail-poll', // events/inbound/gmail-inbound.processor.ts
      'imap-poll', // events/inbound/imap-inbound.processor.ts
      'connector-reconcile', // events/reconciliation/connector-reconcile.processor.ts
      'marketing-sync', // engines/marketing/marketing-sync.processor.ts
      'campaign-generation', // marketing/generation/campaign-generation.processor.ts
      'credit-reservation-sweep', // credits/credit-reservation-sweep.processor.ts
    ];

    const platformSwept = PLATFORM_SWEEPS.map((s) => s.job);

    it('gives every cron job exactly one worker-mode driver', () => {
      const undriven = CRON_JOBS.filter(
        (job) => !WORKER_DRIVEN.includes(job) && !platformSwept.includes(job as never),
      );
      expect(undriven).toEqual([]);
    });

    it('never drives the same job twice', () => {
      const both = platformSwept.filter((job) => WORKER_DRIVEN.includes(job));
      expect(both).toEqual([]);
    });

    it('claims no platform sweep the controller cannot run', () => {
      const unknown = platformSwept.filter(
        (job) => !(CRON_JOBS as readonly string[]).includes(job),
      );
      expect(unknown).toEqual([]);
    });

    it('gives every platform sweep exactly one cadence', () => {
      for (const sweep of PLATFORM_SWEEPS) {
        const hasCron = sweep.cron !== undefined;
        const hasEvery = sweep.every !== undefined;
        expect(hasCron !== hasEvery).toBe(true);
        if (hasCron) expect(sweep.cron!.trim().split(/\s+/)).toHaveLength(5);
        if (hasEvery) expect(sweep.every!).toBeGreaterThan(0);
      }
    });

    /**
     * The two drivers must agree about WHEN, or the same sweep runs on two
     * different clocks depending on how it was deployed — which makes an
     * incident irreproducible.
     */
    it('matches the HTTP schedule for every job it owns', () => {
      const httpSchedule = new Map(
        crons.map((c) => [c.path.replace('/admin/cron/', ''), c.schedule]),
      );
      for (const sweep of PLATFORM_SWEEPS) {
        if (!sweep.cron) continue; // `every`-based sweeps have no cron form
        expect(httpSchedule.get(sweep.job)).toBe(sweep.cron);
      }
    });
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
