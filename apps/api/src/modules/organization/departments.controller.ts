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
import type { DepartmentDependenciesDto, DepartmentDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { OrganizationService } from './organization.service';

/**
 * Departments (P1 #7), tenant-scoped by companyId from the JWT. Reading is open
 * to any authenticated member; mutations require the `organization:manage`
 * capability, whose floor (ADMIN) is exactly the `@Roles('OWNER','ADMIN')` it
 * replaces — same answer, one place to change it (plan §16).
 */
@Controller('departments')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class DepartmentsController {
  constructor(private readonly org: OrganizationService) {}

  @Get()
  list(@CurrentTenant() companyId: string): Promise<DepartmentDto[]> {
    return this.org.listDepartments(companyId);
  }

  @Post()
  @RequirePermission('organization:manage')
  create(
    @CurrentTenant() companyId: string,
    @Body() dto: CreateDepartmentDto,
  ): Promise<DepartmentDto> {
    return this.org.createDepartment(companyId, dto);
  }

  @Patch(':id')
  @RequirePermission('organization:manage')
  update(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
  ): Promise<DepartmentDto> {
    return this.org.updateDepartment(companyId, id, dto);
  }

  /**
   * Who and what a delete would affect. Any member may read it — it returns
   * counts and names inside their own tenant, which the roster already shows.
   */
  @Get(':id/dependencies')
  dependencies(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<DepartmentDependenciesDto> {
    return this.org.departmentDependencies(companyId, id);
  }

  /**
   * Remove a department.
   *
   * Returns 409 when it still has members and the caller has not said what
   * should happen to them — because `User.departmentId` is `onDelete: SetNull`,
   * so an unguarded delete silently promotes every member to company-wide
   * access.
   *
   * `?reassignTo=<departmentId>` moves members and teams there first (the safe
   * path). `?force=true` accepts the widening explicitly. Both are audited,
   * with `accessWidened` recorded either way.
   */
  @Delete(':id')
  @RequirePermission('organization:manage')
  @HttpCode(204)
  remove(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('reassignTo') reassignTo?: string,
    @Query('force') force?: string,
  ): Promise<void> {
    return this.org.removeDepartment(companyId, id, user.userId, {
      reassignTo: reassignTo?.trim() || null,
      force: force === 'true',
    });
  }
}
