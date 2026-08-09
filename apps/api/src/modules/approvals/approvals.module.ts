import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { queueWorkersEnabled } from '../../common/resilience/queue-workers';
import { ApprovalRoutingModule } from '../approval-routing/approval-routing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SkillsModule } from '../skills/skills.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { ApprovalService } from './approval.service';
import { ApprovalsController } from './approvals.controller';
import { APPROVAL_SLA_QUEUE } from './sla/approval-sla.constants';
import { ApprovalSlaProcessor } from './sla/approval-sla.processor';
import { ApprovalSlaService } from './sla/approval-sla.service';

/**
 * Approval Center module. Imports SkillsModule so approve/modify can execute the
 * stored tool call via SkillsService.runTool (which writes the SkillExecution
 * audit row), and WorkflowsModule so a WORKFLOW-kind decision can resume/cancel
 * the paused run via WorkflowsService. Exports ApprovalService so the AI Employee
 * runtime's ToolExecutorService can intercept high-risk tool calls
 * (EmployeesModule imports this module).
 *
 * DI: the Approvals→Workflows edge is one-directional — WorkflowsModule does NOT
 * import ApprovalsModule (its engine writes ApprovalRequest rows via Prisma), and
 * it imports LlmModule (not EmployeesModule) for AI_STEP, so there is no cycle.
 * SkillsModule must NOT import ApprovalsModule either.
 */
@Module({
  imports: [
    SkillsModule,
    WorkflowsModule,
    ApprovalRoutingModule,
    NotificationsModule,
    // P3-05 §8.2 — the SLA sweep queue (shared BullMQ connection registered globally
    // by KnowledgeModule, so only registerQueue is needed).
    BullModule.registerQueue({ name: APPROVAL_SLA_QUEUE }),
  ],
  controllers: [ApprovalsController],
  providers: [
    ApprovalService,
    ApprovalSlaService,
    // The sweep worker is only instantiated where queue workers run (not on the
    // Vercel serverless entry — same gate as WorkflowProcessor).
    ...(queueWorkersEnabled() ? [ApprovalSlaProcessor] : []),
  ],
  exports: [ApprovalService, ApprovalSlaService],
})
export class ApprovalsModule {}
