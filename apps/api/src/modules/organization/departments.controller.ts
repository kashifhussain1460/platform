import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { DepartmentDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
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

  @Delete(':id')
  @RequirePermission('organization:manage')
  @HttpCode(204)
  remove(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.org.removeDepartment(companyId, id);
  }
}
