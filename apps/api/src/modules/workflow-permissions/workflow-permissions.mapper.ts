import type { WorkflowPermission } from '@prisma/client';
import type { WorkflowPermissionDto } from '@vaep/types';

/** Prisma row → public DTO for workflow permissions (P3-06). */
export function toWorkflowPermissionDto(
  p: WorkflowPermission,
): WorkflowPermissionDto {
  return {
    id: p.id,
    companyId: p.companyId,
    workflowId: p.workflowId,
    subjectType: p.subjectType,
    subjectId: p.subjectId,
    action: p.action,
    grantedByUserId: p.grantedByUserId,
    createdAt: p.createdAt.toISOString(),
  };
}
