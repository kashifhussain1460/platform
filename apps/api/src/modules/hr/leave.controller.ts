import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { LeaveRequestDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateLeaveRequestDto, DecideLeaveRequestDto } from './dto/leave.dto';
import { LeaveService } from './leave.service';

/** Leave requests (P3-01). `reason` is special-category PII. OWNER/ADMIN only. */
@Controller('hr/leave')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Query('staffId') staffId?: string,
  ): Promise<LeaveRequestDto[]> {
    return this.leave.list(companyId, staffId);
  }

  @Post()
  create(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLeaveRequestDto,
  ): Promise<LeaveRequestDto> {
    return this.leave.create(companyId, dto, user.userId);
  }

  @Post(':id/decide')
  decide(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideLeaveRequestDto,
  ): Promise<LeaveRequestDto> {
    return this.leave.decide(companyId, id, dto.status, user.userId);
  }
}
