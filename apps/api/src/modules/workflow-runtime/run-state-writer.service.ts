import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StepRunStatus, WorkflowRunStatus } from '@vaep/types';
import { enrichContext } from '../../common/observability/execution-context';
import {
  METRIC,
  MetricsRegistry,
} from '../../common/observability/metrics.registry';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PrismaTransaction } from './run-lock.service';
import {
  assertRunTransition,
  assertStepTransition,
  isTerminalRunStatus,
} from './run-state';
import { MAX_NODE_OUTPUT_BYTES } from './workflow-runtime.constants';

/** Event types written to the outbox (doc 16 §17). */
export type RunEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.timed_out'
  | 'run.waiting'
  | 'run.resumed'
  | 'run.compensating'
  | 'step.started'
  /** WAVE 1: the step reached a human gate and is holding, not finished. */
  | 'step.waiting'
  | 'step.completed'
  | 'step.failed'
  | 'step.retrying'
  | 'step.skipped'
  | 'step.compensated';

interface TransitionRunInput {
  runId: string;
  companyId: string;
  to: WorkflowRunStatus;
  error?: string | null;
  failureClass?: string | null;
  context?: Record<string, unknown> | null;
  resumeNodeId?: string | null;
  event: RunEventType;
  eventData?: Record<string, unknown>;
}

interface TransitionStepInput {
  stepId: string;
  runId: string;
  companyId: string;
  to: StepRunStatus;
  output?: unknown;
  error?: string | null;
  /**
   * WAVE 1 (W1-b): the outgoing edge this node selected. Written with the step's
   * own status change so routing and completion commit together — a step that is
   * COMPLETED but whose branch never landed would route the run down the wrong
   * path after a crash.
   */
  branch?: string | null;
  event: RunEventType;
}

/**
 * P1-04 — THE only writer of run and step status.
 *
 * Two invariants live here and nowhere else:
 *
 *  1. **Every transition is checked** against the matrix in `run-state.ts`, so
 *     an illegal one throws instead of silently producing a run in a state
 *     nobody can explain.
 *
 *  2. **Every externally-visible change writes its outbox row in the SAME
 *     transaction.** A direct publish would either fire for a transaction that
 *     later rolled back, or be lost when the process dies between commit and
 *     publish. The transactional outbox makes the event and the state change
 *     atomically consistent; a relay publishes them afterwards.
 *
 * Callers must not write `status` directly. Doing so bypasses both invariants.
 */
@Injectable()
export class RunStateWriter {
  private readonly logger = new Logger(RunStateWriter.name);

  constructor(
    private readonly prisma: PrismaService,
    // WAVE 5 §5.3 — THE choke point for run/step lifecycle metrics. Every
    // transition already goes through here by contract, so instrumenting this
    // one class covers the whole runtime without touching a single handler.
    private readonly metrics: MetricsRegistry,
  ) {}

  /**
   * Transition a run, guarded by its current status, and emit an outbox event.
   * Returns false when the run had already moved on (a late job) — that is a
   * normal race, not an error, so the caller should just stop.
   */
  async transitionRun(
    input: TransitionRunInput,
    tx?: PrismaTransaction,
  ): Promise<boolean> {
    const client = tx ?? this.prisma;

    const run = await client.workflowRun.findFirst({
      where: { id: input.runId, companyId: input.companyId },
      select: { status: true },
    });
    if (!run) {
      this.logger.warn(`transitionRun: run not found run=${input.runId}`);
      return false;
    }
    if (run.status === input.to) {
      return false; // Idempotent: already there.
    }
    if (isTerminalRunStatus(run.status)) {
      // A late job arriving after the run finished. Expected under at-least-once
      // delivery; log at debug and drop rather than throwing it into the DLQ.
      this.logger.debug(
        `transitionRun: run already terminal run=${input.runId} status=${run.status} wanted=${input.to}`,
      );
      return false;
    }

    assertRunTransition(run.status, input.to);

    const now = new Date();
    await client.workflowRun.update({
      where: { id: input.runId },
      data: {
        status: input.to,
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.failureClass !== undefined
          ? { failureClass: input.failureClass }
          : {}),
        ...(input.context !== undefined
          ? { context: (input.context ?? Prisma.JsonNull) as Prisma.InputJsonValue }
          : {}),
        ...(input.resumeNodeId !== undefined
          ? { resumeNodeId: input.resumeNodeId }
          : {}),
        ...(input.to === 'RUNNING' && run.status === 'PENDING'
          ? { startedAt: now }
          : {}),
        ...(isTerminalRunStatus(input.to) ? { finishedAt: now } : {}),
      },
    });

    await this.emit(client, {
      companyId: input.companyId,
      runId: input.runId,
      eventType: input.event,
      payload: { from: run.status, to: input.to, ...(input.eventData ?? {}) },
    });

    this.recordRunMetrics(input, run.status);
    return true;
  }

  /** WAVE 5 §5.3 — workflow_runs/success/failure + duration. */
  private recordRunMetrics(
    input: TransitionRunInput,
    from: WorkflowRunStatus,
  ): void {
    // Correlate everything logged downstream of this transition.
    enrichContext({ workflowRunId: input.runId, companyId: input.companyId });

    if (input.to === 'RUNNING' && from === 'PENDING') {
      this.metrics.counter(
        METRIC.workflowRunsTotal,
        'Workflow runs started',
        {},
      );
      this.startedAt.set(input.runId, Date.now());
    }
    if (input.to === 'COMPLETED') {
      this.metrics.counter(
        METRIC.workflowSuccessTotal,
        'Workflow runs that completed successfully',
        {},
      );
    }
    if (input.to === 'FAILED' || input.to === 'TIMED_OUT') {
      this.metrics.counter(
        METRIC.workflowFailureTotal,
        'Workflow runs that failed',
        { failure_class: input.failureClass ?? 'UNKNOWN' },
      );
    }
    if (isTerminalRunStatus(input.to)) {
      const started = this.startedAt.get(input.runId);
      if (started !== undefined) {
        this.metrics.observe(
          METRIC.workflowDurationMs,
          'End-to-end workflow run duration',
          Date.now() - started,
          { status: input.to },
        );
        this.startedAt.delete(input.runId);
      }
    }
  }

  /**
   * Run start times, for duration.
   *
   * In memory and therefore best-effort: a run that starts on one worker and
   * finishes on another simply records no duration, rather than a wrong one.
   * Deriving it from `startedAt`/`finishedAt` in Postgres would always be right
   * but needs a read on every terminal transition; the histogram is for trend,
   * not for billing, so the cheap version is the correct trade. Entries are
   * always deleted on the terminal transition, so this cannot grow unbounded
   * for runs this process actually finishes.
   */
  private readonly startedAt = new Map<string, number>();

  /** Transition a step, guarded, with its outbox event, in one transaction. */
  async transitionStep(
    input: TransitionStepInput,
    tx?: PrismaTransaction,
  ): Promise<boolean> {
    const client = tx ?? this.prisma;

    const step = await client.workflowStepRun.findFirst({
      where: { id: input.stepId, companyId: input.companyId },
      select: { status: true, nodeId: true },
    });
    if (!step) return false;
    if (step.status === input.to) return false;

    assertStepTransition(step.status, input.to);

    const now = new Date();
    await client.workflowStepRun.update({
      where: { id: input.stepId },
      data: {
        status: input.to,
        ...(input.output !== undefined
          ? { output: this.capOutput(input.output) }
          : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.to === 'RUNNING' ? { startedAt: now } : {}),
        ...(['COMPLETED', 'FAILED', 'SKIPPED', 'COMPENSATED'].includes(input.to)
          ? { finishedAt: now }
          : {}),
      },
    });

    await this.emit(client, {
      companyId: input.companyId,
      runId: input.runId,
      eventType: input.event,
      payload: {
        stepId: input.stepId,
        nodeId: step.nodeId,
        from: step.status,
        to: input.to,
      },
    });

    // WAVE 5 §5.3 — step duration + retry counter.
    if (input.to === 'RETRYING') {
      this.metrics.counter(
        METRIC.workflowRetryTotal,
        'Step retries scheduled',
        {},
      );
    }
    if (input.to === 'RUNNING') {
      this.stepStartedAt.set(input.stepId, Date.now());
    } else if (['COMPLETED', 'FAILED', 'SKIPPED'].includes(input.to)) {
      const started = this.stepStartedAt.get(input.stepId);
      if (started !== undefined) {
        this.metrics.observe(
          METRIC.stepDurationMs,
          'Individual workflow step duration',
          Date.now() - started,
          { status: input.to },
        );
        this.stepStartedAt.delete(input.stepId);
      }
    }

    return true;
  }

  /** Step start times; same best-effort trade as `startedAt` above. */
  private readonly stepStartedAt = new Map<string, number>();

  /**
   * WAVE 1 (gap W1-c) — merge keys into a run's context ATOMICALLY.
   *
   * The obvious implementation is read `run.context`, spread the new key in, and
   * write the whole object back. That is a read-modify-write on a single row, and
   * the durable runtime makes PARALLEL lanes GENUINELY concurrent — two lanes on
   * two workers each read the same context and each write their own copy, so the
   * second commit silently erases the first lane's output. Nothing errors; a key
   * is simply missing later, usually in a downstream template that renders empty.
   *
   * `jsonb || jsonb` does the merge inside Postgres, on the row's own lock, so
   * concurrent lanes writing DIFFERENT keys both survive. (Two lanes writing the
   * SAME key still last-writer-wins — that is a workflow-design conflict, not a
   * data race, and no merge strategy can resolve it.)
   */
  async mergeRunContext(
    runId: string,
    patch: Record<string, unknown>,
    tx?: PrismaTransaction,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const client = tx ?? this.prisma;
    await client.$executeRaw`
      UPDATE "WorkflowRun"
         SET "context" = COALESCE("context", '{}'::jsonb) || ${JSON.stringify(
           patch,
         )}::jsonb
       WHERE "id" = ${runId}
    `;
  }

  /**
   * Append an outbox row. Always takes the caller's transaction client so the
   * event cannot outlive a rolled-back state change.
   */
  async emit(
    client: PrismaTransaction | PrismaService,
    input: {
      companyId: string;
      runId: string;
      eventType: RunEventType;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.runEventOutbox.create({
      data: {
        companyId: input.companyId,
        runId: input.runId,
        eventType: input.eventType,
        // Identifiers and status only — never a secret or a resolved
        // credential, because outbox rows surface in DLQ dumps.
        payload: input.payload as Prisma.InputJsonObject,
      },
    });
  }

  /**
   * Truncate an oversized node output rather than persisting it whole.
   * A node returning a multi-megabyte payload is a common OOM, and a run log
   * nobody can open is worse than a truncated one.
   */
  private capOutput(output: unknown): Prisma.InputJsonValue {
    if (output == null) return Prisma.JsonNull as unknown as Prisma.InputJsonValue;
    const json = JSON.stringify(output);
    if (json.length <= MAX_NODE_OUTPUT_BYTES) {
      return output as Prisma.InputJsonValue;
    }
    this.logger.warn(
      `node output truncated: ${json.length} bytes exceeds ${MAX_NODE_OUTPUT_BYTES}`,
    );
    return {
      truncated: true,
      originalBytes: json.length,
      preview: json.slice(0, 2_000),
    } as Prisma.InputJsonValue;
  }
}
