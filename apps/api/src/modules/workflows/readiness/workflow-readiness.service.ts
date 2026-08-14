import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  TriggerConfig,
  TriggerType,
  WorkflowDefinition,
  WorkflowReadinessDto,
} from '@vaep/types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SkillRequirementsService } from '../../skills/skill-requirements.service';
import { computeWarnings } from '../workflows.mapper';
import { evaluateReadiness } from './workflow-readiness';

/**
 * Loads everything the pure readiness evaluator needs and runs it.
 *
 * Deliberately thin, and deliberately reads the graph the builder is showing —
 * see the note on `definition` below for why that is the column rather than the
 * draft version.
 */
@Injectable()
export class WorkflowReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skillRequirements: SkillRequirementsService,
  ) {}

  async forWorkflow(
    companyId: string,
    workflowId: string,
    opts: { canManageConnection: boolean },
  ): Promise<WorkflowReadinessDto> {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, companyId },
    });
    if (!workflow) {
      throw new NotFoundException('Workflow not found');
    }

    // Read the `definition` COLUMN — the graph the builder is showing and the
    // one publish will actually freeze.
    //
    // Not `resolveDefinitionForInspection`, which prefers the draft VERSION.
    // The canvas autosaves to the column (PATCH), while a draft version is only
    // written at publish time (`usePublishAndActivate` does getWorkflow →
    // PUT /draft → publish). So after any publish attempt the draft version is
    // a stale snapshot: preferring it made readiness report on a graph the user
    // had already fixed, and keep saying "not ready" after they had connected
    // the step. Caught by the readiness-vs-publish agreement e2e.
    const definition = workflow.definition as unknown as WorkflowDefinition;

    const requirements = await this.skillRequirements.forDefinition(
      companyId,
      definition,
      opts,
    );

    return evaluateReadiness({
      workflowId,
      name: workflow.name,
      definition,
      triggerType: workflow.triggerType as TriggerType,
      triggerConfig: workflow.triggerConfig as TriggerConfig | null,
      skillRequirements: requirements.requirements,
      warnings: computeWarnings(definition),
    });
  }
}
