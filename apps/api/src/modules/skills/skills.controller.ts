import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  InstalledSkillDto,
  SkillDefinitionDto,
  ToolCallDto,
  WorkflowSkillRequirementsDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { InstallSkillDto } from './dto/install-skill.dto';
import { UpdateInstalledSkillDto } from './dto/update-installed-skill.dto';
import { ExecuteToolDto } from './dto/execute-tool.dto';
import { ConfigureSkillDto } from './dto/configure-skill.dto';
import { ConnectSkillDto } from './dto/connect-skill.dto';
import { SkillsService } from './skills.service';
import { SkillRequirementsService } from './skill-requirements.service';

/**
 * All routes are tenant-scoped by companyId from the JWT and JWT-guarded.
 * Managing skills (install/update/uninstall/config/connect/disconnect) is
 * gated by the `skill:connect` capability (floor ADMIN — the same answer the
 * `@Roles('OWNER','ADMIN')` it replaces gave); the read-only catalog + installed
 * list stay open.
 */
@Controller('skills')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class SkillsController {
  constructor(
    private readonly skills: SkillsService,
    private readonly requirements: SkillRequirementsService,
  ) {}

  /** The built-in catalog + each skill's tools (code-defined, not per-tenant). */
  @Get('catalog')
  catalog(): SkillDefinitionDto[] {
    return this.skills.getCatalog();
  }

  /**
   * Live connection readiness for a set of skills (capability-first). Backs the
   * in-chat AI Assist Skill card's refresh after a connect — `?skillKeys=a,b`.
   * Any member may read; `canManageConnection` reflects OWNER/ADMIN.
   */
  @Get('requirements')
  skillRequirements(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('skillKeys') skillKeys?: string,
  ): Promise<WorkflowSkillRequirementsDto> {
    const keys = (skillKeys ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const canManageConnection = user.role === 'OWNER' || user.role === 'ADMIN';
    return this.requirements.forSkillKeys(companyId, keys, { canManageConnection });
  }

  @Post('install')
  @RequirePermission('skill:connect')
  install(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InstallSkillDto,
  ): Promise<InstalledSkillDto> {
    return this.skills.install(companyId, dto, user.userId);
  }

  @Get('installed')
  listInstalled(
    @CurrentTenant() companyId: string,
    @Query('limit') limit?: string,
  ): Promise<InstalledSkillDto[]> {
    return this.skills.listInstalled(companyId, limit);
  }

  @Patch('installed/:id')
  @RequirePermission('skill:connect')
  updateInstalled(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: UpdateInstalledSkillDto,
  ): Promise<InstalledSkillDto> {
    return this.skills.updateInstalled(companyId, id, dto);
  }

  @Delete('installed/:id')
  @RequirePermission('skill:connect')
  @HttpCode(204)
  uninstall(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.skills.uninstall(companyId, id);
  }

  /** Set company-specific configuration (validated against the skill's schema). */
  @Patch('installed/:id/config')
  @RequirePermission('skill:connect')
  configure(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: ConfigureSkillDto,
  ): Promise<InstalledSkillDto> {
    return this.skills.configureSkill(companyId, id, dto);
  }

  /** Connect the skill (store API key / OAuth token stub → CONNECTED). */
  @Post('installed/:id/connect')
  @RequirePermission('skill:connect')
  connect(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: ConnectSkillDto,
  ): Promise<InstalledSkillDto> {
    return this.skills.connectSkill(companyId, id, dto);
  }

  /** Disconnect the skill (clear credentials → NOT_CONNECTED). */
  @Post('installed/:id/disconnect')
  @RequirePermission('skill:connect')
  disconnect(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<InstalledSkillDto> {
    return this.skills.disconnectSkill(companyId, id);
  }

  /** Manually run a tool on an installed skill (logs a SkillExecution). */
  @Post('installed/:id/tools/:tool/execute')
  execute(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Param('tool') tool: string,
    @Body() dto: ExecuteToolDto,
  ): Promise<ToolCallDto> {
    return this.skills.executeInstalledTool(companyId, id, tool, dto.args);
  }
}
