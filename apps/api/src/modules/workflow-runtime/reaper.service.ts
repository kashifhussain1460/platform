import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RunStateWriter } from './run-state-writer.service';
import {
  WF_ADVANCE_JOB,
  WF_RUN_ADVANCE_QUEUE,
  WF_STUCK_RUN_AFTER_MS,
  wfJobId,
  type AdvanceJobData,
} from './workflow-runtime.constants';

export interface ReaperResult {
  expiredLeases: number;
  stuckRuns: number;
  overdueRuns: number;
  firedTimers: number;
}

/**
 * P1-05 — the reaper (doc 16 §6.7).
 *
 * Four sweeps, run on a schedule. Together they are what makes the runtime
 * self-healing: state lives in Postgres, so even a total Redis loss is
 * recoverable — the reaper re-enqueues whatever is outstanding.
 *
 * This SUPERSEDES the legacy 5-minute stuck-run watchdog. Both must never run
 * at once: two components racing to fail the same run is worse than either
 * alone, because each sees the other's write and neither is authoritative.
 */
@Injectable()
export class ReaperService {
  private readonly logger = new Logger(ReaperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: RunStateWriter,
    @InjectQueue(WF_RUN_ADVANCE_QUEUE)
    private readonly advanceQueue: Queue<AdvanceJobData>,
  ) {}

  async sweep(): Promise<ReaperResult> {
    const [expiredLeases, firedTimers, stuckRuns, overdueRuns] =
      await Promise.all([
        this.sweepExpiredLeases(),
        this.sweepDueTimers(),
        this.sweepStuckRuns(),
        this.sweepOverdueRuns(),
      ]);

    const result = { expiredLeases, stuckRuns, overdueRuns, firedTimers };
    if (expiredLeases || stuckRuns || overdueRuns || firedTimers) {
      this.logger.log(`reaper sweep ${JSON.stringify(result)}`);
    }
    return result;
  }

  /**
   * Sweep 1 — attempts whose lease expired: the worker died.
   *
   * Marked FAILED with `outcomeUnknown = true` and deliberately NOT
   * auto-retried. The worker may have died AFTER the side effect but BEFORE its
   * bookkeeping commit (doc 16 §6.5), so the effect might already have happened.
   * Re-running a possibly-completed payment is a worse failure than surfacing
   * it to a human.
   */
  private async sweepExpiredLeases(): Promise<number> {
    const expired = await this.prisma.workflowStepAttempt.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      select: { id: true, runId: true, companyId: true, stepId: true },
      take: 200,
    });
    if (expired.length === 0) return 0;

    for (const attempt of expired) {
      await this.prisma.workflowStepAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'FAILED',
          outcomeUnknown: true,
          failureClass: 'INTERNAL',
          error:
            'Worker lease expired — the outcome of this attempt is UNKNOWN. ' +
            'It was not retried automatically because the side effect may already have happened.',
          finishedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      this.logger.warn(
        `reaper: lease expired attempt=${attempt.id} run=${attempt.runId} — marked outcomeUnknown`,
      );
      await this.enqueueAdvance(attempt.runId, attempt.companyId);
    }
    return expired.length;
  }

  /** Sweep 2 — timers whose time has come. */
  private async sweepDueTimers(): Promise<number> {
    const due = await this.prisma.workflowRunTimer.findMany({
      where: { firedAt: null, fireAt: { lte: new Date() } },
      select: { id: true, runId: true, companyId: true, kind: true },
      take: 200,
    });
    if (due.length === 0) return 0;

    for (const timer of due) {
      // Mark fired FIRST and guard on firedAt still being null, so two
      // overlapping sweeps cannot both act on one timer.
      const claimed = await this.prisma.workflowRunTimer.updateMany({
        where: { id: timer.id, firedAt: null },
        data: { firedAt: new Date() },
      });
      if (claimed.count === 0) continue;
      await this.enqueueAdvance(timer.runId, timer.companyId);
    }
    return due.length;
  }

  /**
   * Sweep 3 — RUNNING runs with no live attempt and no recent activity.
   * Self-heals a run whose advance job was lost (e.g. Redis was flushed).
   *
   * SCOPED TO STATE-MACHINE RUNS ONLY (`attempts: { some: {} }`). A legacy
   * graph-walk run never writes WorkflowStepAttempt rows, so without this guard
   * every legacy RUNNING run would match `none RUNNING` and get re-enqueued into
   * the state-machine advance path — re-executing side-effecting nodes while the
   * legacy watchdog independently fails the same run. Requiring at least one
   * attempt row makes this sweep act only on runs that actually entered the
   * durable engine.
   */
  private async sweepStuckRuns(): Promise<number> {
    const threshold = new Date(Date.now() - WF_STUCK_RUN_AFTER_MS);
    const stuck = await this.prisma.workflowRun.findMany({
      where: {
        status: 'RUNNING',
        createdAt: { lt: threshold },
        attempts: { some: {}, none: { status: 'RUNNING' } },
      },
      select: { id: true, companyId: true },
      take: 100,
    });
    for (const run of stuck) {
      this.logger.warn(`reaper: re-enqueueing stuck run=${run.id}`);
      await this.enqueueAdvance(run.id, run.companyId);
    }
    return stuck.length;
  }

  /** Sweep 4 — runs past their hard deadline. */
  private async sweepOverdueRuns(): Promise<number> {
    const overdue = await this.prisma.workflowRun.findMany({
      where: {
        deadlineAt: { lt: new Date() },
        status: { in: ['PENDING', 'RUNNING', 'WAITING'] },
      },
      select: { id: true, companyId: true },
      take: 100,
    });
    for (const run of overdue) {
      await this.state.transitionRun({
        runId: run.id,
        companyId: run.companyId,
        to: 'TIMED_OUT',
        error: 'Run exceeded its deadline',
        failureClass: 'TIMEOUT',
        event: 'run.timed_out',
      });
      this.logger.warn(`reaper: run timed out run=${run.id}`);
    }
    return overdue.length;
  }

  private async enqueueAdvance(runId: string, companyId: string): Promise<void> {
    await this.advanceQueue.add(
      WF_ADVANCE_JOB,
      { runId, companyId },
      {
        // Deduplicate: a run already queued for advance must not queue twice.
        jobId: wfJobId('advance', runId, Date.now()),
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}
