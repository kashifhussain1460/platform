import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SkillsModule } from '../skills/skills.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BillingModule } from '../billing/billing.module';
import { ConversationsController } from './conversations.controller';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { LlmModule } from './llm/llm.module';
import { AgentRuntimeService } from './runtime/agent-runtime.service';
import { AiEmployeeStepNodeHandler } from './runtime/ai-employee-step.handler';
import { WorkflowsModule } from '../workflows/workflows.module';
import { LlmRouterService } from './runtime/llm-router.service';
import { MemoryService } from './runtime/memory.service';
import { PlannerService } from './runtime/planner.service';
import { RetrievalService } from './runtime/retrieval.service';
import { SensitiveScenarioService } from './runtime/sensitive-scenario.service';
import { ToolExecutorService } from './runtime/tool-executor.service';
import { ValidationService } from './runtime/validation.service';
import { CreditsModule } from '../credits/credits.module';

/**
 * AI Employee runtime module. Imports KnowledgeModule so RetrievalService can
 * reuse its tenant-scoped pgvector search (the "retrieve-knowledge" step), and
 * LlmModule for the shared LlmProvider singleton (LLM_PROVIDER_TOKEN). The LLM
 * factory now lives in LlmModule so WorkflowsModule can inject the same provider
 * without importing EmployeesModule (which would form an Approvals→Workflows→
 * Employees→Approvals cycle, since EmployeesModule imports ApprovalsModule).
 * Also imports BillingModule so EmployeesService can gate hiring on the
 * company's subscription (seat limit + status) — BillingModule has no imports
 * of its own, so this is a safe one-directional edge (no cycle).
 */
@Module({
  // WorkflowsModule is imported for the exported NodeRegistry only, so
  // AiEmployeeStepNodeHandler can register itself. Employees→Workflows closes
  // no cycle: WorkflowsModule imports neither Employees nor Approvals.
  imports: [
    KnowledgeModule,
    SkillsModule,
    ApprovalsModule,
    LlmModule,
    BillingModule,
    WorkflowsModule,
    CreditsModule,
  ],
  controllers: [EmployeesController, ConversationsController, LearningController],
  providers: [
    EmployeesService,
    LearningService,
    AgentRuntimeService,
    AiEmployeeStepNodeHandler,
    LlmRouterService,
    PlannerService,
    RetrievalService,
    MemoryService,
    SensitiveScenarioService,
    ToolExecutorService,
    ValidationService,
  ],
  exports: [EmployeesService],
})
export class EmployeesModule {}
