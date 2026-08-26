import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  WorkflowCategory,
  WorkflowDto,
  WorkflowTemplateSummaryDto,
} from '@vaep/types';
import { WORKFLOW_CATEGORIES } from '@vaep/types';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateWorkflowTemplateDto } from './dto/create-workflow-template.dto';
import { InstallWorkflowTemplateDto } from './dto/install-workflow-template.dto';
import { WorkflowTemplatesService } from './workflow-templates.service';

/**
 * Workflow templates (P3-02). Browsing (list / parameters) is open to any
 * authenticated member; authoring a template and installing one both require
 * OWNER/ADMIN (doc 19 §19-22). Tenant is taken from the JWT.
 */
@Controller('workflow-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkflowTemplatesController {
  constructor(private readonly templates: WorkflowTemplatesService) {}

  /**
   * Gap fix (2026-08-20): this endpoint returned every published template
   * with no way to narrow by category, and the templates themselves sort
   * `category ASC` — so any UI that takes "the first N" (e.g. the AI Assist
   * landing page) always showed HR first (alphabetically earliest),
   * regardless of which AI Employee/role the user actually cared about.
   * `category` is optional and additive — an omitted value is the exact
   * previous behaviour.
   */
  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Query('category') category?: string,
  ): Promise<WorkflowTemplateSummaryDto[]> {
    const validCategory =
      category && (WORKFLOW_CATEGORIES as readonly string[]).includes(category)
        ? (category as WorkflowCategory)
        : undefined;
    return this.templates.list(companyId, validCategory);
  }

  @Get(':id/parameters')
  parameters(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<WorkflowTemplateSummaryDto> {
    return this.templates.get(companyId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkflowTemplateDto,
  ): Promise<WorkflowTemplateSummaryDto> {
    return this.templates.createTemplate(companyId, dto, user.userId);
  }

  @Post(':id/install')
  @Roles('OWNER', 'ADMIN')
  install(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: InstallWorkflowTemplateDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<WorkflowDto> {
    return this.templates.install(
      companyId,
      id,
      dto,
      user.userId,
      idempotencyKey?.trim() || undefined,
    );
  }
}
