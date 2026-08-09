import { Module } from '@nestjs/common';
import { WorkflowPermissionsController } from './workflow-permissions.controller';
import { WorkflowPermissionService } from './workflow-permissions.service';

/**
 * Workflow permissions module (P3-06). A dependency-light leaf — injects only the
 * global PrismaService and the pure `roleSatisfies` — so WorkflowsModule can import
 * it for the enqueue-time `workflow:run` check without a cycle (it imports nothing
 * that imports Workflows back). Its controller mounts `/workflows/:id/permissions`.
 */
@Module({
  controllers: [WorkflowPermissionsController],
  providers: [WorkflowPermissionService],
  exports: [WorkflowPermissionService],
})
export class WorkflowPermissionsModule {}
