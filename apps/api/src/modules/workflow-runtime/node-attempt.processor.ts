import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../common/resilience/queue-concurrency.constants';
import { NodeRegistry } from '../workflows/engine/node-registry.service';
import { AttemptLeaseService } from './attempt-lease.service';
import { RetryPolicyService } from './retry-policy.service';
import { RunStateWriter } from './run-state-writer.service';
import { TraversalService } from './traversal.service';
import {
  DEFAULT_NODE_TIMEOUT_MS,
  WF_ADVANCE_JOB,
  WF_ATTEMPT_JOB,
  WF_NODE_ATTEMPT_QUEUE,
  WF_RUN_ADVANCE_QUEUE,
  type AdvanceJobData,
  type NodeAttemptJobData,
} from './workflow-runtime.constants';
import type { WorkflowDefinition, WorkflowNode } from '@vaep/types';

/** Reject a promise that outruns its budget, so a hung node frees its slot. */
async function withTimeout<T>(p: Promise<T> | T, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Node timed out after ${ms}ms`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * P1-04 — executes ONE node attempt (doc 16 §6.6).
 *
 * The three-phase structure is the heart of the design (§6.5, ambiguity A4):
 *
 *   T1 (tx): claim the lease, mark the attempt RUNNING           → commit
 *            execute the node's side effect — NO transaction open
 *   T2 (tx): record the result + step status + outbox row        → commit
 *            enqueue the next advance — AFTER the commit
 *
 * The window between the effect and T2 is the only unsafe gap, and it CANNOT be
 * eliminated without provider-side two-phase commit. It is bounded and detected
 * by the reaper: the lease expires, the attempt is found RUNNING past its
 * lease, and it is marked FAILED with `outcomeUnknown` rather than blindly
 * retried. Retrying a possibly-completed side effect is the worse failure.
 *
 * The next advance is never enqueued inside T2 — if T2 rolled back, the job
 * would already be on the queue and would act on state that never committed.
 */
@Processor(WF_NODE_ATTEMPT_QUEUE, { concurrency: DEFAULT_QUEUE_CONCURRENCY })
export class NodeAttemptProcessor extends WorkerHost {
  private readonly logger = new Logger(NodeAttemptProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: AttemptLeaseService,
    private readonly state: RunStateWriter,
    private readonly retry: RetryPolicyService,
    private readonly registry: NodeRegistry,
    private readonly traversal: TraversalService,
    @InjectQueue(WF_RUN_ADVANCE_QUEUE)
    private readonly advanceQueue: Queue<AdvanceJobData>,
    @InjectQueue(WF_NODE_ATTEMPT_QUEUE)
    private readonly attemptQueue: Queue<NodeAttemptJobData>,
  ) {
    super();
  }

  async process(job: Job<NodeAttemptJobData>): Promise<void> {
    const data = job.data;

    // SECURITY (doc 16 §20): never trust the companyId in a job payload. Load
    // the run and compare — a forged or stale payload is otherwise a
    // cross-tenant execution.
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: data.runId },
      include: { workflow: true, workflowVersion: true },
    });
    if (!run) {
      this.logger.warn(`attempt: run not found run=${data.runId}`);
      return;
    }
    if (run.companyId !== data.companyId) {
      this.logger.error(
        `SECURITY: attempt job companyId mismatch job=${data.companyId} run=${run.companyId} run=${data.runId}`,
      );
      throw new Error('Tenant mismatch between job payload and run');
    }

    // ── T1: claim the lease ────────────────────────────────────────────────
    const lease = await this.leases.claim(data.attemptId);
    if (!lease) {
      // Another worker owns it. Not an error — exit quietly.
      return;
    }
    const stopHeartbeat = this.leases.startHeartbeat(data.attemptId);

    const definition = this.parseDefinition(run);
    const node = definition.nodes.find((n) => n.id === data.nodeId);
    // Whether the generic advance should run afterwards. A fan-out has already
    // enqueued its lanes and a pause/terminate has already moved the run, so a
    // further advance would duplicate work or act on a finished run.
    let directive: 'CONTINUE' | 'STOP' = 'CONTINUE';

    try {
      if (!node) {
        throw new Error(`Unknown node id "${data.nodeId}" in this version`);
      }

      await this.state.transitionStep({
        stepId: data.stepId,
        runId: run.id,
        companyId: run.companyId,
        to: 'RUNNING',
        event: 'step.started',
      });

      // ── The side effect. No transaction is open here, on purpose. ─────────
      const context = (run.context ?? {}) as Record<string, unknown>;
      const result = await withTimeout(
        this.registry.get(node.type).execute({
          companyId: run.companyId,
          workflowId: run.workflowId,
          runId: run.id,
          node,
          context,
          dryRun: run.dryRun,
        }),
        DEFAULT_NODE_TIMEOUT_MS,
      );

      // ── T2: record the outcome atomically with its outbox event ───────────
      await this.prisma.$transaction(async (tx) => {
        await tx.workflowStepAttempt.update({
          where: { id: data.attemptId },
          data: {
            status: 'COMPLETED',
            output: (result.output ?? {}) as never,
            finishedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        await this.state.transitionStep(
          {
            stepId: data.stepId,
            runId: run.id,
            companyId: run.companyId,
            to: 'COMPLETED',
            output: result.output,
            event: 'step.completed',
          },
          tx,
        );
        // Thread the node's contribution into the run context.
        const outputKey = node.config?.outputKey;
        if (typeof outputKey === 'string' && outputKey && 'contextValue' in result) {
          await tx.workflowRun.update({
            where: { id: run.id },
            data: {
              context: {
                ...context,
                [outputKey]: result.contextValue,
              } as never,
            },
          });
        }
      });
      // Control flow AFTER the bookkeeping commit (P2 traversal). Before T2 we
      // could enqueue lanes for a step whose own result never committed.
      const outcome = await this.traversal.applyDirective({
        runId: run.id,
        companyId: run.companyId,
        node,
        definition,
        context: (run.context ?? {}) as Record<string, unknown>,
        result,
      });
      if (outcome.kind !== 'CONTINUE') {
        directive = 'STOP';
      }
    } catch (error) {
      await this.recordFailure(data, run.companyId, error);
    } finally {
      stopHeartbeat();
    }

    // AFTER the commit — never inside T2.
    if (directive === 'CONTINUE') {
      await this.advanceQueue.add(
        WF_ADVANCE_JOB,
        { runId: run.id, companyId: run.companyId },
        { removeOnComplete: true, removeOnFail: 100 },
      );
    }
  }

  /** Classify, persist, and schedule a retry as a NEW delayed job if warranted. */
  private async recordFailure(
    data: NodeAttemptJobData,
    companyId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const decision = this.retry.classify(error, data.attempt);

    await this.prisma.workflowStepAttempt.update({
      where: { id: data.attemptId },
      data: {
        status: 'FAILED',
        error: message,
        failureClass: decision.failureClass,
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });

    this.logger.warn(
      `attempt failed run=${data.runId} node=${data.nodeId} attempt=${data.attempt} ` +
        `class=${decision.failureClass} retry=${decision.retry} — ${message}`,
    );

    if (!decision.retry) {
      await this.state.transitionStep({
        stepId: data.stepId,
        runId: data.runId,
        companyId,
        to: 'FAILED',
        error: message,
        event: 'step.failed',
      });
      return;
    }

    // The runtime owns retry — BullMQ `attempts` stays 1 so the three retry
    // layers cannot compound (doc 16 §12). A retry is a NEW attempt row, so the
    // count is visible in the database rather than hidden inside Redis.
    await this.state.transitionStep({
      stepId: data.stepId,
      runId: data.runId,
      companyId,
      to: 'RETRYING',
      error: message,
      event: 'step.retrying',
    });

    const next = data.attempt + 1;
    const created = await this.prisma.workflowStepAttempt.create({
      data: {
        companyId,
        runId: data.runId,
        stepId: data.stepId,
        attempt: next,
        status: 'PENDING',
      },
    });

    await this.attemptQueue.add(
      WF_ATTEMPT_JOB,
      { ...data, attemptId: created.id, attempt: next },
      {
        delay: decision.delayMs,
        jobId: `attempt:${created.id}`,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  private parseDefinition(run: {
    workflow: { definition: unknown };
    workflowVersion: { definition: unknown } | null;
  }): WorkflowDefinition {
    // Prefer the pinned version; fall back to the workflow's current definition
    // for runs created before versioning (P1-02 leaves that null on purpose).
    const raw = run.workflowVersion?.definition ?? run.workflow.definition;
    const def = (raw ?? {}) as Partial<WorkflowDefinition>;
    return {
      nodes: Array.isArray(def.nodes) ? (def.nodes as WorkflowNode[]) : [],
      edges: Array.isArray(def.edges) ? def.edges : [],
    };
  }
}
