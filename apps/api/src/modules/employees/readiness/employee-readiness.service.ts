import { Injectable, NotFoundException } from '@nestjs/common';
import type { EmployeeReadinessDto } from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SkillRequirementsService } from '../../skills/skill-requirements.service';
import { knowledgeRetrievalAllowed } from '../../skills/employee-permission-policy';
import { workflowsReferencingEmployee } from '../workflow-references';
import { evaluateEmployeeReadiness } from './employee-readiness';

/**
 * The thin I/O shell around the pure `evaluateEmployeeReadiness`. Fetches
 * exactly the state the evaluator needs and does no computing of its own —
 * same split as `WorkflowReadinessService` / `workflow-readiness.ts`.
 */
@Injectable()
export class EmployeeReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skillRequirements: SkillRequirementsService,
  ) {}

  async forEmployee(
    companyId: string,
    employeeId: string,
  ): Promise<EmployeeReadinessDto> {
    const employee = await this.prisma.aiEmployee.findFirst({
      where: { id: employeeId, companyId },
      select: {
        id: true,
        name: true,
        status: true,
        archivedAt: true,
        knowledgeAccess: true,
        permissions: true,
        role: true,
      },
    });
    if (!employee) {
      throw new NotFoundException('AI Employee not found');
    }

    const [skillRows, knowledgeDocumentCount, referencing] = await Promise.all([
      this.prisma.employeeSkill.findMany({
        where: { companyId, employeeId },
        select: { installedSkill: { select: { skillKey: true } } },
      }),
      // Same role-scoped visibility chat/RETRIEVE use — a category-null
      // document is company-wide, a role-tagged one only counts for that role.
      this.prisma.knowledgeDocument.count({
        where: {
          companyId,
          OR: [{ category: null }, { category: employee.role }],
        },
      }),
      workflowsReferencingEmployee(this.prisma, companyId, employeeId),
    ]);

    const assignedSkillKeys = [
      ...new Set(skillRows.map((r) => r.installedSkill.skillKey)),
    ];

    const { requirements } =
      assignedSkillKeys.length > 0
        ? await this.skillRequirements.forSkillKeys(companyId, assignedSkillKeys, {
            canManageConnection: true,
          })
        : { requirements: [] };

    const activeWorkflowCount =
      referencing.length === 0
        ? 0
        : await this.prisma.workflow.count({
            where: { companyId, id: { in: referencing }, status: 'ACTIVE' },
          });

    return evaluateEmployeeReadiness({
      employeeId: employee.id,
      name: employee.name,
      status: employee.status,
      archivedAt: employee.archivedAt,
      assignedSkillKeys,
      skillRequirements: requirements,
      workflowCount: referencing.length,
      activeWorkflowCount,
      knowledgeDocumentCount,
      knowledgeAccessEnabled: knowledgeRetrievalAllowed(employee),
    });
  }
}
