import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DEFAULT_QUEUE_CONCURRENCY } from '../../common/resilience/queue-concurrency.constants';
import { ApprovalGateService } from '../workflows/engine/approval-gate.service';
import type { NodeResult } from '../workflows/engine/nodes/node-handler';
import { NodeRegistry } from '../workflows/engine/node-registry.service';
import {
  extractValidationConcern,
  validationContextKey,
} from '../skills/tool-approval-policy';
import { AttemptLeaseService, attemptIdempotencyKey } from './attempt-lease.service';
import { branchOf } from './graph';
import { RetryPolicyService } from './retry-policy.service';
import { RunStateWriter } from './run-state-writer.service';
import { TraversalService } from './traversal.service';
import {
  nodeTimeoutMs,
  WF_ADVANCE_JOB,
  WF_ATTEMPT_JOB,
  WF_NODE_ATTEMPT_QUEUE,
  WF_RUN_ADVANCE_QUEUE,
  wfJobId,
  type AdvanceJobData,
  type NodeAttemptJobData,
} from './workflow-runtime.constants';
import type { WorkflowDefinition, WorkflowNode } from '@vaep/types';
import { runInJobContext } from '../../common/observability/job-context';

/**
 * Bound a node's execution, and CANCEL it when the bound is hit.
 *
 * The cancellation half is the point. The previous version raced the handler
 * against a timer and returned to the caller when the timer won — which freed
 * the worker slot but left the underlying work running. For an
 * `AI_EMPLOYEE_STEP` that meant the model request continued against the
 * provider's own (longer) timeout: tokens were still spent, on a request whose
 * result nobody would ever read, and whose usage row was therefore never
 * written. Unmetered spend on an abandoned request is the worst version of a
 * timeout.
 *
 * The signal is handed to the handler, which passes it to whatever it calls.
 * A handler that ignores it degrades to the old behaviour rather than breaking,
 * which is why it is optional on `NodeExecContext`.
 */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T> | T,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(run(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Abort BEFORE rejecting: by the time the caller sees the error the
          // in-flight request is already being torn down, not merely orphaned.
          controller.abort(new Error(`Node timed out after ${ms}ms`));
          reject(new Error(`Node timed out after ${ms}ms`));
        }, ms);
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
    private readonly approvals: ApprovalGateService,
    @InjectQueue(WF_RUN_ADVANCE_QUEUE)
    private readonly advanceQueue: Queue<AdvanceJobData>,
    @InjectQueue(WF_NODE_ATTEMPT_QUEUE)
    private readonly attemptQueue: Queue<NodeAttemptJobData>,
  ) {
    super();
  }

  async process(job: Job<NodeAttemptJobData>): Promise<void> {
    // Correlation: an AsyncLocalStorage store does not survive the queue
    // hop, so it is re-established here from the job payload.
    return runInJobContext(job, () => this.processJob(job));
  }

  private async processJob(job: Job<NodeAttemptJobData>): Promise<void> {
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

      // §1.10 — the approval gate is asked on EVERY attempt at the node, and
      // answers purely from Postgres. That re-entrancy is what makes approval
      // survive a restart: there is nothing in memory to lose.
      const gate = await this.approvals.evaluate({
        companyId: run.companyId,
        runId: run.id,
        node,
        context,
      });

      const result: NodeResult =
        gate.kind === 'PROCEED'
          ? await withTimeout(
              (signal) =>
                this.registry.get(node.type).execute({
                  companyId: run.companyId,
                  workflowId: run.workflowId,
                  runId: run.id,
                  stepRunId: data.stepId,
                  attemptIdempotencyKey: attemptIdempotencyKey(data.runId, data.nodeId, data.attempt),
                  node,
                  context,
                  dryRun: run.dryRun,
                  signal,
                }),
              nodeTimeoutMs(),
            )
          : gate.kind === 'PAUSE'
            ? {
                output: { awaitingApproval: true, approvalId: gate.approvalId },
                pause: {
                  reason: gate.reason,
                  approvalId: gate.approvalId,
                  resumeAtSelf: true as const,
                },
              }
            : {
                output: { approved: false, reason: gate.reason },
                // A rejection is a SAFE failure, never a silent skip: the run
                // ends and the reason is on the record.
                terminate: { status: 'FAILED' as const, reason: gate.reason },
              };

      // The node's contribution to the run context, if it declares one.
      // A handler-declared `contextKey` wins over the author's `outputKey` —
      // see NodeResult.contextKey for why that distinction exists.
      const outputKey =
        result.contextKey?.trim() ||
        (typeof node.config?.outputKey === 'string'
          ? node.config.outputKey.trim()
          : '');
      const contextPatch: Record<string, unknown> =
        outputKey && 'contextValue' in result
          ? { [outputKey]: result.contextValue }
          : {};
      // S-01: thread any validation concern into context, regardless of
      // whether the handler also declared an outputKey — mirrors the legacy
      // walk's identical write in workflow-engine.service.ts.
      if (extractValidationConcern(result.output)) {
        contextPatch[validationContextKey(node.id)] = true;
      }

      // A paused step has NOT done its work — it decided to wait. Marking it
      // COMPLETED would make it terminal, and the resumed run could then never
      // re-enter the node (COMPLETED → RUNNING is an illegal step transition),
      // so the run would sit WAITING for ever after the approval was granted.
      const pausing = Boolean(result.pause);

      // ── T2: record the outcome atomically with its outbox event ───────────
      await this.prisma.$transaction(async (tx) => {
        await tx.workflowStepAttempt.update({
          where: { id: data.attemptId },
          data: {
            // The ATTEMPT did finish either way — it reached a decision.
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
            to: pausing ? 'WAITING' : 'COMPLETED',
            output: result.output,
            // W1-b: the routing decision commits WITH the completion, so a crash
            // can never leave a COMPLETED step whose branch was lost — which
            // would silently route the resumed run down the default edge.
            ...(pausing ? {} : { branch: branchOf(result) }),
            event: pausing ? 'step.waiting' : 'step.completed',
          },
          tx,
        );
        // W1-c: a jsonb merge, NOT a read-modify-write. Two PARALLEL lanes are
        // genuinely concurrent here, and spreading a context read at job start
        // would let the second lane's write erase the first lane's output.
        await this.state.mergeRunContext(run.id, contextPatch, tx);
      });

      // Control flow AFTER the bookkeeping commit (P2 traversal). Before T2 we
      // could enqueue lanes for a step whose own result never committed.
      //
      // W1-d: pass the POST-step context. Passing the context read at job start
      // meant a pause or fan-out persisted a context missing the very step that
      // triggered it — the resumed run then read a stale value.
      const outcome = await this.traversal.applyDirective({
        runId: run.id,
        companyId: run.companyId,
        node,
        definition,
        context: { ...context, ...contextPatch },
        result,
      });
      if (outcome.kind !== 'CONTINUE') {
        directive = 'STOP';
      }
    } catch (error) {
      const failure = await this.recordFailure(data, run.companyId, error);
      // A scheduled retry OWNS the run from here: the delayed attempt job is
      // what continues it. Enqueueing an advance as well would find the step
      // still un-settled and queue a SECOND attempt of the same node — two
      // concurrent executions of a side effect from one failure.
      if (failure === 'RETRY_SCHEDULED') directive = 'STOP';
    } finally {
      stopHeartbeat();
    }

    // AFTER the commit — never inside T2. `fromNodeId` makes the advance a single
    // hop; it is only a hint, and the advance recomputes without it.
    if (directive === 'CONTINUE') {
      await this.advanceQueue.add(
        WF_ADVANCE_JOB,
        { runId: run.id, companyId: run.companyId, fromNodeId: data.nodeId },
        { removeOnComplete: true, removeOnFail: 100 },
      );
    }
  }

  /**
   * Classify, persist, and schedule a retry as a NEW delayed job if warranted.
   *
   * Returns who owns the run next: `RETRY_SCHEDULED` means the delayed attempt
   * job does, `STEP_FAILED` means the advance worker does (it finalises the run
   * as FAILED).
   */
  private async recordFailure(
    data: NodeAttemptJobData,
    companyId: string,
    error: unknown,
  ): Promise<'RETRY_SCHEDULED' | 'STEP_FAILED'> {
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
      return 'STEP_FAILED';
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
        // Credit-system prerequisite (Phase 1, Task 1.2): call-level replay-safety
        // key. Distinct from CreditReservation's step-level idempotency key.
        idempotencyKey: attemptIdempotencyKey(data.runId, data.nodeId, next),
      },
    });

    await this.attemptQueue.add(
      WF_ATTEMPT_JOB,
      { ...data, attemptId: created.id, attempt: next },
      {
        delay: decision.delayMs,
        jobId: wfJobId('attempt', created.id),
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    return 'RETRY_SCHEDULED';
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
