import type { ApprovalRequest } from '@prisma/client';
import type { ApprovalRequestDto } from '@vaep/types';

/** Prisma row → public DTO mapper for the approvals module. */
export function toApprovalRequestDto(a: ApprovalRequest): ApprovalRequestDto {
  return {
    id: a.id,
    companyId: a.companyId,
    kind: a.kind,
    employeeId: a.employeeId,
    conversationId: a.conversationId,
    workflowRunId: a.workflowRunId,
    skillKey: a.skillKey,
    tool: a.tool,
    args: (a.args as Record<string, unknown>) ?? {},
    result: a.result ?? null,
    description: a.description,
    status: a.status,
    decidedById: a.decidedById,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    note: a.note,
    createdAt: a.createdAt.toISOString(),
    // P3-05 §8.1 routing fields (routingSnapshot deliberately NOT exposed — internal).
    chainId: a.chainId,
    level: a.level,
    escalationTier: a.escalationTier,
    assigneeUserId: a.assigneeUserId,
    approverRuleType: a.approverRuleType,
    approverRuleValue: a.approverRuleValue,
    dueAt: a.dueAt?.toISOString() ?? null,
    slaMinutes: a.slaMinutes,
    timeoutPolicy: a.timeoutPolicy,
    autoDecided: a.autoDecided,
    escalatedToId: a.escalatedToId,
  };
}
