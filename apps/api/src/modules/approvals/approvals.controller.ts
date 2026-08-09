import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { ApprovalRequestDto, ApprovalStatus } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ApprovalService } from './approval.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { ModifyApprovalDto } from './dto/modify-approval.dto';

/**
 * Approval Center routes: tenant-scoped by companyId (from the JWT), JWT-guarded.
 *
 * P3-05 §8.1.6 / R12: the decide routes (approve/reject/modify) NO LONGER carry
 * `@Roles('OWNER','ADMIN')` — the eligibility boundary moved into the service
 * (`ApprovalService.assertCanDecide` → `ApprovalRoutingService.canDecide`), which
 * reproduces the exact OWNER/ADMIN rule for every UNROUTED request and only lets a
 * routed member decide the request routed to them. Reads stay open to any member.
 */
@Controller('approvals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}

  /**
   * List approval requests. `?status=PENDING|...` filters by status; `?assignedToMe=true`
   * narrows to the requests the caller is an eligible decider for (the "my inbox" view).
   */
  @Get()
  list(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: ApprovalStatus,
    @Query('assignedToMe') assignedToMe?: string,
  ): Promise<ApprovalRequestDto[]> {
    return this.approvals.list(companyId, {
      status,
      assignedToMeUserId: assignedToMe === 'true' ? user.userId : undefined,
    });
  }

  @Get(':id')
  get(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<ApprovalRequestDto> {
    return this.approvals.get(companyId, id);
  }

  /** Full decision trail for one logical approval (every level + escalation hop). */
  @Get(':id/history')
  history(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<ApprovalRequestDto[]> {
    return this.approvals.history(companyId, id);
  }

  /** Approve → advance to the next level, or run the final effect. 403 if ineligible. */
  @Post(':id/approve')
  approve(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideApprovalDto,
  ): Promise<ApprovalRequestDto> {
    return this.approvals.approve(companyId, id, user.userId, dto.note);
  }

  /** Reject → fail the whole chain. 403 if ineligible. */
  @Post(':id/reject')
  reject(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideApprovalDto,
  ): Promise<ApprovalRequestDto> {
    return this.approvals.reject(companyId, id, user.userId, dto.note);
  }

  /** Modify → (final level) execute with edited args, then APPROVED. 403 if ineligible. */
  @Post(':id/modify')
  modify(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ModifyApprovalDto,
  ): Promise<ApprovalRequestDto> {
    return this.approvals.modify(companyId, id, user.userId, dto.args, dto.note);
  }
}
