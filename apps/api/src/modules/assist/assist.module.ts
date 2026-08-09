import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { LlmModule } from '../employees/llm/llm.module';
import { SkillsModule } from '../skills/skills.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { AssistAgentService } from './agent/assist-agent.service';
import { AssistController } from './assist.controller';
import { AssistService } from './assist.service';

/**
 * Orlixa AI Assist (doc 30) — the conversational workflow builder.
 *
 * Imports WorkflowsModule for the ONE thing accept needs: the ordinary
 * `WorkflowsService.create` path, so an accepted draft goes through exactly the
 * same validation, audit and ownership as a hand-built workflow. BillingModule
 * supplies `BillingService` for `PlanGuard`; Prisma and Audit are global.
 *
 * Direction is one-way — Workflows knows nothing about Assist — so there is no
 * cycle. When the agent lands (wave A2) it stays inside this module and reaches
 * the LLM via `LlmModule` directly, the same fork WorkflowsModule uses to avoid
 * Approvals → Workflows → Employees → Approvals.
 */
@Module({
  // LlmModule directly, NOT EmployeesModule — the same fork WorkflowsModule uses
  // to stay out of Approvals → Workflows → Employees → Approvals. SkillsModule
  // supplies SkillRequirementsService so a proposed draft's unconnected skills
  // surface as an in-chat connection card (doc 30 §12) — one-way, no cycle.
  imports: [WorkflowsModule, BillingModule, LlmModule, SkillsModule],
  controllers: [AssistController],
  providers: [AssistService, AssistAgentService],
  exports: [AssistService],
})
export class AssistModule {}
