import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { WorkflowPermissionDto } from '@vaep/types';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateWorkflowPermissionDto } from './dto/create-workflow-permission.dto';
import { WorkflowPermissionService } from './workflow-permissions.service';

/**
 * Workflow permission grants (P3-06, doc 09 §9.C.5/§9.C.6). Not `@Roles()`-gated at
 * the controller — a workflow OWNER who is only a company MEMBER must still be able
 * to share their workflow, so the "can manage" check (owner OR admin) lives in the
 * service. Tenant is taken from the JWT.
 */
@Controller('workflows/:id/permissions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkflowPermissionsController {
  constructor(private readonly permissions: WorkflowPermissionService) {}

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workflowId: string,
  ): Promise<WorkflowPermissionDto[]> {
    return this.permissions.list(companyId, workflowId, user);
  }

  @Post()
  grant(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workflowId: string,
    @Body() dto: CreateWorkflowPermissionDto,
  ): Promise<WorkflowPermissionDto> {
    return this.permissions.grant(companyId, workflowId, user, dto);
  }

  @Delete(':permissionId')
  @HttpCode(204)
  revoke(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workflowId: string,
    @Param('permissionId') permissionId: string,
  ): Promise<void> {
    return this.permissions.revoke(companyId, workflowId, user, permissionId);
  }
}
