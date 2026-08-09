import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { WorkflowDefinition, WorkflowNode } from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { NodeResult } from '../workflows/engine/nodes/node-handler';
import { RunStateWriter } from './run-state-writer.service';
import {
  WF_ATTEMPT_JOB,
  WF_NODE_ATTEMPT_QUEUE,
  type NodeAttemptJobData,
} from './workflow-runtime.constants';

/** Reserved context key holding a LOOP's iteration cursor, per loop node. */
const LOOP_CURSOR_KEY = '__loopCursor';

export type TraversalOutcome =
  /** Nothing special — the advance worker picks the next node normally. */
  | { kind: 'CONTINUE' }
  /** The run was moved to a terminal or waiting state; stop. */
  | { kind: 'HALTED' }
  /** Work was enqueued directly (lanes, next loop iteration); stop. */
  | { kind: 'DISPATCHED' };

/**
 * P1/P2 — traversal for the DURABLE state machine.
 *
 * The legacy walk implements control flow with recursive in-process sub-walks.
 * The state machine cannot: each node attempt is a separate BullMQ job, possibly
 * on a different worker, so "run these lanes then continue" has to be expressed
 * as persisted state plus enqueued jobs.
 *
 * That constraint is also the payoff: lanes become GENUINELY concurrent here
 * (N independent attempt jobs, picked up by N workers) rather than the legacy
 * walk's `Promise.all` inside one process.
 *
 * `WorkflowJoinState` is the fan-in bookkeeping — `expected` set at fan-out,
 * `arrived` incremented atomically as each lane finishes.
 */
@Injectable()
export class TraversalService {
  private readonly logger = new Logger(TraversalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: RunStateWriter,
    @InjectQueue(WF_NODE_ATTEMPT_QUEUE)
    private readonly attemptQueue: Queue<NodeAttemptJobData>,
  ) {}

  /**
   * Act on whatever directive a handler returned. Called by the attempt
   * processor after a node executes successfully.
   */
  async applyDirective(input: {
    runId: string;
    companyId: string;
    node: WorkflowNode;
    definition: WorkflowDefinition;
    context: Record<string, unknown>;
    result: NodeResult;
  }): Promise<TraversalOutcome> {
    const { runId, companyId, node, definition, context, result } = input;

    if (result.pause) {
      await this.state.transitionRun({
        runId,
        companyId,
        to: 'WAITING',
        context,
        // Resume at THIS node: its work has not happened yet.
        resumeNodeId: node.id,
        event: 'run.waiting',
        eventData: { nodeId: node.id, reason: result.pause.reason },
      });
      this.logger.log(
        `traversal.pause run=${runId} node=${node.id} — ${result.pause.reason}`,
      );
      return { kind: 'HALTED' };
    }

    if (result.terminate) {
      const { status, reason } = result.terminate;
      await this.state.transitionRun({
        runId,
        companyId,
        to: status,
        context,
        resumeNodeId: null,
        ...(status === 'FAILED'
          ? { error: reason ?? `Terminated at node "${node.id}"` }
          : {}),
        event: status === 'FAILED' ? 'run.failed' : 'run.completed',
        eventData: { terminatedAt: node.id, reason: reason ?? null },
      });
      return { kind: 'HALTED' };
    }

    if (result.fanOut) {
      return this.fanOut({ runId, companyId, node, definition, result });
    }

    if (result.iterate) {
      return this.startIteration({ runId, companyId, node, context, result });
    }

    return { kind: 'CONTINUE' };
  }

  /**
   * Create the join bookkeeping and enqueue one attempt per lane.
   *
   * Truly concurrent: each lane is its own job, so N workers can run N lanes at
   * the same instant. The legacy walk can only interleave within one process.
   */
  private async fanOut(input: {
    runId: string;
    companyId: string;
    node: WorkflowNode;
    definition: WorkflowDefinition;
    result: NodeResult;
  }): Promise<TraversalOutcome> {
    const { runId, companyId, node, definition, result } = input;
    const { lanes, joinNodeId, mode } = result.fanOut!;
    const selected = mode === 'ANY' ? lanes.slice(0, 1) : lanes;

    for (const laneId of selected) {
      if (!definition.nodes.some((n) => n.id === laneId)) {
        throw new Error(
          `PARALLEL node "${node.id}" references unknown lane start "${laneId}"`,
        );
      }
    }

    await this.prisma.workflowJoinState.upsert({
      where: { runId_joinNodeId: { runId, joinNodeId } },
      create: {
        companyId,
        runId,
        joinNodeId,
        expected: selected.length,
        arrived: 0,
      },
      // Idempotent: a duplicate-delivered fan-out must not double `expected`.
      update: { expected: selected.length },
    });

    for (const laneId of selected) {
      const laneNode = definition.nodes.find((n) => n.id === laneId) as WorkflowNode;
      await this.enqueueNode({ runId, companyId, node: laneNode });
    }

    this.logger.log(
      `traversal.fanout run=${runId} node=${node.id} lanes=${selected.length} join=${joinNodeId} mode=${mode}`,
    );
    return { kind: 'DISPATCHED' };
  }

  /**
   * Record a lane's arrival at its join. Returns true when every expected lane
   * has arrived and the run may continue past the JOIN.
   *
   * The increment is a single atomic `UPDATE … SET arrived = arrived + 1`.
   * A read-then-write would lose an arrival whenever two lanes finish together —
   * and then the run would wait forever on a lane that had already completed.
   */
  async recordLaneArrival(
    runId: string,
    joinNodeId: string,
  ): Promise<{ arrived: number; expected: number; complete: boolean }> {
    const rows = await this.prisma.$queryRaw<
      { arrived: number; expected: number }[]
    >`
      UPDATE "WorkflowJoinState"
         SET "arrived" = "arrived" + 1
       WHERE "runId" = ${runId} AND "joinNodeId" = ${joinNodeId}
      RETURNING "arrived", "expected"
    `;
    const row = rows[0];
    if (!row) {
      // No join state means this node was not reached via a fan-out — treat it
      // as immediately satisfied rather than blocking a legitimate linear run.
      return { arrived: 0, expected: 0, complete: true };
    }
    const complete = row.arrived >= row.expected;
    if (complete) {
      await this.prisma.workflowJoinState.updateMany({
        where: { runId, joinNodeId, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
    }
    return { ...row, complete };
  }

  /** Bind the first item and enqueue the loop body. */
  private async startIteration(input: {
    runId: string;
    companyId: string;
    node: WorkflowNode;
    context: Record<string, unknown>;
    result: NodeResult;
  }): Promise<TraversalOutcome> {
    const { runId, companyId, node, context, result } = input;
    const { items, itemVar, bodyNodeId } = result.iterate!;

    if (items.length === 0) {
      // Nothing to iterate — fall through to the normal next node.
      return { kind: 'CONTINUE' };
    }

    await this.advanceLoopCursor({
      runId,
      companyId,
      loopNodeId: node.id,
      context,
      items,
      itemVar,
      bodyNodeId,
      nextIndex: 0,
    });
    return { kind: 'DISPATCHED' };
  }

  /**
   * Move a loop to `nextIndex`, or report exhaustion.
   *
   * The cursor lives in the run CONTEXT rather than a dedicated table: it is
   * per-run state that dies with the run, and the context is already persisted
   * transactionally with every step.
   */
  async advanceLoopCursor(input: {
    runId: string;
    companyId: string;
    loopNodeId: string;
    context: Record<string, unknown>;
    items: unknown[];
    itemVar: string;
    bodyNodeId: string;
    nextIndex: number;
  }): Promise<{ dispatched: boolean }> {
    const {
      runId,
      companyId,
      loopNodeId,
      context,
      items,
      itemVar,
      bodyNodeId,
      nextIndex,
    } = input;

    if (nextIndex >= items.length) {
      const cursors = { ...(context[LOOP_CURSOR_KEY] as object | undefined) };
      delete (cursors as Record<string, unknown>)[loopNodeId];
      await this.prisma.workflowRun.update({
        where: { id: runId },
        data: { context: { ...context, [LOOP_CURSOR_KEY]: cursors } as never },
      });
      return { dispatched: false };
    }

    const cursors = {
      ...(context[LOOP_CURSOR_KEY] as Record<string, unknown> | undefined),
      [loopNodeId]: { index: nextIndex, itemVar, bodyNodeId, total: items.length },
    };

    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: {
        context: {
          ...context,
          [itemVar]: items[nextIndex],
          [`${itemVar}Index`]: nextIndex,
          [LOOP_CURSOR_KEY]: cursors,
        } as never,
      },
    });

    const body = await this.prisma.workflowStepRun.findFirst({
      where: { runId, companyId, nodeId: bodyNodeId },
      select: { id: true },
    });
    // Each iteration is a NEW attempt on the body step, so the attempt history
    // shows every pass rather than overwriting one row.
    await this.enqueueNode({
      runId,
      companyId,
      node: { id: bodyNodeId, type: 'NOOP', config: {} } as WorkflowNode,
      existingStepId: body?.id,
    });

    this.logger.log(
      `traversal.loop run=${runId} node=${loopNodeId} iteration=${nextIndex + 1}/${items.length}`,
    );
    return { dispatched: true };
  }

  /** Read a loop's cursor, if it has one in flight. */
  readLoopCursor(
    context: Record<string, unknown>,
    loopNodeId: string,
  ): { index: number; itemVar: string; bodyNodeId: string; total: number } | null {
    const cursors = context[LOOP_CURSOR_KEY] as
      | Record<string, { index: number; itemVar: string; bodyNodeId: string; total: number }>
      | undefined;
    return cursors?.[loopNodeId] ?? null;
  }

  /** Create (or reuse) the step + attempt rows and queue the attempt. */
  private async enqueueNode(input: {
    runId: string;
    companyId: string;
    node: WorkflowNode;
    existingStepId?: string;
  }): Promise<void> {
    const { runId, companyId, node } = input;

    const { stepId, attemptId, attempt } = await this.prisma.$transaction(
      async (tx) => {
        const step =
          (input.existingStepId
            ? await tx.workflowStepRun.findUnique({
                where: { id: input.existingStepId },
              })
            : await tx.workflowStepRun.findFirst({
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

        // A re-entered node (loop body) gets the NEXT attempt number so its
        // history is preserved rather than overwritten.
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
        return { stepId: step.id, attemptId: row.id, attempt: nextAttempt };
      },
    );

    await this.attemptQueue.add(
      WF_ATTEMPT_JOB,
      { runId, companyId, stepId, attemptId, nodeId: node.id, attempt },
      {
        jobId: `attempt:${attemptId}`,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}
