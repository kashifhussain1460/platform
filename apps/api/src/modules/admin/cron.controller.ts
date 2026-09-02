import {
  BadRequestException,
  Controller,
  All,
  Logger,
  ForbiddenException,
  Headers,
  Param,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isInlineExecution } from '../../common/resilience/workflow-execution-mode';
import { ApprovalSlaService } from '../approvals/sla/approval-sla.service';
import { GmailInboundService } from '../events/inbound/gmail-inbound.service';
import { ImapInboundService } from '../events/inbound/imap-inbound.service';
import { ConnectorReconcileService } from '../events/reconciliation/connector-reconcile.service';
import { MarketingSyncService } from '../engines/marketing/marketing-sync.service';
import { CampaignGenerationService } from '../marketing/generation/campaign-generation.service';
import { HrRetentionService } from '../hr/hr-retention.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { CreditReservationSweepService } from '../credits/credit-reservation-sweep.service';
import { PlatformSweepsService } from './sweeps/platform-sweeps.service';
import {
  PLATFORM_SWEEPS,
  type PlatformSweepJob,
} from './sweeps/platform-sweeps.constants';

/**
 * Time-based sweeps, callable over HTTP.
 *
 * Everything in here also runs as a BullMQ **repeatable** job. Repeatables need
 * a persistent worker to fire them, so on a serverless-only deployment they
 * never run at all — scheduled workflows never trigger, stuck runs are never
 * reaped, approval SLAs never escalate, retention never prunes.
 *
 * These routes let a platform scheduler (Vercel Cron, cloud scheduler, or plain
 * `curl` from anywhere) drive the same work. One-minute granularity is plenty:
 * the sweeps below run on 5-minute or daily cadences.
 *
 * ── The mirror-image trap (audit 2026-09-02) ────────────────────────────────
 * "Everything in here normally runs as a repeatable" was **not true** when this
 * comment first said it. Eight of the eighteen jobs — `alerts`,
 * `audit-retention`, `data-retention`, `marketing-analytics`,
 * `subscription-credit-renewal`, `enterprise-credit-agreement-renewal`,
 * `credit-reconciliation` and `credit-finance-rollup` — existed ONLY as cases
 * in this switch. So a *worker* deployment ran none of them, which is the exact
 * inverse of the serverless gap this controller was written to close, and it
 * included the job that grants paying customers their monthly credits.
 *
 * Those eight now live in `PlatformSweepsService`, driven by
 * `PlatformSweepsProcessor` on a worker and delegated to from here over HTTP.
 * `cron-schedule-coverage.spec.ts` asserts every name in {@link CRON_JOBS} has
 * a driver in BOTH deployment shapes, so neither gap can reopen.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * A shared secret in `X-Cron-Secret`, NOT a user JWT — a scheduler has no user
 * and no tenant, and these sweeps are deliberately cross-tenant. With
 * `CRON_SECRET` unset the routes are DISABLED rather than open: an unauthenticated
 * endpoint that can trigger every tenant's workflows is not something to leave
 * ajar by default.
 */

/**
 * Every job `run()` accepts — the canonical list.
 *
 * Extracted from the `switch` (and from the hand-maintained string in its
 * `default:` branch, which had already drifted) so that ONE place can be
 * compared against the deployment scheduler. `cron-schedule-coverage.spec.ts`
 * asserts every name here appears in `apps/api/vercel.json`.
 *
 * That test exists because six of these were reachable over HTTP and scheduled
 * by nothing: `imap-poll`, `credit-reservation-sweep`,
 * `subscription-credit-renewal`, `enterprise-credit-agreement-renewal`,
 * `credit-reconciliation` and `credit-finance-rollup`. On the serverless
 * deployment that meant IMAP inbound never polled, orphaned credit holds were
 * never released, and — worst — PAYING customers never received their monthly
 * included credits, because the job that grants them was written, tested,
 * routed, and never called.
 */
export const CRON_JOBS = [
  'workflow-schedules',
  'workflow-watchdog',
  'approval-sla',
  'hr-retention',
  'audit-retention',
  'data-retention',
  'alerts',
  'gmail-poll',
  'imap-poll',
  'connector-reconcile',
  'marketing-sync',
  'marketing-analytics',
  'campaign-generation',
  'credit-reservation-sweep',
  'subscription-credit-renewal',
  'enterprise-credit-agreement-renewal',
  'credit-reconciliation',
  'credit-finance-rollup',
] as const;

export type CronJob = (typeof CRON_JOBS)[number];

@Controller('admin/cron')
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly workflows: WorkflowsService,
    private readonly sla: ApprovalSlaService,
    private readonly retention: HrRetentionService,
    private readonly gmailInbound: GmailInboundService,
    private readonly imapInbound: ImapInboundService,
    private readonly reconcile: ConnectorReconcileService,
    private readonly marketingSync: MarketingSyncService,
    private readonly campaignGeneration: CampaignGenerationService,
    private readonly creditReservationSweep: CreditReservationSweepService,
    // The eight sweeps that have no queue of their own. Shared with
    // `PlatformSweepsProcessor` so the HTTP driver and the BullMQ driver run
    // literally the same code — they used to be a switch in this file only,
    // which is why a worker deployment ran none of them.
    private readonly platformSweeps: PlatformSweepsService,
  ) {}

  /** The jobs `PlatformSweepsService` owns, for the delegation check below. */
  private static readonly DELEGATED = new Set<string>(
    PLATFORM_SWEEPS.map((s) => s.job),
  );

  /**
   * `@All` deliberately: Vercel Cron issues a GET, while a human or another
   * scheduler reaches for POST since these are actions. Stacking `@Get` and
   * `@Post` on one handler does NOT work in Nest — only one route gets
   * registered and the other 404s on a schedule, silently. `@All` is the
   * supported way to accept both.
   */
  @All(':job')
  async run(
    @Param('job') job: string,
    @Headers('x-cron-secret') headerSecret: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<Record<string, unknown>> {
    // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; `x-cron-secret` is
    // the explicit form for anything else calling this.
    const bearer = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : undefined;
    this.assertAuthorized(headerSecret ?? bearer);

    // Delegated first: these eight live in PlatformSweepsService so that the
    // BullMQ repeatables and this route cannot drift apart.
    if (CronController.DELEGATED.has(job)) {
      return this.platformSweeps.run(job as PlatformSweepJob);
    }

    switch (job) {
      case 'workflow-schedules':
        return this.fireDueSchedules();
      case 'workflow-watchdog':
        return { ...(await this.workflows.sweepStuckRuns()) };
      case 'approval-sla':
        return { ...(await this.sla.sweep()) };
      case 'hr-retention':
        return { ...(await this.retention.runRetention(new Date())) };
      case 'gmail-poll':
        // P1-4: inbound Gmail polling is otherwise a worker-only repeatable, so
        // on a serverless deploy (QUEUE_WORKERS_ENABLED=false) no email ever
        // arrives. Driving it here makes EVENT-triggered email workflows work.
        return { ...(await this.gmailInbound.sweep()) };
      case 'imap-poll':
        // The own-mailbox (SMTP/IMAP) counterpart of gmail-poll: worker-only
        // otherwise, so a serverless deploy would never read inbound email from
        // a company's own mail server.
        return { ...(await this.imapInbound.sweep()) };
      case 'connector-reconcile':
        // P1-4: the dropped-webhook catch-up sweep, same worker-only problem.
        return { ...(await this.reconcile.sweep()) };
      case 'marketing-sync':
        // Postiz reconciliation is the source of truth (its webhook is a no-op);
        // worker-only otherwise, so it must be cron-driven on serverless.
        return { ...(await this.marketingSync.sweep()) };
      case 'campaign-generation':
        // Marketing AI campaign generation. On serverless there is no worker,
        // so this sweep is the ONLY thing that advances a campaign past its
        // first pass — see CampaignGenerationService.start().
        return { ...(await this.campaignGeneration.sweep()) };
      case 'credit-reservation-sweep':
        // Credit system Phase 2, Task 2.8 (kill-critic Q8's "hard
        // prerequisite"): without this case, the sweep's BullMQ repeatable
        // never fires on this platform's QUEUE_WORKERS_ENABLED=false
        // deployment path, turning "a reconciliation window" into "no
        // recovery, ever" for orphaned chat/assist credit holds.
        return { ...(await this.creditReservationSweep.sweep()) };
      default:
        throw new BadRequestException(
          `Unknown cron job "${job}". Known: ${CRON_JOBS.join(', ')}.`,
        );
    }
  }

  private assertAuthorized(secret: string | undefined): void {
    const expected = this.config.get<string>('CRON_SECRET');
    if (!expected) {
      throw new ForbiddenException(
        'Cron endpoints are disabled because CRON_SECRET is not set.',
      );
    }
    if (secret !== expected) {
      throw new ForbiddenException('Bad cron secret');
    }
  }

  /**
   * Fire every ACTIVE SCHEDULE workflow whose interval has elapsed.
   *
   * "Elapsed" is measured against the workflow's own last run rather than a
   * BullMQ repeatable clock, because there is no repeatable clock in this mode.
   * The consequence is honest: precision is bounded by how often the scheduler
   * calls us, and a missed window is skipped rather than backfilled — which is
   * the right choice for side-effecting automations.
   */
  private async fireDueSchedules(): Promise<Record<string, unknown>> {
    const workflows = await this.prisma.workflow.findMany({
      where: { status: 'ACTIVE', triggerType: 'SCHEDULE', archivedAt: null },
      select: { id: true, companyId: true, triggerConfig: true },
    });

    const now = Date.now();
    let fired = 0;
    let skipped = 0;

    for (const wf of workflows) {
      const everyMs = Number(
        (wf.triggerConfig as { everyMs?: unknown } | null)?.everyMs,
      );
      if (!Number.isFinite(everyMs) || everyMs <= 0) {
        skipped += 1;
        continue;
      }

      const last = await this.prisma.workflowRun.findFirst({
        where: { workflowId: wf.id, source: 'SCHEDULE' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (last && now - last.createdAt.getTime() < everyMs) {
        skipped += 1;
        continue;
      }

      try {
        await this.workflows.fireScheduled(wf.id);
        fired += 1;
      } catch (err) {
        // One tenant's broken workflow must not stop the sweep for everyone else.
        this.logger.warn(
          `scheduled trigger failed for workflow ${wf.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        skipped += 1;
      }
    }

    return { candidates: workflows.length, fired, skipped, inline: isInlineExecution() };
  }
}
