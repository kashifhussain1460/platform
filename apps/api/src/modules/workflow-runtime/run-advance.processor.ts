import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { WorkflowDefinition, WorkflowNode } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AttemptLeaseService } from './attempt-lease.service';
import { LOCK_NOT_ACQUIRED, RunLockService } from './run-lock.service';
import { RunStateWriter } from './run-state-writer.service';
import { TraversalService } from './traversal.service';
import { isTerminalRunStatus } from './run-state';
import {
  WF_ATTEMPT_JOB,
  WF_NODE_ATTEMPT_QUEUE,
  WF_RUN_ADVANCE_QUEUE,
  type AdvanceJobData,
  type NodeAttemptJobData,
} from './workflow-runtime.constants';

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
  ) {
    super();
  }

  async process(job: Job<AdvanceJobData>): Promise<void> {
    const { runId, companyId } = job.data;

    const outcome = await this.locks.withRunLock(runId, async () =>
      this.decide(runId, companyId),
    );

    if (outcome === LOCK_NOT_ACQUIRED) {
      // Another worker is advancing this run and will enqueue what comes next.
      return;
    }
  }

  /** Runs INSIDE the run's advisory lock. */
  private async decide(runId: string, companyId: string): Promise<void> {
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

    const next = await this.nextNode(run.id, companyId, definition, run.resumeNodeId);
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

    // A JOIN may only proceed once every fanned-out lane has arrived. Without
    // this the run would sail past the join while lanes were still running, and
    // downstream steps would read half-populated context.
    if (next.type === 'JOIN') {
      const join = await this.traversal.recordLaneArrival(run.id, next.id);
      if (!join.complete) {
        this.logger.debug(
          `advance: join ${next.id} waiting (${join.arrived}/${join.expected}) run=${run.id}`,
        );
        return;
      }
    }

    await this.enqueueAttempt(run.id, companyId, next);
  }

  /**
   * The next node to execute, or undefined when the run is finished.
   *
   * Deliberately simple for the first cutover: resume where told, else the
   * first node with no completed step. Branch selection continues to be owned
   * by the legacy walk until the state machine takes over graph traversal —
   * keeping this wave's blast radius to state management, not routing.
   */
  private async nextNode(
    runId: string,
    companyId: string,
    definition: WorkflowDefinition,
    resumeNodeId: string | null,
  ): Promise<WorkflowNode | undefined> {
    if (resumeNodeId) {
      return definition.nodes.find((n) => n.id === resumeNodeId);
    }
    const done = await this.prisma.workflowStepRun.findMany({
      where: { runId, companyId, status: { in: ['COMPLETED', 'SKIPPED'] } },
      select: { nodeId: true },
    });
    const doneIds = new Set(done.map((d) => d.nodeId));
    return definition.nodes.find((n) => !doneIds.has(n.id));
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

        const nextAttempt = step.attempt;
        const row = await tx.workflowStepAttempt.upsert({
          where: { stepId_attempt: { stepId: step.id, attempt: nextAttempt } },
          create: {
            companyId,
            runId,
            stepId: step.id,
            attempt: nextAttempt,
            status: 'PENDING',
          },
          update: {},
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
        jobId: `attempt:${attemptId}`,
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

/** Mirrors the legacy walk's MAX_WORKFLOW_NODES bound. */
const MAX_STEPS_PER_RUN = 50;
