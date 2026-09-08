import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { LeadDetailDto, LeadDto, LeadSource, LeadStatus } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { LeadsService } from './leads.service';

/**
 * The Leads workspace — the human front door to the WhatsApp Sales AI
 * Employee's prospects (`Lead`, added in Task 1 with no API over it until
 * now).
 *
 * `lead:read` only (MEMBER floor), same shape as `marketing:read`: anyone in
 * the company can see what has come in and what the AI has done with it.
 * There is no `lead:manage` yet — this module is read-only.
 *
 * Tenant comes from the JWT on every route; the service filters by it on
 * every query, so a wrong id is a 404, never another company's lead.
 */
@Controller('leads')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermission('lead:read')
  listLeads(
    @CurrentTenant() companyId: string,
    @Query('status') status?: LeadStatus,
    @Query('source') source?: LeadSource,
  ): Promise<LeadDto[]> {
    return this.leads.listLeads(companyId, { status, source });
  }

  @Get(':id')
  @RequirePermission('lead:read')
  getLead(
    @CurrentTenant() companyId: string,
    @Param('id') id: string,
  ): Promise<LeadDetailDto> {
    return this.leads.getLead(companyId, id);
  }
}
