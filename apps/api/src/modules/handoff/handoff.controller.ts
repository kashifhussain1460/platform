import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import type { HandoffRequestDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { HandoffService } from './handoff.service';

class EscalateHandoffDto {
  @IsString()
  conversationId!: string;

  @IsString()
  employeeId!: string;

  @IsString()
  reason!: string;
}

class ResolveHandoffDto {
  /** true = AI may resume this conversation; false = conversation is closed. */
  @IsBoolean()
  resume!: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

/**
 * S-13/C-06: tenant-scoped, JWT-guarded routes for the shared Human Handoff
 * mechanism. Eligibility to resolve is NOT a blanket `@Roles` — mirrors
 * ApprovalsController's own routed-decision model (HandoffService.resolve →
 * ApprovalRoutingService.canDecide), so a routed handoff is only resolvable
 * by whoever it was actually routed to.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class HandoffController {
  constructor(private readonly handoff: HandoffService) {}

  @Post('support/conversations/:id/escalate')
  escalate(
    @CurrentTenant() companyId: string,
    @Param('id') conversationId: string,
    @Body() dto: EscalateHandoffDto,
  ) {
    return this.handoff.escalate({
      companyId,
      conversationId,
      employeeId: dto.employeeId,
      reason: dto.reason,
    });
  }

  /**
   * The human handoff inbox.
   *
   * Open to any authenticated member: the whole tenant queue is returned with
   * a per-row `canResolve` so a colleague can SEE work they cannot personally
   * action, which is how a support queue stays unblocked. `?assignedToMe=true`
   * narrows it to this user's own eligible items; `?status=` filters.
   *
   * Eligibility is still enforced where it matters — on `resolve` below.
   */
  @Get('handoffs')
  list(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: 'PENDING' | 'RESOLVED' | 'CANCELLED',
    @Query('assignedToMe') assignedToMe?: string,
  ): Promise<HandoffRequestDto[]> {
    return this.handoff.list(companyId, user.userId, {
      status,
      assignedToMe: assignedToMe === 'true',
    });
  }

  @Post('handoffs/:id/resolve')
  resolve(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResolveHandoffDto,
  ) {
    return this.handoff.resolve(companyId, id, user.userId, dto.resume, dto.note);
  }
}
