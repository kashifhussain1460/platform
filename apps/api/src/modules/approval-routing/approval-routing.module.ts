import { Module } from '@nestjs/common';
import { ApprovalRoutingService } from './approval-routing.service';

/**
 * Approval routing (P3-05 §8.1). A deliberately dependency-light module — it
 * injects only the global PrismaService and uses two PURE functions (`roleSatisfies`,
 * `resolveTemplate`) — so BOTH WorkflowsModule and ApprovalsModule can import it
 * without forming the Approvals→Workflows→Approvals cycle (§8.1.3). It imports
 * nothing that imports either of them back.
 */
@Module({
  providers: [ApprovalRoutingService],
  exports: [ApprovalRoutingService],
})
export class ApprovalRoutingModule {}
