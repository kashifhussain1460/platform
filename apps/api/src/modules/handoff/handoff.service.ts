import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { HandoffRequest } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ApprovalRoutingService,
  type DeciderUser,
} from '../approval-routing/approval-routing.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * S-13/C-06 — the ONE shared Human Handoff mechanism.
 *
 * Deliberately NOT a second approval/routing engine: routing to a concrete
 * assignee reuses `ApprovalRoutingService.resolveStep`/`canDecide` in full,
 * the same resolver `ApprovalsModule` and `WorkflowsModule` already share
 * (`docs/architecture` P3-05 §8.1). This module only owns the DIFFERENT
 * lifecycle a handoff actually is: pausing an entire conversation's future AI
 * turns, not gating one tool call or workflow run.
 *
 * A leaf-ish module (PrismaService [global] + ApprovalRoutingModule +
 * NotificationsModule, both already-dependency-light forks) so it can be
 * imported from both `EmployeesModule` (where a sensitive-scenario detector
 * could trigger it) and `SkillsModule` (whose RealSkillExecutor enforces the
 * ESCALATED guard) without forming a cycle — neither of those two currently
 * imports the other, and this module imports neither back.
 */
@Injectable()
export class HandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ApprovalRoutingService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Escalate ONE conversation to a human. Idempotent: a conversation already
   * PENDING keeps its existing HandoffRequest rather than creating a second,
   * competing one. Sets `SupportConversation.status = ESCALATED` in the same
   * transaction, so the defense-in-depth guard in
   * `RealSkillExecutor.chatwootReplyToConversation` sees it immediately.
   */
  async escalate(params: {
    companyId: string;
    conversationId: string;
    employeeId: string;
    reason: string;
  }): Promise<HandoffRequest> {
    const { companyId, conversationId, employeeId, reason } = params;

    const conversation = await this.prisma.supportConversation.findFirst({
      where: { id: conversationId, companyId },
    });
    if (!conversation) {
      throw new NotFoundException('SupportConversation not found for this company');
    }

    const existing = await this.prisma.handoffRequest.findFirst({
      where: { companyId, conversationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return existing;
    }

    // EMPLOYEE_MANAGER is the pragmatic default routing target — no new
    // per-company handoff-routing config surface exists yet (unlike
    // ApprovalRoutingConfig, which is authored per-employee/per-node). If a
    // manager isn't set, resolveStep still returns a well-formed
    // ANY_ADMIN-shaped-but-empty assignee and canDecide/notifications both
    // already fall back to the admins in that case.
    const resolved = await this.routing.resolveStep(
      companyId,
      { rule: 'EMPLOYEE_MANAGER' },
      { employeeId },
    );

    const handoff = await this.prisma.$transaction(async (tx) => {
      const created = await tx.handoffRequest.create({
        data: {
          companyId,
          conversationId,
          employeeId,
          reason,
          status: 'PENDING',
          approverRuleType: resolved.approverRuleType,
          approverRuleValue: resolved.approverRuleValue ?? null,
          assigneeUserId: resolved.assigneeUserId ?? null,
        },
      });
      await tx.supportConversation.update({
        where: { id: conversationId },
        data: { status: 'ESCALATED' },
      });
      return created;
    });

    await this.notifications.handoffRequested(companyId, {
      assigneeUserId: handoff.assigneeUserId,
      summary: `A customer conversation was escalated: ${reason}`,
    });

    return handoff;
  }

  /** May THIS user resolve THIS handoff? Reuses the SAME rule semantics as approvals. */
  private canResolve(user: DeciderUser, handoff: HandoffRequest): boolean {
    return this.routing.canDecide(user, {
      approverRuleType: handoff.approverRuleType,
      approverRuleValue: handoff.approverRuleValue,
      assigneeUserId: handoff.assigneeUserId,
    });
  }

  private async loadDecider(
    companyId: string,
    userId: string,
  ): Promise<DeciderUser | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, companyId },
      select: { id: true, role: true, departmentId: true, teamId: true },
    });
  }

  /**
   * Human resolves the handoff. `resume` decides the outcome for the
   * conversation: back to OPEN (AI may draft/reply again) or RESOLVED
   * (done — same terminal state `chatwoot.resolve_conversation` writes today).
   */
  async resolve(
    companyId: string,
    handoffId: string,
    userId: string,
    resume: boolean,
    note?: string,
  ): Promise<HandoffRequest> {
    const handoff = await this.prisma.handoffRequest.findFirst({
      where: { id: handoffId, companyId },
    });
    if (!handoff) {
      throw new NotFoundException('Handoff request not found for this company');
    }
    if (handoff.status !== 'PENDING') {
      return handoff;
    }
    const decider = await this.loadDecider(companyId, userId);
    if (!decider || !this.canResolve(decider, handoff)) {
      throw new ForbiddenException(
        'You are not an eligible responder for this handoff',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const resolved = await tx.handoffRequest.update({
        where: { id: handoffId },
        data: {
          status: 'RESOLVED',
          resolvedById: userId,
          resolvedAt: new Date(),
          note: note ?? null,
        },
      });
      await tx.supportConversation.update({
        where: { id: handoff.conversationId },
        data: { status: resume ? 'OPEN' : 'RESOLVED' },
      });
      return resolved;
    });
  }
}
