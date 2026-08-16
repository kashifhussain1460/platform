import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type ApprovalRequest } from '@prisma/client';
import type { RoutingSnapshot } from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditLogService } from '../../audit/audit-log.service';
import {
  ApprovalRoutingService,
  DEFAULT_MAX_ESCALATIONS,
} from '../../approval-routing/approval-routing.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SkillsService } from '../../skills/skills.service';
import { WorkflowsService } from '../../workflows/workflows.service';
import { APPROVAL_SLA_SWEEP_BATCH } from './approval-sla.constants';

/**
 * Approval SLA sweep (P3-05 §8.2). Guarantees a routed approval doesn't wait
 * forever: a breached `dueAt` escalates through the level's `escalationChain`, and
 * once that's exhausted a configured policy (ESCALATE-with-nothing-left / NONE →
 * EXPIRED, AUTO_APPROVE, AUTO_REJECT) resolves it. Auto-decisions go through the
 * EXACT same effect paths a human decision uses (resumeRun / cancelRun / runTool)
 * — there is no separate, less-audited timeout execution path (§8.2.11). Every
 * transition is a race-safe guarded `updateMany WHERE status='PENDING'`, so a
 * human deciding in the same instant the sweep fires cannot double-resolve.
 */
@Injectable()
export class ApprovalSlaService {
  private readonly logger = new Logger(ApprovalSlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly workflows: WorkflowsService,
    private readonly skills: SkillsService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Cross-tenant sweep (no companyId filter — mirrors WorkflowEngine.sweepStuckRuns,
   * served by the `[status, dueAt]` index): every PENDING row whose deadline passed.
   */
  async sweep(asOf: Date = new Date()): Promise<{ processed: number }> {
    const breached = await this.prisma.approvalRequest.findMany({
      where: { status: 'PENDING', dueAt: { lte: asOf } },
      orderBy: { dueAt: 'asc' },
      take: APPROVAL_SLA_SWEEP_BATCH,
    });
    let processed = 0;
    for (const req of breached) {
      try {
        await this.applyBreach(req, asOf);
        processed += 1;
      } catch (err) {
        // One bad row must not stall the sweep loop (§8.2.10).
        this.logger.error(
          `approval-sla breach handling failed for ${req.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { processed };
  }

  private async applyBreach(req: ApprovalRequest, asOf: Date): Promise<void> {
    const snap = req.routingSnapshot as RoutingSnapshot | null;
    const level = snap?.levels?.[req.level - 1];
    const nextTier = req.escalationTier + 1;
    const nextStep = level?.escalationChain?.[nextTier - 1];
    const maxEscalations = snap?.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;

    // 1) Escalate to the next fallback tier if one exists and we're under the cap.
    if (nextStep && nextTier <= maxEscalations) {
      const resolved = await this.routing.resolveStep(req.companyId, nextStep, {
        employeeId: req.employeeId,
      });
      const newId = randomUUID();
      const sla = nextStep.slaMinutes ?? null;
      const escalated = await this.prisma.$transaction(async (tx) => {
        // Race-safe: lose harmlessly if a human just decided this row.
        const claimed = await tx.approvalRequest.updateMany({
          where: { id: req.id, status: 'PENDING' },
          data: { status: 'ESCALATED', escalatedToId: newId },
        });
        if (claimed.count === 0) return false;
        await tx.approvalRequest.create({
          data: {
            id: newId,
            chainId: req.chainId,
            companyId: req.companyId,
            kind: req.kind,
            employeeId: req.employeeId,
            conversationId: req.conversationId,
            workflowRunId: req.workflowRunId,
            skillKey: req.skillKey,
            tool: req.tool,
            args: (req.args ?? {}) as Prisma.InputJsonObject,
            description: req.description,
            status: 'PENDING',
            level: req.level,
            escalationTier: nextTier,
            approverRuleType: resolved.approverRuleType,
            approverRuleValue: resolved.approverRuleValue ?? null,
            assigneeUserId: resolved.assigneeUserId ?? null,
            slaMinutes: sla,
            dueAt: sla ? new Date(asOf.getTime() + sla * 60_000) : null,
            timeoutPolicy: level?.onTimeout ?? null,
            routingSnapshot: req.routingSnapshot as Prisma.InputJsonValue,
          },
        });
        return true;
      });
      if (escalated) {
        await this.notifications.approvalEscalated(req.companyId, {
          assigneeUserId: resolved.assigneeUserId ?? null,
          summary:
            req.description?.trim() ||
            (req.skillKey && req.tool
              ? `A request to run ${req.skillKey}.${req.tool} is overdue.`
              : 'An approval is overdue.'),
        });
      }
      this.logger.log(
        `approval-sla escalated chain=${req.chainId} level=${req.level} → tier ${nextTier}`,
      );
      await this.auditLog.record({
        companyId: req.companyId,
        actorUserId: null,
        action: 'approval.escalated',
        entityType: 'ApprovalRequest',
        entityId: req.id,
        metadata: { chainId: req.chainId, level: req.level, tier: nextTier },
      });
      return;
    }

    // 2) Chain exhausted → apply the timeout policy.
    const policy = level?.onTimeout ?? snap?.defaultOnTimeout ?? 'NONE';
    if (policy === 'AUTO_APPROVE') {
      await this.resolveAsSystem(req, 'APPROVED');
      return;
    }
    if (policy === 'AUTO_REJECT') {
      await this.resolveAsSystem(req, 'REJECTED');
      return;
    }

    // ESCALATE-with-nothing-left or NONE → EXPIRED (terminal, never silently stuck).
    const claimed = await this.prisma.approvalRequest.updateMany({
      where: { id: req.id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    if (claimed.count === 0) return;
    if (req.kind === 'WORKFLOW' && req.workflowRunId) {
      await this.workflows.cancelRun(
        req.workflowRunId,
        'Approval EXPIRED — SLA breached, no further escalation configured',
        req.companyId,
        // An expiry is a TIMEOUT, not a rejection: nobody decided anything.
        'TIMEOUT',
      );
    }
    this.logger.warn(`approval-sla expired chain=${req.chainId} level=${req.level}`);
    await this.auditLog.record({
      companyId: req.companyId,
      actorUserId: null,
      action: 'approval.expired',
      entityType: 'ApprovalRequest',
      entityId: req.id,
      metadata: { chainId: req.chainId, level: req.level },
    });
  }

  /**
   * Resolve a breached request as the system, through the EXACT effect paths
   * approve()/reject() use. AUTO_APPROVE on a TOOL-kind row runs a real tool call
   * with no human in the loop — the sharpest edge in the phase (§8.2.11), which is
   * why `onTimeout` defaults to NONE and this must be an explicit opt-in.
   */
  private async resolveAsSystem(
    req: ApprovalRequest,
    status: 'APPROVED' | 'REJECTED',
  ): Promise<void> {
    const claimed = await this.prisma.approvalRequest.updateMany({
      where: { id: req.id, status: 'PENDING' },
      data: {
        status,
        autoDecided: true,
        decidedById: null,
        decidedAt: new Date(),
        note: `Auto-${status.toLowerCase()} on SLA timeout`,
      },
    });
    if (claimed.count === 0) return;
    await this.auditLog.record({
      companyId: req.companyId,
      actorUserId: null,
      action:
        status === 'APPROVED'
          ? 'approval.auto_approved'
          : 'approval.auto_rejected',
      entityType: 'ApprovalRequest',
      entityId: req.id,
      metadata: { chainId: req.chainId, level: req.level, kind: req.kind },
    });

    if (req.kind === 'WORKFLOW' && req.workflowRunId) {
      if (status === 'APPROVED') {
        await this.workflows.resumeRun(req.workflowRunId, req.companyId);
      } else {
        await this.workflows.cancelRun(
          req.workflowRunId,
          'Auto-rejected on SLA timeout',
          req.companyId,
        );
      }
    } else if (req.kind === 'TOOL' && status === 'APPROVED') {
      await this.skills.runTool(
        {
          companyId: req.companyId,
          employeeId: req.employeeId,
          conversationId: req.conversationId,
        },
        req.skillKey ?? '',
        req.tool ?? '',
        (req.args as Record<string, unknown>) ?? {},
      );
    }
    // TOOL + REJECTED → nothing executes (same as a human reject).
    this.logger.warn(
      `approval-sla auto-${status.toLowerCase()} chain=${req.chainId} level=${req.level}`,
    );
  }
}
