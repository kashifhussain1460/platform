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
  AiEmployeeDto,
  ConversationDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesService } from './employees.service';

/**
 * All routes are tenant-scoped by companyId from the JWT and JWT-guarded.
 * Managing employees (create/update/delete) requires the `employee:manage`
 * capability — floor ADMIN, i.e. exactly the `@Roles('OWNER','ADMIN')` it
 * replaces; reads and starting/continuing conversations (chat) stay open to any
 * member.
 */
@Controller('employees')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Post()
  @RequirePermission('employee:manage')
  create(
    @CurrentTenant() companyId: string,
    @Body() dto: CreateEmployeeDto,
  ): Promise<AiEmployeeDto> {
    return this.employees.create(companyId, dto);
  }

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ): Promise<AiEmployeeDto[]> {
    // WAVE 2 — the caller is passed so the roster is department-scoped.
    return this.employees.list(companyId, limit, user.userId);
  }

  @Get(':id')
  get(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<AiEmployeeDto> {
    return this.employees.get(companyId, id, user.userId);
  }

  @Patch(':id')
  @RequirePermission('employee:manage')
  update(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
  ): Promise<AiEmployeeDto> {
    return this.employees.update(companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('employee:manage')
  @HttpCode(204)
  remove(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<void> {
    return this.employees.remove(companyId, id);
  }

  @Post(':id/conversations')
  startConversation(
    @CurrentTenant() companyId: string,
    @Param('id') employeeId: string,
    @Body('title') title?: string,
  ): Promise<ConversationDto> {
    return this.employees.startConversation(companyId, employeeId, title);
  }

  @Get(':id/conversations')
  listConversations(
    @CurrentTenant() companyId: string,
    @Param('id') employeeId: string,
    @Query('limit') limit?: string,
  ): Promise<ConversationDto[]> {
    return this.employees.listConversations(companyId, employeeId, limit);
  }
}
