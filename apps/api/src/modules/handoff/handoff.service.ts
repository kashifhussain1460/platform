import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { HandoffRequest } from '@prisma/client';
import type { HandoffRequestDto } from '@vaep/types';
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
    // ApprovalRoutingConfig, which is authored per-employee/per-node).
    const resolved = await this.routing.resolveStep(
      companyId,
      { rule: 'EMPLOYEE_MANAGER' },
      { employeeId },
    );

    // 🔴 A handoff routed to nobody is a conversation nobody can ever rescue.
    //
    // `resolveStep('EMPLOYEE_MANAGER')` returns an EMPTY assignee when the AI
    // Employee has no `managerUserId` (the common case — it is an optional
    // field), and `canDecide('EMPLOYEE_MANAGER')` requires a CONCRETE
    // `assigneeUserId`. Storing that pair as-is produced a handoff that
    // returned false for every user in the company, owners included, while
    // the conversation sat ESCALATED with the reply guard blocking the AI.
    // The customer waits for a human who is structurally unable to answer.
    //
    // Approvals survive the same dead end because the §8.2 SLA sweep escalates
    // a breached row onward; handoffs have no sweep, so the dead end here is
    // permanent. Fall back to ANY_ADMIN — still a real authorization boundary
    // (admins only, enforced by the same `canDecide`), just never an empty set.
    const routed =
      resolved.assigneeUserId != null
        ? resolved
        : {
            approverRuleType: 'ANY_ADMIN' as const,
            approverRuleValue: undefined,
            assigneeUserId: undefined,
          };

    const handoff = await this.prisma.$transaction(async (tx) => {
      const created = await tx.handoffRequest.create({
        data: {
          companyId,
          conversationId,
          employeeId,
          reason,
          status: 'PENDING',
          approverRuleType: routed.approverRuleType,
          approverRuleValue: routed.approverRuleValue ?? null,
          assigneeUserId: routed.assigneeUserId ?? null,
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

  /**
   * The human handoff inbox.
   *
   * ## Why this exists
   *
   * `escalate()` and `resolve()` both shipped, and nothing listed the queue in
   * between — so an AI could step back from a customer conversation and the
   * human it was handed to had no screen showing it. An escalation nobody can
   * see is the same defect class as an approval nobody can see.
   *
   * Returns the WHOLE tenant queue with a per-row `canResolve`, rather than
   * pre-filtering to the caller. Mirrors `ApprovalService.list`'s
   * `assignedToMe` option in its rules but not its default: a support queue
   * that hides work from a colleague who could pick it up is a queue that
   * stalls. `resolve()` still enforces eligibility server-side.
   *
   * `recentMessages` is bounded to the last 5 per conversation: enough for a
   * human to judge the escalation without turning the inbox into an unbounded
   * transcript dump.
   */
  async list(
    companyId: string,
    userId: string,
    opts: { status?: 'PENDING' | 'RESOLVED' | 'CANCELLED'; assignedToMe?: boolean } = {},
  ): Promise<HandoffRequestDto[]> {
    const rows = await this.prisma.handoffRequest.findMany({
      where: { companyId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        conversation: {
          select: {
            id: true,
            contactEmail: true,
            status: true,
            lastMessageAt: true,
            messages: {
              // `id` breaks the tie: two messages written in the same
              // statement share `createdAt` to the microsecond, and without a
              // second key Postgres is free to return them either way round —
              // a transcript that reads backwards misleads the human deciding
              // what to do. cuids are time-ordered, so this is stable.
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 5,
              select: {
                id: true,
                direction: true,
                content: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });

    const decider = await this.loadDecider(companyId, userId);
    const mapped = rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      conversationId: row.conversationId,
      employeeId: row.employeeId,
      reason: row.reason,
      status: row.status,
      assigneeUserId: row.assigneeUserId,
      resolvedById: row.resolvedById,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      canResolve: Boolean(decider) && this.canResolve(decider as DeciderUser, row),
      conversation: row.conversation
        ? {
            id: row.conversation.id,
            contactEmail: row.conversation.contactEmail,
            status: row.conversation.status,
            lastMessageAt: row.conversation.lastMessageAt.toISOString(),
            // Fetched newest-first for the `take: 5` bound, shown oldest-first
            // because that is how a conversation reads.
            recentMessages: [...row.conversation.messages]
              .reverse()
              .map((m) => ({
                id: m.id,
                direction: m.direction,
                body: m.content,
                createdAt: m.createdAt.toISOString(),
              })),
          }
        : null,
    }));

    return opts.assignedToMe ? mapped.filter((h) => h.canResolve) : mapped;
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
