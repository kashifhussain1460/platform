import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StepRunStatus, WorkflowRunStatus } from '@vaep/types';
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

  constructor(private readonly prisma: PrismaService) {}

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

    return true;
  }

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

    return true;
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
