import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { EmployeeSkillDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { AssignSkillDto } from './dto/assign-skill.dto';
import { SkillsService } from './skills.service';

/**
 * Employee ↔ installed-skill assignments. Lives in the skills module (routes are
 * nested under /employees/:id/skills but don't overlap the EmployeesController's
 * own routes). Tenant-scoped + JWT-guarded. Assign/unassign is
 * gated by `skill:connect` (floor ADMIN, unchanged from the
 * `@Roles('OWNER','ADMIN')` it replaces); listing an employee's skills stays open.
 */
@Controller('employees/:id/skills')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class EmployeeSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Param('id') employeeId: string,
    @Query('limit') limit?: string,
  ): Promise<EmployeeSkillDto[]> {
    return this.skills.listEmployeeSkills(companyId, employeeId, limit);
  }

  @Post()
  @RequirePermission('skill:connect')
  assign(
    @CurrentTenant() companyId: string,
    @Param('id') employeeId: string,
    @Body() dto: AssignSkillDto,
  ): Promise<EmployeeSkillDto> {
    return this.skills.assign(companyId, employeeId, dto.installedSkillId);
  }

  @Delete(':installedSkillId')
  @RequirePermission('skill:connect')
  @HttpCode(204)
  unassign(
    @CurrentTenant() companyId: string,
    @Param('id') employeeId: string,
    @Param('installedSkillId') installedSkillId: string,
  ): Promise<void> {
    return this.skills.unassign(companyId, employeeId, installedSkillId);
  }
}
