import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Workflow, type WorkflowRun } from '@prisma/client';
import type { Queue } from 'bullmq';
import type {
  ApprovalNodeConfig,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { BillingService } from '../../billing/billing.service';
import { ApprovalRoutingService } from '../../approval-routing/approval-routing.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { toolRequiresApproval } from '../../skills/tool-approval-policy';
import { EngineModeService } from '../../workflow-runtime/engine-mode';
import {
  WF_ADVANCE_JOB,
  WF_RUN_ADVANCE_QUEUE,
  type AdvanceJobData,
} from '../../workflow-runtime/workflow-runtime.constants';
import {
  MAX_WORKFLOW_NODES,
  WORKFLOW_RUN_STUCK_TIMEOUT_MS,
} from '../workflows.constants';
import { resolveArgs, resolveTemplate } from './template';
import { NodeRegistry } from './node-registry.service';
import type { NodeResult } from './nodes/node-handler';

/** Prisma Json helper: map JS null → the DB JSON null sentinel. */
function toJson(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/** A WorkflowRun loaded with its parent Workflow (for the definition graph). */
type RunWithWorkflow = WorkflowRun & {
  workflow: Workflow;
  workflowVersion?: { definition: Prisma.JsonValue } | null;
};

/**
 * How a walk (or sub-walk) ended.
 *
 * A discriminated union rather than a boolean so a PAUSED lane and a TERMINATED
 * lane can propagate out of a nested sub-walk without the caller having to
 * re-read the run row to work out what happened.
 */
type WalkOutcome =
  | { kind: 'DONE' }
  /** Hit the caller's `stopAtNodeId` — a lane reaching its JOIN, or a loop body
   *  arriving back at its LOOP node. */
  | { kind: 'REACHED_STOP' }
  | { kind: 'PAUSED' }
  | {
      kind: 'TERMINATED';
      status: 'COMPLETED' | 'FAILED';
      reason?: string;
      nodeId: string;
    };

/** Where a walk starts and what context it seeds — used to resume a WAITING run. */
interface RunOptions {
  /** Node id to begin from. Omitted → start at the TRIGGER (a fresh run). */
  startNodeId?: string;
  /** Seed context (a resumed run's persisted context). Omitted → { trigger }. */
  context?: Record<string, unknown>;
}

/**
 * Walks a workflow graph for one WorkflowRun, threading a mutable `context`
 * object and writing a WorkflowStepRun per visited node. Starts at the TRIGGER
 * node and follows edges (for CONDITION, the edge whose `branch` matches the
 * boolean result; otherwise the first outgoing edge). Reuses the Knowledge
 * (RETRIEVE), LLM (AI_STEP) and Skills (TOOL_ACTION) modules. Bounded to
 * MAX_WORKFLOW_NODES visits so a malformed/cyclic graph can never loop forever.
 *
 * A node failure marks that step + the run FAILED and stops (no rethrow: a
 * failed run is a terminal domain outcome the poller reads, not a job crash).
 *
 * APPROVAL node: the walk PAUSES. The engine persists the current context, sets
 * the run WAITING with `resumeNodeId` = the node after the approval, writes a
 * (RUNNING) APPROVAL step marker, and creates a PENDING WORKFLOW-kind
 * ApprovalRequest directly via PrismaService (the engine never imports the
 * Approvals module — that keeps Approvals→Workflows one-directional/acyclic). A
 * manager's decision drives WorkflowsService.resumeRun (→ engine.resume →
 * COMPLETED) or cancelRun (→ FAILED). Workflows without an APPROVAL node behave
 * exactly as before (run → COMPLETED).
 *
 * EXCEPTION: an APPROVAL node configured `config.autoApprove: true` never
 * pauses — it resolves immediately (no ApprovalRequest) and the walk continues,
 * for companies that want criteria-matched runs to act with no human gate.
 */
@Injectable()
export class WorkflowEngine {
  private readonly logger = new Logger(WorkflowEngine.name);

  constructor(
    // Knowledge / Skills / Llm / Usage moved out with P1-03: those are node
    // concerns and now live in their handlers. The engine's job is the walk.
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly registry: NodeRegistry,
    // P3-05 §8.1.3 — resolves APPROVAL-node routing at pause time (acyclic module).
    private readonly approvalRouting: ApprovalRoutingService,
    // System email when a run pauses for approval (leaf module, no cycle).
    private readonly notifications: NotificationsService,
    // WAVE 1 — so a SCHEDULE fire honours the cutover flag too (leaf module).
    private readonly engineMode: EngineModeService,
    @InjectQueue(WF_RUN_ADVANCE_QUEUE)
    private readonly advanceQueue: Queue<AdvanceJobData>,
  ) {}

  /**
   * A cancelled/past-due company shouldn't keep consuming paid LLM/tool calls
   * just because a workflow is already ACTIVE (docs/specs/hiring-and-
   * subscription-linkage.md Part D #4 / test-cases WF-E4). Checked at every
   * fresh-execution and resume entry point so it's watertight regardless of
   * trigger type (MANUAL/EVENT/WEBHOOK/SCHEDULE) or approval timing.
   */
  private async blockedBySubscription(companyId: string): Promise<string | null> {
    const subscription = await this.billing.getSubscription(companyId);
    if (subscription.status === 'ACTIVE') {
      return null;
    }
    return `Subscription is ${subscription.status.toLowerCase().replace('_', ' ')} — workflow execution is paused until billing is resolved.`;
  }

  /** Fail `runId` immediately with `reason`, without running any node. */
  private async failBlockedRun(runId: string, reason: string): Promise<void> {
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'FAILED', finishedAt: new Date(), error: reason },
    });
    this.logger.warn(`Workflow run ${runId} blocked: ${reason}`);
  }

  /**
   * Scheduled/triggered entry: create a WorkflowRun for a workflow (with the
   * given source) then execute it. Used by the processor for `{workflowId,
   * source}` jobs (SCHEDULE repeatable). A missing/deleted workflow is a no-op.
   */
  async trigger(workflowId: string, source: string): Promise<void> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
    });
    if (!workflow) {
      this.logger.warn(`Triggered workflow ${workflowId} not found; skipping`);
      return;
    }
    const run = await this.prisma.workflowRun.create({
      data: {
        companyId: workflow.companyId,
        workflowId,
        status: 'PENDING',
        source,
        trigger: Prisma.JsonNull,
        // A generated correlationId keeps SCHEDULE-triggered runs traceable too.
        correlationId: randomUUID(),
      },
    });
    await this.execute(run.id);
  }

  /**
   * Fresh execution of a PENDING run: guard, flip to RUNNING, then walk from the
   * TRIGGER with a fresh context. Only a PENDING run is eligible (idempotent).
   */
  async execute(runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { workflow: true, workflowVersion: { select: { definition: true } } },
    });
    if (!run) {
      this.logger.warn(`Workflow run ${runId} not found`);
      return;
    }
    // Cheap early exit -- NOT the real idempotency guard (see the atomic
    // claim below). This just skips the billing lookup for the common case
    // of a run that plainly isn't eligible.
    if (run.status !== 'PENDING') {
      this.logger.warn(`Run ${runId} is ${run.status}, skipping`);
      return;
    }

    const blocked = await this.blockedBySubscription(run.companyId);
    if (blocked) {
      // Atomic: only fail it if it's STILL PENDING. A plain update() here
      // (the previous shape) could stomp a run a concurrent worker had
      // already legitimately claimed and moved past PENDING in the gap
      // since the read above.
      const failed = await this.prisma.workflowRun.updateMany({
        where: { id: runId, status: 'PENDING' },
        data: { status: 'FAILED', finishedAt: new Date(), error: blocked },
      });
      if (failed.count === 0) {
        this.logger.warn(`Run ${runId} no longer PENDING, skipping block`);
      } else {
        this.logger.warn(`Workflow run ${runId} blocked: ${blocked}`);
      }
      return;
    }

    // WAVE 1 — hand a state-machine company's run to the durable runtime.
    //
    // This check is here, not only in `WorkflowsService.dispatchRun`, because
    // `trigger()` (SCHEDULE fires) creates its run and calls `execute()`
    // DIRECTLY, never passing through dispatchRun. Without this, a tenant opted
    // in to the durable engine would still have every scheduled run walked by
    // the legacy engine — the cutover would silently cover manual runs only.
    //
    // Placed AFTER the subscription gate so a blocked company is still failed
    // fast and identically on both engines, and BEFORE the RUNNING claim so the
    // advance worker sees the PENDING run it expects.
    if (this.engineMode.usesStateMachine(run.companyId)) {
      await this.advanceQueue.add(
        WF_ADVANCE_JOB,
        { runId, companyId: run.companyId },
        { removeOnComplete: true, removeOnFail: 100 },
      );
      this.logger.log(
        `run=${runId} handed to the durable runtime (state_machine mode)`,
      );
      return;
    }

    // Atomic claim: the WHERE clause guarantees only ONE concurrent caller's
    // update can match+affect this row when two workers race the same
    // PENDING run (e.g. a duplicate-delivered queue job) -- the earlier
    // findUnique-then-update shape was a check-then-act with a real gap
    // between the read and the write, letting both callers pass the PENDING
    // check and both go on to run() the workflow (real side effects twice:
    // two emails, two calendar invites, etc). updateMany reports how many
    // rows it actually changed; 0 means we lost the race and must not run.
    const claimed = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date(), error: null },
    });
    if (claimed.count === 0) {
      this.logger.warn(`Run ${runId} already claimed by another worker, skipping`);
      return;
    }

    await this.run(run, {});
  }

  /**
   * Resume a WAITING run after its APPROVAL was approved (a `{runId, resume}`
   * job). WorkflowsService.resumeRun has already flipped the run to RUNNING; the
   * engine continues from `resumeNodeId` with the persisted context, closing out
   * the paused APPROVAL step first.
   */
  async resume(runId: string): Promise<void> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { workflow: true, workflowVersion: { select: { definition: true } } },
    });
    if (!run) {
      this.logger.warn(`Workflow run ${runId} not found (resume)`);
      return;
    }
    const blocked = await this.blockedBySubscription(run.companyId);
    if (blocked) {
      await this.failBlockedRun(runId, blocked);
      return;
    }
    // Pass a defined context so `run` knows this is a resume (not a fresh start)
    // even if resumeNodeId is null (the approval was the terminal node).
    await this.run(run, {
      startNodeId: run.resumeNodeId ?? undefined,
      context: (run.context as Record<string, unknown> | null) ?? {},
    });
  }

  /**
   * Watchdog sweep (fired by the repeatable `watchdog` job — see
   * WorkflowProcessor.onModuleInit): finds runs stuck in PENDING/RUNNING past
   * WORKFLOW_RUN_STUCK_TIMEOUT_MS and fails them. Exists because a BullMQ job
   * lock abandoned by a hard process kill is not always reliably requeued/
   * failed by BullMQ's own stalled-job detection (especially across rapid
   * repeated restarts) — without this, the DB row (and any WorkflowStepRun
   * left RUNNING) would stay stuck forever with no visible error. WAITING
   * runs (paused at an APPROVAL) are untouched — that's an intentional pause,
   * not a stall.
   */
  async sweepStuckRuns(): Promise<{ swept: number }> {
    const cutoff = new Date(Date.now() - WORKFLOW_RUN_STUCK_TIMEOUT_MS);
    const stuck = await this.prisma.workflowRun.findMany({
      where: {
        status: { in: ['PENDING', 'RUNNING'] },
        createdAt: { lt: cutoff },
        // WAVE 1: never touch a run owned by the durable runtime. The reaper is
        // authoritative for those (`ReaperService.sweepStuckRuns`, which
        // conversely requires `attempts: { some: {} }`), and it RECOVERS a run
        // where this watchdog KILLS it. With both live, a durable run that
        // legitimately took over ten minutes — a long WAIT, a slow provider, a
        // retry with backoff — would be failed here while the reaper was busy
        // re-enqueueing it. Neither would be authoritative and the run would end
        // up FAILED with work still in flight. A WorkflowStepAttempt row exists
        // only on the durable path, so it is the exact discriminator.
        attempts: { none: {} },
      },
      select: { id: true, companyId: true, workflowId: true, createdAt: true },
    });
    if (stuck.length === 0) {
      return { swept: 0 };
    }
    const error =
      'Orphaned: run exceeded the max expected execution time (likely a worker restart mid-execution) — swept by the workflow-run watchdog.';
    for (const run of stuck) {
      await this.prisma.workflowStepRun.updateMany({
        where: { runId: run.id, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'FAILED', error, finishedAt: new Date() },
      });
      await this.prisma.workflowRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', error, finishedAt: new Date() },
      });
      this.logger.warn(
        `workflow-run watchdog: swept orphaned run=${run.id} wf=${run.workflowId} company=${run.companyId} (created ${run.createdAt.toISOString()})`,
      );
    }
    return { swept: stuck.length };
  }

  /**
   * Core resumable walk. A resume passes a (defined) `context`; a fresh run omits
   * it. Fresh runs start at the TRIGGER with a fresh `{ trigger }`; resumes start
   * at `opts.startNodeId` (or nowhere, if the approval was terminal) with the
   * persisted context, after closing the paused APPROVAL step. Reaching an
   * APPROVAL node PAUSES the run (WAITING) and returns WITHOUT completing; every
   * other terminal path marks the run COMPLETED, and any node failure FAILED.
   */
  async run(run: RunWithWorkflow, opts: RunOptions = {}): Promise<void> {
    const { companyId } = run;
    // A defined context marks a resume; omitting it is a fresh start at TRIGGER.
    const isResume = opts.context !== undefined;
    const context: Record<string, unknown> =
      opts.context ?? {
        trigger: (run.trigger as Record<string, unknown> | null) ?? {},
      };

    // P2-01: seed persisted WORKFLOW/OUTPUT-scope variables so a value written
    // by a previous run is readable as `{{name}}` in this one. Without this,
    // SET_VARIABLE at WORKFLOW scope would be write-only — persisted, then never
    // seen again. RUNTIME scope is deliberately absent: it belongs to one run.
    //
    // Seeded UNDER the trigger/resume context so a fresh value set during this
    // run always wins over the stored one.
    const stored = await this.prisma.workflowVariable.findMany({
      where: {
        companyId: run.companyId,
        workflowId: run.workflowId,
        scope: { in: ['WORKFLOW', 'OUTPUT'] },
      },
      select: { key: true, value: true },
    });
    for (const variable of stored) {
      if (!(variable.key in context)) {
        context[variable.key] = variable.value;
      }
    }
    // Correlation id (docs §9): ties event→run→steps in the logs below. Falls back
    // to the run id for any legacy run created before the column existed.
    const correlationId = run.correlationId ?? run.id;

    try {
      this.logger.log(
        `workflow.run ${isResume ? 'resume' : 'start'} run=${run.id} corr=${correlationId} wf=${run.workflowId} company=${companyId} source=${run.source}`,
      );
      // Execute the PINNED version's immutable definition, never the live
      // (mutable) Workflow.definition. A run pins workflowVersionId at enqueue;
      // editing/publishing the workflow afterwards rewrites Workflow.definition
      // but must NOT change the graph an in-flight or WAITING→resumed run walks
      // (workflow-version.service.ts §immutability; doc 16 §25 E5). A null
      // version = a pre-versioning run; those fall back to the live column.
      const definition = this.parseDefinition(
        run.workflowVersion?.definition ?? run.workflow.definition,
      );
      const nodesById = new Map<string, WorkflowNode>(
        definition.nodes.map((n) => [n.id, n]),
      );

      // A resume closes the paused APPROVAL step (→ COMPLETED) before continuing.
      if (isResume) {
        await this.completePausedApproval(run.id, companyId);
      }

      let current: WorkflowNode | undefined;
      if (opts.startNodeId) {
        current = nodesById.get(opts.startNodeId);
      } else if (isResume) {
        // Resumed past a terminal approval (no outgoing edge): nothing remains,
        // so fall through to COMPLETED — never restart the walk from the TRIGGER.
        current = undefined;
      } else {
        current =
          definition.nodes.find((n) => n.type === 'TRIGGER') ??
          definition.nodes[0];
        if (!current) {
          throw new Error('Workflow definition has no nodes to run');
        }
      }

      const budget = { visited: 0 };
      const outcome = await this.walkFrom({
        run,
        companyId,
        definition,
        nodesById,
        context,
        correlationId,
        start: current,
        budget,
      });

      if (outcome.kind === 'PAUSED') {
        // The pausing step already persisted context + WAITING state.
        return;
      }
      if (outcome.kind === 'TERMINATED') {
        const { status, reason, nodeId } = outcome;
        await this.prisma.workflowRun.update({
          where: { id: run.id },
          data: {
            status,
            finishedAt: new Date(),
            context: context as Prisma.InputJsonObject,
            resumeNodeId: null,
            ...(status === 'FAILED'
              ? { error: reason ?? `Terminated at node "${nodeId}"` }
              : {}),
          },
        });
        this.logger.log(
          `workflow.run terminated run=${run.id} corr=${correlationId} node=${nodeId} status=${status}${reason ? ` reason="${reason}"` : ''}`,
        );
        return;
      }

      await this.prisma.workflowRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          context: context as Prisma.InputJsonObject,
          resumeNodeId: null,
        },
      });
      this.logger.log(
        `workflow.run completed run=${run.id} corr=${correlationId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `workflow.run failed run=${run.id} corr=${correlationId}: ${message}`,
      );
      await this.prisma.workflowRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          error: message,
          context: context as Prisma.InputJsonObject,
        },
      });
    }
  }

  /** APPROVAL nodes configured `autoApprove: true` skip the human gate (docs on ApprovalNodeConfig). */
  private isAutoApprove(node: WorkflowNode): boolean {
    return node.config?.autoApprove === true;
  }

  // --- APPROVAL pause / resume ---------------------------------------------

  /**
   * Pause a run at an APPROVAL node: write a (RUNNING) APPROVAL step marker,
   * persist the context + set WAITING with `resumeNodeId` (the approval node's
   * outgoing edge target, or null if it is terminal), and create a PENDING
   * WORKFLOW-kind ApprovalRequest DIRECTLY via Prisma (never importing the
   * Approvals module — the dependency stays one-directional Approvals→Workflows).
   */
  private async pauseForApproval(
    run: RunWithWorkflow,
    companyId: string,
    node: WorkflowNode,
    definition: WorkflowDefinition,
    context: Record<string, unknown>,
  ): Promise<void> {
    const outgoing = definition.edges.filter((e) => e.from === node.id);
    const resumeNodeId = outgoing.length > 0 ? outgoing[0].to : null;

    await this.prisma.workflowStepRun.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: node.id,
        type: node.type,
        // Left RUNNING as a paused marker; resume flips it COMPLETED.
        status: 'RUNNING',
        input: (node.config ?? {}) as Prisma.InputJsonObject,
        output: { awaitingApproval: true } as Prisma.InputJsonObject,
        startedAt: new Date(),
      },
    });

    await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status: 'WAITING',
        context: context as Prisma.InputJsonObject,
        resumeNodeId,
      },
    });

    const rawMessage = resolveTemplate(node.config?.message, context).trim();
    // P3-05 §8.1: resolve the APPROVAL node's routing (if any) against the run
    // context. No routing → unrouted row: canDecide falls back to OWNER/ADMIN.
    const routing = (node.config as ApprovalNodeConfig | undefined)?.routing;
    const initial = await this.approvalRouting.resolveInitial(
      companyId,
      routing,
      { runContext: context },
      new Date(),
    );
    // §8.1.10: a fresh chain's first row must have chainId === its own id.
    const approvalId = randomUUID();
    await this.prisma.approvalRequest.create({
      data: {
        id: approvalId,
        chainId: approvalId,
        companyId,
        kind: 'WORKFLOW',
        workflowRunId: run.id,
        description: rawMessage || 'Workflow approval required',
        status: 'PENDING',
        // Non-null Json column; a workflow approval gates no tool args.
        args: {} as Prisma.InputJsonObject,
        // skillKey / tool are null for WORKFLOW-kind requests.
        level: 1,
        escalationTier: 0,
        ...(initial
          ? {
              approverRuleType: initial.approverRuleType,
              approverRuleValue: initial.approverRuleValue,
              assigneeUserId: initial.assigneeUserId,
              slaMinutes: initial.slaMinutes,
              dueAt: initial.dueAt,
              timeoutPolicy: initial.timeoutPolicy,
              routingSnapshot: initial.snapshot as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    await this.notifications.approvalRequested(companyId, {
      assigneeUserId: initial?.assigneeUserId ?? null,
      summary: rawMessage || 'A workflow is waiting for your approval.',
    });
    this.logger.log(
      `workflow.run paused run=${run.id} corr=${run.correlationId ?? run.id} node=${node.id} (WAITING at APPROVAL)`,
    );
  }

  /**
   * G25 gate. Returns true when the run was PAUSED (caller must stop), false
   * when the step may execute.
   *
   * Uses the SHARED `toolRequiresApproval` policy (`modules/skills/
   * tool-approval-policy.ts`) — the identical rule the chat path applies — so
   * the two execution paths can never diverge again. The policy is a pure
   * function, so this does NOT import the Approvals module and the
   * Approvals→Workflows dependency stays one-directional.
   *
   * On approval the run resumes at THIS SAME node (`resumeNodeId = node.id`),
   * not the next one — the tool has not run yet. Re-entry finds the APPROVED
   * request below and falls through to execute exactly once.
   */
  private async pauseIfToolNeedsApproval(
    run: RunWithWorkflow,
    companyId: string,
    node: WorkflowNode,
    context: Record<string, unknown>,
  ): Promise<boolean> {
    const cfg = node.config ?? {};
    const skillKey = typeof cfg.skillKey === 'string' ? cfg.skillKey : '';
    const tool = typeof cfg.tool === 'string' ? cfg.tool : '';
    // Malformed step: let execToolAction raise its own "Unknown skill/tool".
    if (!skillKey || !tool) {
      return false;
    }

    const employeeId =
      typeof cfg.employeeId === 'string' && cfg.employeeId.trim()
        ? cfg.employeeId.trim()
        : undefined;
    // Only a step scoped to a specific AI Employee carries per-employee rules;
    // an unscoped step is judged by the catalog's `highRisk` flag alone.
    const employee = employeeId
      ? await this.prisma.aiEmployee.findFirst({
          where: { id: employeeId, companyId },
          select: { approvalRules: true },
        })
      : null;

    if (!toolRequiresApproval(employee, skillKey, tool)) {
      return false;
    }

    // Already approved for this run + node? Then this is the post-approval
    // re-entry — execute. Scoped by nodeId so two gated steps in one workflow
    // cannot unlock each other.
    const decided = await this.prisma.approvalRequest.findFirst({
      where: {
        companyId,
        workflowRunId: run.id,
        skillKey,
        tool,
        status: 'APPROVED',
        description: { contains: `[node:${node.id}]` },
      },
    });
    if (decided) {
      return false;
    }

    const argsRaw =
      cfg.args && typeof cfg.args === 'object' && !Array.isArray(cfg.args)
        ? (cfg.args as Record<string, unknown>)
        : undefined;
    const args = resolveArgs(argsRaw, context);

    await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status: 'WAITING',
        context: context as Prisma.InputJsonObject,
        resumeNodeId: node.id,
      },
    });

    // kind WORKFLOW (not TOOL): approving must RESUME the run and let the
    // engine execute the tool with its own context, not execute it standalone
    // inside ApprovalService — which would run it outside the run's context
    // and leave the run stuck WAITING forever.
    await this.prisma.approvalRequest.create({
      data: {
        companyId,
        kind: 'WORKFLOW',
        workflowRunId: run.id,
        skillKey,
        tool,
        args: args as Prisma.InputJsonObject,
        status: 'PENDING',
        description: `Workflow step "${node.id}" wants to run ${skillKey}.${tool} [node:${node.id}]`,
      },
    });

    // Unrouted → NotificationsService falls back to the company's owners/admins.
    await this.notifications.approvalRequested(companyId, {
      summary: `A workflow step wants to run ${skillKey}.${tool} and needs your approval.`,
    });
    this.logger.log(
      `workflow.run paused run=${run.id} corr=${run.correlationId ?? run.id} node=${node.id} (WAITING — TOOL_ACTION ${skillKey}.${tool} needs approval)`,
    );
    return true;
  }

  /**
   * On resume, mark the paused (RUNNING) APPROVAL step COMPLETED. Returns true
   * when such a step existed (i.e. this was a resume), false on a fresh run.
   */
  private async completePausedApproval(
    runId: string,
    companyId: string,
  ): Promise<boolean> {
    const step = await this.prisma.workflowStepRun.findFirst({
      where: { runId, companyId, type: 'APPROVAL', status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!step) {
      return false;
    }
    await this.prisma.workflowStepRun.update({
      where: { id: step.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        output: { approved: true } as Prisma.InputJsonObject,
      },
    });
    return true;
  }

  // --- Graph walking -------------------------------------------------------

  /** Persist a WorkflowStepRun around one node's execution. */
  private async runNode(
    runId: string,
    companyId: string,
    workflowId: string,
    node: WorkflowNode,
    context: Record<string, unknown>,
    correlationId: string,
    dryRun: boolean,
  ): Promise<NodeResult> {
    const step = await this.prisma.workflowStepRun.create({
      data: {
        companyId,
        runId,
        nodeId: node.id,
        type: node.type,
        status: 'RUNNING',
        input: (node.config ?? {}) as Prisma.InputJsonObject,
        startedAt: new Date(),
      },
    });
    // Structured step line sharing the run's correlationId (docs §9).
    this.logger.log(
      `workflow.step run=${runId} corr=${correlationId} node=${node.id} type=${node.type}`,
    );

    try {
      const result = await this.executeNode(
        companyId,
        workflowId,
        runId,
        node,
        context,
        dryRun,
      );

      // A handler-declared key wins over the author's `outputKey`: SET_VARIABLE
      // binds under the variable's own name by contract, and without this it
      // bound nowhere at all unless the author happened to set outputKey too.
      const outputKey =
        result.contextKey?.trim() ||
        (typeof node.config?.outputKey === 'string'
          ? node.config.outputKey.trim()
          : '');
      if (outputKey && result.contextValue !== undefined) {
        context[outputKey] = result.contextValue;
      }

      await this.prisma.workflowStepRun.update({
        where: { id: step.id },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          output: toJson(result.output),
        },
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.workflowStepRun.update({
        where: { id: step.id },
        data: { status: 'FAILED', finishedAt: new Date(), error: message },
      });
      throw err;
    }
  }

  /**
   * Pick the next node: CONDITION follows its branch edge, else the first edge.
   *
   * A CONDITION with NO branch-tagged outgoing edges at all is a deliberate,
   * simple "pass-through" design (the condition result is just logged, not
   * used to route) — that keeps working as before. But if the node has SOME
   * branch-tagged edges and the current result doesn't match any of them
   * (e.g. only a `[true]` edge exists and the result is `false`), silently
   * falling back to an arbitrary edge would run the WRONG downstream steps
   * with no error anywhere. Fail loudly instead.
   */
  private nextNode(
    node: WorkflowNode,
    edges: WorkflowEdge[],
    nodesById: Map<string, WorkflowNode>,
    result: NodeResult,
  ): WorkflowNode | undefined {
    const outgoing = edges.filter((e) => e.from === node.id);
    if (outgoing.length === 0) {
      return undefined;
    }
    let edge: WorkflowEdge;
    // Keyed on the RESULT, not the node type: any handler that returns a
    // branch selector gets branch routing for free. The old
    // `node.type === 'CONDITION'` check was redundant (only CONDITION sets
    // conditionResult) and would have needed editing for every future
    // branching node — exactly what the registry exists to avoid.
    // A named branch (SWITCH, P2-02) or a boolean one (CONDITION). Both resolve
    // to an edge label; `branch` is simply the general form.
    const selector =
      result.branch !== undefined
        ? result.branch
        : result.conditionResult !== undefined
          ? result.conditionResult
            ? 'true'
            : 'false'
          : undefined;

    if (selector !== undefined) {
      const matched = outgoing.find((e) => e.branch === selector);
      const anyBranchTagged = outgoing.some((e) => e.branch);
      if (matched) {
        edge = matched;
      } else if (!anyBranchTagged) {
        edge = outgoing[0];
      } else {
        throw new Error(
          `Node "${node.id}" selected branch "${selector}", but no outgoing edge has branch="${selector}" (misconfigured workflow)`,
        );
      }
    } else {
      edge = outgoing[0];
    }
    const target = nodesById.get(edge.to);
    if (!target) {
      // A dangling edge target must FAIL the run, not silently end it. Returning
      // undefined here would exit the walk and mark the run COMPLETED, skipping
      // every intended downstream step (contradicts the UNKNOWN_EDGE_TARGET
      // publish rule at runtime; matches how PARALLEL/LOOP directive targets
      // already throw on a missing node).
      throw new Error(
        `Edge from node "${node.id}" points to unknown node "${edge.to}" (invalid workflow graph)`,
      );
    }
    return target;
  }

  // --- Node executors (one single-purpose method each) ---------------------

  /**
   * Walk the graph from `start`, following edges, until it runs out of nodes or
   * hits `stopAtNodeId`.
   *
   * Re-entrant: a PARALLEL lane and a LOOP body are walked by recursive calls
   * with a *shared* budget, so the run-wide `MAX_WORKFLOW_NODES` cap bounds the
   * total work regardless of nesting. Without a shared budget a loop containing
   * a loop could multiply past the cap.
   */
  private async walkFrom(args: {
    run: RunWithWorkflow;
    companyId: string;
    definition: WorkflowDefinition;
    nodesById: Map<string, WorkflowNode>;
    context: Record<string, unknown>;
    correlationId: string;
    start: WorkflowNode | undefined;
    budget: { visited: number };
    stopAtNodeId?: string;
  }): Promise<WalkOutcome> {
    const {
      run,
      companyId,
      definition,
      nodesById,
      context,
      correlationId,
      budget,
      stopAtNodeId,
    } = args;
    let current = args.start;

    while (current) {
      if (stopAtNodeId && current.id === stopAtNodeId) {
        return { kind: 'REACHED_STOP' };
      }
      if (budget.visited >= MAX_WORKFLOW_NODES) {
        throw new Error(
          `Exceeded max node count (${MAX_WORKFLOW_NODES}); aborting to avoid a loop`,
        );
      }
      budget.visited += 1;

      // ── Author-disabled step: skip it, don't execute it ───────────────────
      // Recorded as a real SKIPPED step row so the run timeline shows WHY a step
      // produced nothing, rather than the node silently vanishing from the log.
      // Routing is deliberately the FIRST outgoing edge: a disabled node
      // produces no branch selector, so there is nothing to route on. (A
      // disabled TRIGGER is rejected at validation — the graph needs a root.)
      if (current.disabled) {
        await this.prisma.workflowStepRun.create({
          data: {
            companyId,
            runId: run.id,
            nodeId: current.id,
            type: current.type,
            status: 'SKIPPED',
            input: (current.config ?? {}) as Prisma.InputJsonObject,
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        });
        this.logger.log(
          `workflow.step.skipped run=${run.id} corr=${correlationId} node=${current.id} reason=disabled`,
        );
        current = this.nextNode(current, definition.edges, nodesById, {
          output: null,
        });
        continue;
      }

      // APPROVAL pauses the run: persist state, open an approval, and STOP —
      // UNLESS this node is configured autoApprove:true, in which case it falls
      // through to runNode() below like any other step.
      if (current.type === 'APPROVAL' && !this.isAutoApprove(current)) {
        await this.pauseForApproval(run, companyId, current, definition, context);
        return { kind: 'PAUSED' };
      }

      // G25 (SAFETY): a TOOL_ACTION calling a gated tool must pause for the same
      // human approval the chat path enforces.
      if (current.type === 'TOOL_ACTION' && !run.dryRun) {
        const gated = await this.pauseIfToolNeedsApproval(
          run,
          companyId,
          current,
          context,
        );
        if (gated) {
          return { kind: 'PAUSED' };
        }
      }

      const result = await this.runNode(
        run.id,
        companyId,
        run.workflowId,
        current,
        context,
        correlationId,
        run.dryRun,
      );

      // ── Directive: a handler asked to pause and be re-entered ─────────────
      if (result.pause) {
        await this.pauseAtNode(run, companyId, current, context, result.pause);
        return { kind: 'PAUSED' };
      }

      // ── Directive: end the run here ──────────────────────────────────────
      if (result.terminate) {
        return {
          kind: 'TERMINATED',
          status: result.terminate.status,
          reason: result.terminate.reason,
          nodeId: current.id,
        };
      }

      // ── Directive: fan out into lanes, converge at the join ──────────────
      if (result.fanOut) {
        const { lanes, joinNodeId, mode } = result.fanOut;
        const selected = mode === 'ANY' ? lanes.slice(0, 1) : lanes;

        for (const laneStartId of selected) {
          if (!nodesById.has(laneStartId)) {
            throw new Error(
              `PARALLEL node "${current.id}" references unknown lane start "${laneStartId}"`,
            );
          }
        }

        // CONCURRENT lanes. Each gets its OWN shallow context copy: they run at
        // the same time, and letting them mutate one shared object would be a
        // genuine write race (two lanes setting the same key, or one reading a
        // half-written value from the other).
        //
        // The step rows they write go to Postgres independently, so the database
        // side is already safe — it is only the in-memory bag that needs
        // isolating.
        const laneContexts = new Map<string, Record<string, unknown>>(
          selected.map((laneId) => [laneId, { ...context }]),
        );

        const laneResults = await Promise.all(
          selected.map(async (laneStartId) => {
            const outcome = await this.walkFrom({
              ...args,
              context: laneContexts.get(laneStartId) as Record<string, unknown>,
              start: nodesById.get(laneStartId),
              stopAtNodeId: joinNodeId,
            });
            return { laneStartId, outcome };
          }),
        );

        // A pause or terminate in ANY lane wins. Sibling lanes have already run
        // to completion (Promise.all settles all of them), so this is reported
        // rather than prevented — that is the honest trade for concurrency, and
        // it is why doc 26 §8 forbids an APPROVAL inside a lane.
        const halted = laneResults.find(
          (r) => r.outcome.kind === 'PAUSED' || r.outcome.kind === 'TERMINATED',
        );
        if (halted) {
          return halted.outcome;
        }

        // Merge each lane's new keys back into the parent context. Two lanes
        // writing the same key is last-merge-wins and non-deterministic under
        // concurrency, which is exactly why publish-time validation warns about
        // cross-lane writes.
        const laneOutputs: Record<string, unknown> = {};
        for (const laneStartId of selected) {
          const laneContext = laneContexts.get(laneStartId) as Record<
            string,
            unknown
          >;
          const produced: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(laneContext)) {
            if (context[key] !== value) {
              context[key] = value;
              produced[key] = value;
            }
          }
          laneOutputs[laneStartId] = { completed: true, produced };
        }

        context.__lanes = laneOutputs;
        current = nodesById.get(joinNodeId);
        if (!current) {
          throw new Error(
            `PARALLEL join target "${joinNodeId}" does not exist`,
          );
        }
        continue;
      }

      // ── Directive: iterate a body once per item ──────────────────────────
      if (result.iterate) {
        const { items, itemVar, bodyNodeId, doneNodeId } = result.iterate;
        const body = nodesById.get(bodyNodeId);
        if (!body) {
          throw new Error(
            `LOOP node "${current.id}" references unknown body node "${bodyNodeId}"`,
          );
        }

        const loopNodeId = current.id;
        for (let index = 0; index < items.length; index += 1) {
          context[itemVar] = items[index];
          context[`${itemVar}Index`] = index;
          const bodyOutcome = await this.walkFrom({
            ...args,
            start: body,
            // The body stops when it loops back to the LOOP node, so an author
            // can wire `body → … → loop` without the walk re-entering LOOP.
            stopAtNodeId: loopNodeId,
          });
          if (bodyOutcome.kind === 'PAUSED' || bodyOutcome.kind === 'TERMINATED') {
            return bodyOutcome;
          }
        }

        current = doneNodeId
          ? nodesById.get(doneNodeId)
          : this.nextNode(current, definition.edges, nodesById, {
              output: null,
              branch: 'done',
            });
        continue;
      }

      current = this.nextNode(current, definition.edges, nodesById, result);
    }

    return { kind: 'DONE' };
  }

  /**
   * Pause the run at THIS node so it re-executes on resume (P2 risk fix).
   *
   * Used when a handler discovers mid-execution that it needs a human — an
   * AI_EMPLOYEE_STEP whose tool call hit the G25 gate. `resumeNodeId` is the node
   * itself, not the next one, because its work has not happened yet.
   */
  private async pauseAtNode(
    run: RunWithWorkflow,
    companyId: string,
    node: WorkflowNode,
    context: Record<string, unknown>,
    pause: { reason: string; approvalId?: string },
  ): Promise<void> {
    await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status: 'WAITING',
        context: context as Prisma.InputJsonObject,
        resumeNodeId: node.id,
      },
    });
    this.logger.log(
      `workflow.run paused run=${run.id} corr=${run.correlationId ?? run.id} node=${node.id} ` +
        `(WAITING — ${pause.reason}${pause.approvalId ? ` approval=${pause.approvalId}` : ''})`,
    );
  }

  /**
   * P1-03: resolve a handler from the NodeRegistry and call it.
   *
   * This replaced a `switch (node.type)` over eight cases. Doc 26 §9 forbids
   * the engine branching on node type at all — adding a node must be one new
   * file plus one providers entry, with nothing in here changing. Keep it that
   * way: any `if (node.type === …)` reintroduced below is a review rejection.
   */
  private executeNode(
    companyId: string,
    workflowId: string,
    runId: string,
    node: WorkflowNode,
    context: Record<string, unknown>,
    dryRun: boolean,
  ): Promise<NodeResult> | NodeResult {
    return this.registry
      .get(node.type)
      .execute({ companyId, workflowId, runId, node, context, dryRun });
  }

  /** Coerce the persisted Json definition into a safe {nodes, edges} shape. */
  private parseDefinition(raw: Prisma.JsonValue): WorkflowDefinition {
    const def = (raw ?? {}) as Partial<WorkflowDefinition>;
    const nodes = Array.isArray(def.nodes) ? def.nodes : [];
    const edges = Array.isArray(def.edges) ? def.edges : [];
    return { nodes, edges };
  }
}
