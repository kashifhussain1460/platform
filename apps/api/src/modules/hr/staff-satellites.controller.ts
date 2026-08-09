import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AttendanceRecordDto,
  OnboardingTaskDto,
} from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import {
  CreateAttendanceRecordDto,
  CreateOnboardingTaskDto,
} from './dto/staff.dto';
import { StaffService } from './staff.service';

/** Attendance records (P3-01), a StaffMember satellite. OWNER/ADMIN only. */
@Controller('hr/attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class AttendanceController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Query('staffId') staffId?: string,
  ): Promise<AttendanceRecordDto[]> {
    if (!staffId) {
      throw new BadRequestException('staffId query parameter is required');
    }
    return this.staff.listAttendance(companyId, staffId);
  }

  @Post()
  record(
    @CurrentTenant() companyId: string,
    @Body() dto: CreateAttendanceRecordDto,
  ): Promise<AttendanceRecordDto> {
    return this.staff.recordAttendance(companyId, dto);
  }
}

/** Onboarding tasks (P3-01), a StaffMember satellite. OWNER/ADMIN only. */
@Controller('hr/onboarding-tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class OnboardingController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Query('staffId') staffId?: string,
  ): Promise<OnboardingTaskDto[]> {
    if (!staffId) {
      throw new BadRequestException('staffId query parameter is required');
    }
    return this.staff.listOnboarding(companyId, staffId);
  }

  @Post()
  create(
    @CurrentTenant() companyId: string,
    @Body() dto: CreateOnboardingTaskDto,
  ): Promise<OnboardingTaskDto> {
    return this.staff.createOnboardingTask(companyId, dto);
  }

  @Post(':id/complete')
  complete(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<OnboardingTaskDto> {
    return this.staff.completeOnboardingTask(companyId, id);
  }
}
