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
import type { StaffMemberDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateStaffMemberDto, UpdateStaffMemberDto } from './dto/staff.dto';
import { StaffService } from './staff.service';

/**
 * Staff roster (P3-01). HR data is special-category PII, so EVERY route —
 * reads included — is restricted to OWNER/ADMIN (not just mutations). Tenant is
 * taken from the JWT; a member of another company gets 404, never another
 * tenant's row.
 */
@Controller('hr/staff')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(@CurrentTenant() companyId: string): Promise<StaffMemberDto[]> {
    return this.staff.list(companyId);
  }

  @Get(':id')
  get(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<StaffMemberDto> {
    return this.staff.get(companyId, id);
  }

  @Post()
  create(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStaffMemberDto,
  ): Promise<StaffMemberDto> {
    return this.staff.create(companyId, dto, user.userId);
  }

  @Patch(':id')
  update(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateStaffMemberDto,
  ): Promise<StaffMemberDto> {
    return this.staff.update(companyId, id, dto, user.userId);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.staff.remove(companyId, id, user.userId);
  }
}
