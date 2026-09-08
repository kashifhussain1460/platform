import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { WhatsAppAccountDto } from '@vaep/types';
import { CurrentTenant } from '../../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../../authorization/authorization.guard';
import { RequirePermission } from '../../authorization/require-permission.decorator';
import { ConnectWhatsAppAccountDto } from './dto/connect-whatsapp-account.dto';
import { WhatsappAccountsService } from './whatsapp-accounts.service';

/**
 * The dedicated `WhatsAppAccount` connect surface (Task 13).
 *
 * `POST /skills/installed/:id/connect` cannot do this job: it only ever
 * writes `InstalledSkill.credentials`, and `WhatsAppAccount` is its own
 * top-level table with no FK back to `InstalledSkill`. Gated by
 * `skill:connect` (ADMIN floor) — same capability the generic Skill Config
 * connect/disconnect routes use, since this is the same kind of action
 * (handing the platform a live outside credential).
 */
@Controller('engines/whatsapp/accounts')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
export class WhatsappAccountsController {
  constructor(private readonly accounts: WhatsappAccountsService) {}

  @Get()
  @RequirePermission('skill:connect')
  getAccount(@CurrentTenant() companyId: string): Promise<WhatsAppAccountDto | null> {
    return this.accounts.getAccount(companyId);
  }

  @Post()
  @RequirePermission('skill:connect')
  connect(
    @CurrentTenant() companyId: string,
    @Body() dto: ConnectWhatsAppAccountDto,
  ): Promise<WhatsAppAccountDto> {
    return this.accounts.connect(companyId, dto);
  }
}
