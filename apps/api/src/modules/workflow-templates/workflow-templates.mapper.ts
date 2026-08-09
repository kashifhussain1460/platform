import type { WorkflowTemplate } from '@prisma/client';
import type {
  TemplateParameter,
  WorkflowCategory,
  WorkflowTemplateRequires,
  WorkflowTemplateSummaryDto,
} from '@vaep/types';

/**
 * Prisma row → summary DTO for workflow templates (P3-02). The `definition` is
 * intentionally omitted — it is internal; clients need `parameters`/`requires` to
 * render the install form, not the graph itself.
 */
export function toWorkflowTemplateSummaryDto(
  t: WorkflowTemplate,
): WorkflowTemplateSummaryDto {
  return {
    id: t.id,
    companyId: t.companyId,
    key: t.key,
    version: t.version,
    name: t.name,
    description: t.description,
    category: t.category as WorkflowCategory,
    parameters: (t.parameters as unknown as TemplateParameter[]) ?? [],
    requires: (t.requires as unknown as WorkflowTemplateRequires) ?? {
      skills: [],
      employeeRoles: [],
    },
    status: t.status,
    createdAt: t.createdAt.toISOString(),
  };
}
