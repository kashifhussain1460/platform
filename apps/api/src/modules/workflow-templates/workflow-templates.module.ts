import { Module } from '@nestjs/common';
import { WorkflowTemplatesController } from './workflow-templates.controller';
import { WorkflowTemplatesService } from './workflow-templates.service';

/**
 * Workflow templates module (Wave P3-02). A clean leaf: it reuses only PURE
 * functions from other modules (`validateDefinitionStructure`, `resolveTemplate`,
 * `toWorkflowDto`, `SkillCatalog`) plus the global PrismaService + AuditLogService,
 * so it imports no other feature module and closes no dependency cycle. Install
 * creates the Workflow + v1 WorkflowVersion directly in one transaction.
 */
@Module({
  controllers: [WorkflowTemplatesController],
  providers: [WorkflowTemplatesService],
  exports: [WorkflowTemplatesService],
})
export class WorkflowTemplatesModule {}
