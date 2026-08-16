import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import type { WorkflowDefinition, WorkflowNode } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AttemptLeaseService } from './attempt-lease.service';
import { LOCK_NOT_ACQUIRED, RunLockService } from './run-lock.service';
import { RunStateWriter } from './run-state-writer.service';
import { TraversalService } from './traversal.service';
import { nextRunnableNode } from './graph';
import { isTerminalRunStatus } from './run-state';
import {
  WF_ADVANCE_JOB,
  WF_ATTEMPT_JOB,
  WF_NODE_ATTEMPT_QUEUE,
  WF_RUN_ADVANCE_QUEUE,
  wfJobId,
  type AdvanceJobData,
  type NodeAttemptJobData,
} from './workflow-runtime.constants';
import { runInJobContext } from '../../common/observability/job-context';

/**
 * P1-04 — the advance worker (doc 16 §6.1).
 *
 * Decides what happens next for one run and enqueues exactly one unit of work,
 * then exits. It never holds a run across an await of unbounded duration.
 *
 * The split from `wf-node-attempt` is the core safety property: a DECISION is
 * cheap, idempotent and safe to repeat, whereas an ATTEMPT is expensive and may
 * be irreversible. Fusing them would make every retry of the decision risk
 * re-running the side effect.
 */
@Processor(WF_RUN_ADVANCE_QUEUE, { concurrency: 4 })
export class RunAdvanceProcessor extends WorkerHost {
  private readonly logger = new Logger(RunAdvanceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: RunLockService,
    private readonly state: RunStateWriter,
    private readonly leases: AttemptLeaseService,
    private readonly traversal: TraversalService,
    @InjectQueue(WF_NODE_ATTEMPT_QUEUE)
    private readonly attemptQueue: Queue<NodeAttemptJobData>,
    @InjectQueue(WF_RUN_ADVANCE_QUEUE)
    private readonly advanceQueue: Queue<AdvanceJobData>,
  ) {
    super();
  }

  async process(job: Job<AdvanceJobData>): Promise<void> {
    // Correlation: an AsyncLocalStorage store does not survive the queue
    // hop, so it is re-established here from the job payload.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job<AdvanceJobData>): Promise<void> {
    const { runId, companyId, fromNodeId } = job.data;

    const outcome = await this.locks.withRunLock(runId, async () =>
      this.decide(runId, companyId, fromNodeId ?? null),
    );

    if (outcome === LOCK_NOT_ACQUIRED) {
      // RE-ENQUEUE, do not drop.
      //
      // This used to return, on the reasoning that "another worker is advancing
      // this run and will enqueue what comes next". That holds for a LINEAR run,
      // where every advance asks the same question. It is false for fan-in: two
      // lanes finishing together produce two advances carrying DIFFERENT
      // `fromNodeId`s, and the one that loses the lock is the one whose lane
      // arrival never gets recorded — so `WorkflowJoinState.arrived` stalls one
      // short of `expected` and the JOIN waits for ever.
      //
      // An advance is cheap and idempotent, so retrying is always safe; dropping
      // it never is. Found by the first PARALLEL test ever run against this
      // engine, which hung with both lanes COMPLETED and no JOIN.
      await this.advanceQueue.add(
        WF_ADVANCE_JOB,
        { runId, companyId, fromNodeId },
        {
          delay: LOCK_RETRY_DELAY_MS,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      return;
    }
  }

  /** Runs INSIDE the run's advisory lock. */
  private async decide(
    runId: string,
    companyId: string,
    fromNodeId: string | null,
  ): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { workflow: true, workflowVersion: true },
    });
    if (!run) return;

    // Never trust the payload's tenant (doc 16 §20).
    if (run.companyId !== companyId) {
      this.logger.error(
        `SECURITY: advance job companyId mismatch job=${companyId} run=${run.companyId} run=${runId}`,
      );
      throw new Error('Tenant mismatch between job payload and run');
    }

    if (isTerminalRunStatus(run.status)) return;
    if (run.status === 'WAITING') {
      // Paused on a timer or an approval; whoever resolves it re-enqueues.
      return;
    }

    if (run.status === 'PENDING') {
      // Seed the context BEFORE the first node runs, exactly as the legacy walk
      // does: `{{trigger.*}}` and persisted WORKFLOW/OUTPUT-scope variables have
      // to be readable by node 1, not from node 2 onwards.
      await this.seedContext(run);
      await this.state.transitionRun({
        runId,
        companyId,
        to: 'RUNNING',
        event: 'run.started',
      });
    }

    const definition = this.parseDefinition(run);
    if (definition.nodes.length === 0) {
      await this.state.transitionRun({
        runId,
        companyId,
        to: 'FAILED',
        error: 'Workflow definition has no nodes to run',
        failureClass: 'VALIDATION_ERROR',
        event: 'run.failed',
      });
      return;
    }

    const steps = await this.prisma.workflowStepRun.findMany({
      where: { runId, companyId },
      select: {
        nodeId: true,
        status: true,
        branch: true,
        finishedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // WAVE 2 — SIDE-EFFECT SAFETY BACKSTOP.
    //
    // An attempt flagged `outcomeUnknown` means a worker died between the
    // external side effect and its bookkeeping commit: the provider may already
    // have sent the email, published the post, charged the card. Opening another
    // attempt at that node would do it a second time.
    //
    // The reaper also FAILs the step when it sets the flag, which stops the run
    // through the branch below. This check is the belt to that braces: it looks
    // at the ATTEMPT rows rather than the step status, so any route that leaves
    // a step re-runnable — a future sweep, a manual repair, a bug — still cannot
    // re-execute the effect. Duplicating an irreversible action is not a failure
    // mode worth being clever about.
    const unknown = await this.prisma.workflowStepAttempt.findFirst({
      where: { runId, companyId, outcomeUnknown: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, stepId: true, error: true },
    });
    if (unknown) {
      const step = await this.prisma.workflowStepRun.findFirst({
        where: { id: unknown.stepId },
        select: { nodeId: true, status: true },
      });
      if (step && step.status !== 'FAILED') {
        await this.state.transitionStep({
          stepId: unknown.stepId,
          runId,
          companyId,
          to: 'FAILED',
          error: unknown.error ?? 'Attempt outcome unknown',
          event: 'step.failed',
        });
      }
      await this.state.transitionRun({
        runId,
        companyId,
        to: 'FAILED',
        error:
          unknown.error ??
          'An attempt ended with an UNKNOWN outcome and was not retried.',
        failureClass: 'OUTCOME_UNKNOWN',
        resumeNodeId: null,
        event: 'run.failed',
        eventData: {
          failedNodeId: step?.nodeId,
          attemptId: unknown.id,
          outcomeUnknown: true,
        },
      });
      this.logger.warn(
        `advance: run=${runId} FAILED as OUTCOME_UNKNOWN (attempt=${unknown.id}) — not retried by design`,
      );
      return;
    }

    // A step that failed terminally ends the run. Without this the advance would
    // hand the SAME failed node back on every pass and the run would sit RUNNING
    // for ever — the exact "stuck run" class the reaper exists to notice.
    const failed = steps.find((s) => s.status === 'FAILED');
    if (failed) {
      const step = await this.prisma.workflowStepRun.findFirst({
        where: { runId, companyId, nodeId: failed.nodeId, status: 'FAILED' },
        select: { error: true },
      });
      // WAVE 2 — carry the attempt's classification up to the run. Without it
      // every step failure surfaced on the run as an unclassified error, so the
      // failure taxonomy stopped at the attempt row and never reached metrics,
      // the runs list, or the operator.
      const lastAttempt = await this.prisma.workflowStepAttempt.findFirst({
        where: { runId, companyId, status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        select: { failureClass: true },
      });
      await this.state.transitionRun({
        runId,
        companyId,
        to: 'FAILED',
        error: step?.error ?? `Step "${failed.nodeId}" failed`,
        failureClass: lastAttempt?.failureClass ?? 'NODE_ERROR',
        resumeNodeId: null,
        event: 'run.failed',
        eventData: { failedNodeId: failed.nodeId },
      });
      return;
    }

    let next: WorkflowNode | undefined;
    try {
      next = run.resumeNodeId
        ? definition.nodes.find((n) => n.id === run.resumeNodeId)
        : nextRunnableNode({ definition, steps, fromNodeId });
    } catch (error) {
      // A misconfigured graph (unmatched branch, dangling edge) must fail the run
      // loudly rather than quietly finish it having skipped everything downstream.
      await this.state.transitionRun({
        runId,
        companyId,
        to: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
        failureClass: 'VALIDATION_ERROR',
        resumeNodeId: null,
        event: 'run.failed',
      });
      return;
    }

    if (!next) {
      await this.state.transitionRun({
        runId,
        companyId,
        to: 'COMPLETED',
        resumeNodeId: null,
        event: 'run.completed',
      });
      return;
    }

    // Per-run step budget: a malformed or looping graph must not run forever.
    const visited = await this.prisma.workflowStepRun.count({
      where: { runId, companyId },
    });
    if (visited >= MAX_STEPS_PER_RUN) {
      await this.state.transitionRun({
        runId,
        companyId,
        to: 'FAILED',
        error: `Exceeded the per-run step budget (${MAX_STEPS_PER_RUN})`,
        failureClass: 'BUDGET_EXCEEDED',
        event: 'run.failed',
      });
      return;
    }

    // ── Author-disabled node: record it SKIPPED and route past it ────────────
    //
    // The legacy walk does this inline in its loop; the durable engine did not,
    // so a node the author had switched OFF was dispatched and EXECUTED — a
    // deactivated "email the candidate" step would have sent the email. The
    // graph helper already treats SKIPPED as settled, so the row is all the
    // routing needs.
    //
    // A real SKIPPED row, not a silent hop: the timeline has to explain why a
    // step produced nothing, or the gap reads as a bug. Routing follows the
    // FIRST outgoing edge because a disabled node produces no branch selector
    // to route on. (A disabled TRIGGER is refused at validation — a graph needs
    // a root.)
    if (next.disabled) {
      await this.prisma.workflowStepRun.create({
        data: {
          companyId,
          runId,
          nodeId: next.id,
          type: next.type,
          status: 'SKIPPED',
          input: (next.config ?? {}) as Prisma.InputJsonObject,
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      // Consume the resume pointer if it aimed here, or the next advance would
      // resolve to this same disabled node and skip it again for ever.
      if (run.resumeNodeId === next.id) {
        await this.prisma.workflowRun.update({
          where: { id: run.id },
          data: { resumeNodeId: null },
        });
      }
      this.logger.log(
        `workflow.step.skipped run=${runId} node=${next.id} reason=disabled`,
      );
      await this.advanceQueue.add(
        WF_ADVANCE_JOB,
        { runId, companyId, fromNodeId: next.id },
        { removeOnComplete: true, removeOnFail: 100 },
      );
      return;
    }

    // A JOIN may only proceed once every fanned-out lane has arrived. Without
    // this the run would sail past the join while lanes were still running, and
    // downstream steps would read half-populated context.
    if (next.type === 'JOIN') {
      // Collect the arriving lane's output before recording its arrival.
      //
      // The legacy walk sets `context.__lanes = laneOutputs` before handing
      // control to the JOIN; the durable path never did, so a JOIN here always
      // reported `arrived: 0` and every downstream step saw nothing the lanes
      // produced. Fan-out worked and fan-IN silently lost the results.
      if (fromNodeId) {
        const laneStep = await this.prisma.workflowStepRun.findFirst({
          where: { runId, companyId, nodeId: fromNodeId },
          orderBy: { createdAt: 'desc' },
          select: { output: true },
        });
        const lanes = {
          ...((run.context as Record<string, unknown> | null)?.[
            LANE_OUTPUT_KEY
          ] as Record<string, unknown> | undefined),
          [fromNodeId]: { completed: true, output: laneStep?.output ?? null },
        };
        // A jsonb merge, so two lanes arriving at once cannot erase each other
        // — the exact lost-update the WAVE 1 context fix exists to prevent.
        await this.state.mergeRunContext(runId, { [LANE_OUTPUT_KEY]: lanes });
      }

      const join = await this.traversal.recordLaneArrival(run.id, next.id);
      if (!join.complete) {
        this.logger.debug(
          `advance: join ${next.id} waiting (${join.arrived}/${join.expected}) run=${run.id}`,
        );
        return;
      }
    }

    // Consume the resume pointer as soon as its node is dispatched. Leaving it
    // set would make every later advance return to the same node — the run
    // would re-execute the approval step for ever instead of moving on. If this
    // process dies before the attempt is queued, the reaper's stuck-run sweep
    // re-derives the same node from the step rows, so clearing early is safe.
    if (run.resumeNodeId) {
      await this.prisma.workflowRun.update({
        where: { id: run.id },
        data: { resumeNodeId: null },
      });
    }

    await this.enqueueAttempt(run.id, companyId, next);
  }

  /**
   * Seed a fresh run's context, mirroring `WorkflowEngine.run` exactly.
   *
   * `{{trigger.*}}` and any persisted WORKFLOW/OUTPUT-scope variable must be
   * readable by the FIRST node. The legacy walk builds this in memory before it
   * starts; the state machine has no such moment — each node attempt is its own
   * job that reads the context from the row — so the seed has to be persisted
   * here, once, on PENDING → RUNNING.
   *
   * Stored values are seeded UNDER the trigger, so a value produced by this run
   * always beats one left behind by a previous run.
   */
  private async seedContext(run: {
    id: string;
    companyId: string;
    workflowId: string;
    trigger: unknown;
    context: unknown;
  }): Promise<void> {
    const stored = await this.prisma.workflowVariable.findMany({
      where: {
        companyId: run.companyId,
        workflowId: run.workflowId,
        scope: { in: ['WORKFLOW', 'OUTPUT'] },
      },
      select: { key: true, value: true },
    });

    const existing = (run.context ?? {}) as Record<string, unknown>;
    const seed: Record<string, unknown> = {};
    for (const variable of stored) {
      if (!(variable.key in existing)) seed[variable.key] = variable.value;
    }
    if (!('trigger' in existing)) {
      seed.trigger = (run.trigger as Record<string, unknown> | null) ?? {};
    }

    await this.state.mergeRunContext(run.id, seed);
  }

  /** Create the step + attempt rows, then queue the attempt. */
  private async enqueueAttempt(
    runId: string,
    companyId: string,
    node: WorkflowNode,
  ): Promise<void> {
    const { stepId, attemptId, attempt } = await this.prisma.$transaction(
      async (tx) => {
        const step =
          (await tx.workflowStepRun.findFirst({
            where: { runId, companyId, nodeId: node.id },
          })) ??
          (await tx.workflowStepRun.create({
            data: {
              companyId,
              runId,
              nodeId: node.id,
              type: node.type,
              status: 'PENDING',
            },
          }));

        // Reuse an attempt that has not started; otherwise open the NEXT one.
        //
        // The previous code upserted `stepId_attempt: {stepId, attempt: step.attempt}`,
        // and `step.attempt` is never incremented — so it always resolved to
        // attempt 1. After an approval pause that row is already COMPLETED, the
        // upsert's empty `update: {}` returned it unchanged, and the lease could
        // not be claimed. The run then sat RUNNING for ever with nothing to do:
        // approval granted, work never resumed.
        const pending = await tx.workflowStepAttempt.findFirst({
          where: { stepId: step.id, status: 'PENDING' },
          orderBy: { attempt: 'desc' },
        });
        if (pending) {
          return {
            stepId: step.id,
            attemptId: pending.id,
            attempt: pending.attempt,
          };
        }

        const last = await tx.workflowStepAttempt.findFirst({
          where: { stepId: step.id },
          orderBy: { attempt: 'desc' },
          select: { attempt: true },
        });
        const nextAttempt = (last?.attempt ?? 0) + 1;
        const row = await tx.workflowStepAttempt.create({
          data: {
            companyId,
            runId,
            stepId: step.id,
            attempt: nextAttempt,
            status: 'PENDING',
          },
        });
        await tx.workflowStepRun.update({
          where: { id: step.id },
          data: { attempt: nextAttempt },
        });
        return { stepId: step.id, attemptId: row.id, attempt: nextAttempt };
      },
    );

    await this.attemptQueue.add(
      WF_ATTEMPT_JOB,
      { runId, companyId, stepId, attemptId, nodeId: node.id, attempt },
      {
        // Deduplicated by attempt id: a duplicate advance cannot double-queue
        // the same attempt.
        jobId: wfJobId('attempt', attemptId),
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  private parseDefinition(run: {
    workflow: { definition: unknown };
    workflowVersion: { definition: unknown } | null;
  }): WorkflowDefinition {
    const raw = run.workflowVersion?.definition ?? run.workflow.definition;
    const def = (raw ?? {}) as Partial<WorkflowDefinition>;
    return {
      nodes: Array.isArray(def.nodes) ? (def.nodes as WorkflowNode[]) : [],
      edges: Array.isArray(def.edges) ? def.edges : [],
    };
  }
}

/** Backoff before retrying an advance that lost the run lock. */
const LOCK_RETRY_DELAY_MS = 200;

/** Where JOIN reads collected lane outputs from (JoinNodeHandler's default). */
const LANE_OUTPUT_KEY = '__lanes';

/** Mirrors the legacy walk's MAX_WORKFLOW_NODES bound. */
const MAX_STEPS_PER_RUN = 50;
