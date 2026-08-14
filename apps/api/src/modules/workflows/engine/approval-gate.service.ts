import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ApprovalNodeConfig, WorkflowNode } from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ApprovalRoutingService } from '../../approval-routing/approval-routing.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { toolRequiresApproval } from '../../skills/tool-approval-policy';
import { resolveArgs, resolveTemplate } from './template';

export type ApprovalGateDecision =
  /** No gate, or the gate is satisfied — run the node. */
  | { kind: 'PROCEED'; approvedAt?: Date | null }
  /** A human still has to decide. The run must become WAITING. */
  | { kind: 'PAUSE'; approvalId: string; reason: string }
  /** A human said no. The run must fail safely. */
  | { kind: 'REJECTED'; reason: string };

/**
 * WAVE 1 §1.10 — APPROVAL as a DURABLE workflow state.
 *
 * In the legacy walk the approval gate lives inside `WorkflowEngine.run`: the
 * loop notices an APPROVAL node, writes the request and stops. That works only
 * because one process owns the whole run from start to finish.
 *
 * The durable runtime has no such process. A node attempt is a job that may run
 * on any worker, minutes or days apart, so the gate has to be *re-entrant*:
 * every attempt at the node asks the same question — "may I proceed?" — and the
 * answer is derived entirely from rows in Postgres. That is what makes approval
 * survive a restart: there is no in-memory state to lose.
 *
 * Deliberately NOT a second approval system (plan §19). It writes the same
 * `ApprovalRequest` rows, with the same `ApprovalRoutingService` routing, that
 * `ApprovalsService` already decides on — so approve/reject/SLA-escalate all
 * work unchanged against a durable run.
 *
 * The one addition is `args.nodeId`. The legacy path can identify its pending
 * approval by run alone because a run pauses at exactly one node at a time;
 * with genuinely concurrent lanes that stops being true, so the request records
 * which node it gates.
 */
@Injectable()
export class ApprovalGateService {
  private readonly logger = new Logger(ApprovalGateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly notifications: NotificationsService,
  ) {}

  /** APPROVAL nodes configured `autoApprove: true` skip the human gate. */
  private isAutoApprove(node: WorkflowNode): boolean {
    return node.config?.autoApprove === true;
  }

  async evaluate(input: {
    companyId: string;
    runId: string;
    node: WorkflowNode;
    context: Record<string, unknown>;
  }): Promise<ApprovalGateDecision> {
    const { companyId, runId, node, context } = input;

    // G25 — a high-risk TOOL_ACTION is gated too, not just an explicit APPROVAL
    // node. The legacy walk does this in its run loop
    // (`pauseIfToolNeedsApproval`); the durable runtime has no run loop, so the
    // check belongs HERE, in the one re-entrant question every attempt asks.
    //
    // It was missing, and the consequence was not subtle: with the durable
    // engine active, `stripe.create_payment_link` and `postiz.publish_now`
    // executed with no human gate at all — the exact bypass G25 was opened to
    // close, reintroduced by the second engine rather than by a code change to
    // the first.
    if (node.type === 'TOOL_ACTION') {
      return this.evaluateToolAction(companyId, runId, node, context);
    }

    if (node.type !== 'APPROVAL' || this.isAutoApprove(node)) {
      return { kind: 'PROCEED' };
    }

    const existing = await this.prisma.approvalRequest.findMany({
      where: {
        companyId,
        kind: 'WORKFLOW',
        workflowRunId: runId,
        args: { path: ['nodeId'], equals: node.id },
      },
      select: { id: true, status: true, note: true, decidedAt: true },
      orderBy: { createdAt: 'asc' },
    });

    if (existing.length > 0) {
      // Order matters. A rejection anywhere in a multi-level chain is final, so
      // it is checked before "still pending" — otherwise a later escalation row
      // sitting PENDING would keep a rejected run waiting for ever.
      const rejected = existing.find((r) => r.status === 'REJECTED');
      if (rejected) {
        return {
          kind: 'REJECTED',
          reason: rejected.note?.trim()
            ? `Approval rejected: ${rejected.note.trim()}`
            : 'Approval rejected',
        };
      }
      const pending = existing.find((r) => r.status === 'PENDING');
      if (pending) {
        return {
          kind: 'PAUSE',
          approvalId: pending.id,
          reason: 'Waiting for approval',
        };
      }
      // Every row APPROVED and nothing outstanding: the chain is satisfied.
      return {
        kind: 'PROCEED',
        approvedAt: existing[existing.length - 1]?.decidedAt ?? null,
      };
    }

    const approvalId = await this.createRequest(companyId, runId, node, context);
    return { kind: 'PAUSE', approvalId, reason: 'Waiting for approval' };
  }

  /**
   * G25 for the durable runtime: does THIS TOOL_ACTION need a human first?
   *
   * Uses the SHARED `toolRequiresApproval` policy — the same pure function the
   * chat path and the legacy walk apply — so three execution paths cannot
   * drift apart again. It is a pure function, so this does not import
   * ApprovalsModule and the Approvals → Workflows edge stays one-directional.
   *
   * The rows it reads and writes are byte-compatible with the legacy walk's:
   * same `kind: 'WORKFLOW'`, same `skillKey`/`tool`, same `[node:<id>]` marker
   * in the description. That matters during a staged rollout — a run paused by
   * one engine and approved while the flag flips must still resume under the
   * other, and an approval is exactly the kind of long-lived state that will
   * straddle a switch.
   */
  private async evaluateToolAction(
    companyId: string,
    runId: string,
    node: WorkflowNode,
    context: Record<string, unknown>,
  ): Promise<ApprovalGateDecision> {
    const cfg = node.config ?? {};
    const skillKey = typeof cfg.skillKey === 'string' ? cfg.skillKey : '';
    const tool = typeof cfg.tool === 'string' ? cfg.tool : '';
    // Malformed step: proceed and let the handler raise its own
    // "Unknown skill/tool", which is a clearer error than a gate refusing to
    // judge something it cannot identify.
    if (!skillKey || !tool) return { kind: 'PROCEED' };

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
      return { kind: 'PROCEED' };
    }

    const marker = `[node:${node.id}]`;
    const existing = await this.prisma.approvalRequest.findMany({
      where: {
        companyId,
        kind: 'WORKFLOW',
        workflowRunId: runId,
        skillKey,
        tool,
        // Scoped by node so two gated steps in one workflow cannot unlock each
        // other — approving the Slack post must not also approve the refund.
        description: { contains: marker },
      },
      select: { id: true, status: true, note: true },
      orderBy: { createdAt: 'asc' },
    });

    // Rejection first, for the same reason as the APPROVAL branch: it is final,
    // and a later escalation row still PENDING must not outrank it.
    const rejected = existing.find((r) => r.status === 'REJECTED');
    if (rejected) {
      return {
        kind: 'REJECTED',
        reason: rejected.note?.trim()
          ? `Approval rejected: ${rejected.note.trim()}`
          : `Approval rejected for ${skillKey}.${tool}`,
      };
    }
    const pending = existing.find((r) => r.status === 'PENDING');
    if (pending) {
      return {
        kind: 'PAUSE',
        approvalId: pending.id,
        reason: `Waiting for approval to run ${skillKey}.${tool}`,
      };
    }
    // An APPROVED row means this is the post-approval re-entry: the tool has
    // NOT run yet (the gate paused before the handler), so proceed exactly once.
    if (existing.length > 0) return { kind: 'PROCEED' };

    const args = resolveArgs(
      cfg.args && typeof cfg.args === 'object' && !Array.isArray(cfg.args)
        ? (cfg.args as Record<string, unknown>)
        : undefined,
      context,
    );

    const approvalId = randomUUID();
    await this.prisma.approvalRequest.create({
      data: {
        id: approvalId,
        chainId: approvalId,
        companyId,
        // kind WORKFLOW, never TOOL: approving must RESUME the run so the tool
        // executes with the run's own context. A TOOL-kind request would run it
        // standalone inside ApprovalService and leave the run WAITING for ever.
        kind: 'WORKFLOW',
        workflowRunId: runId,
        skillKey,
        tool,
        args: args as Prisma.InputJsonObject,
        status: 'PENDING',
        description: `Workflow step "${node.id}" wants to run ${skillKey}.${tool} ${marker}`,
        level: 1,
        escalationTier: 0,
      },
    });

    await this.notifications.approvalRequested(companyId, {
      summary: `A workflow step wants to run ${skillKey}.${tool} and needs your approval.`,
    });
    this.logger.log(
      `G25 gate opened run=${runId} node=${node.id} ${skillKey}.${tool} approval=${approvalId}`,
    );

    return {
      kind: 'PAUSE',
      approvalId,
      reason: `Waiting for approval to run ${skillKey}.${tool}`,
    };
  }

  /**
   * Create the PENDING request, routed per the node's config.
   *
   * Written via Prisma rather than by importing ApprovalsModule: the dependency
   * stays one-directional (Approvals → Workflows), which is what keeps
   * ApprovalsService able to call back into WorkflowsService on a decision.
   */
  private async createRequest(
    companyId: string,
    runId: string,
    node: WorkflowNode,
    context: Record<string, unknown>,
  ): Promise<string> {
    const rawMessage = resolveTemplate(node.config?.message, context).trim();
    const routingConfig = (node.config as ApprovalNodeConfig | undefined)?.routing;
    const initial = await this.routing.resolveInitial(
      companyId,
      routingConfig,
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
        workflowRunId: runId,
        description: rawMessage || 'Workflow approval required',
        status: 'PENDING',
        // Non-null Json column. `nodeId` is what lets a re-entrant attempt find
        // ITS approval when several lanes are gated at once.
        args: { nodeId: node.id } as Prisma.InputJsonObject,
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
      `approval gate opened run=${runId} node=${node.id} approval=${approvalId}`,
    );
    return approvalId;
  }
}
