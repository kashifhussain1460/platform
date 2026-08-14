import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuditLogDto } from '@vaep/types';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthorizationGuard } from '../authorization/authorization.guard';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { AuditLegalHoldService } from './audit-legal-hold.service';
import { AuditLogService } from './audit-log.service';
import type { ChainVerification } from './audit-chain';
import { CreateLegalHoldDto } from './dto/legal-hold.dto';
import { ListAuditLogQueryDto } from './dto/list-audit-log-query.dto';

/**
 * Who-did-what feed (tenant-scoped, JWT-guarded).
 *
 * Gated by the CAPABILITY `audit:read` rather than `@Roles('OWNER','ADMIN')`
 * (plan §16). The floor is identical — `MIN_ROLE['audit:read'] = 'ADMIN'`, and
 * OWNER outranks ADMIN — so this changes no answer today; what it changes is
 * where the answer LIVES. Deciding tomorrow that a compliance role may read the
 * audit trail is then one line in the policy, not a hunt through controllers.
 */
@Controller('audit-log')
@UseGuards(JwtAuthGuard, AuthorizationGuard)
@RequirePermission('audit:read')
export class AuditLogController {
  constructor(
    private readonly auditLog: AuditLogService,
    private readonly legalHolds: AuditLegalHoldService,
  ) {}

  @Get()
  list(
    @CurrentTenant() companyId: string,
    @Query() query: ListAuditLogQueryDto,
  ): Promise<AuditLogDto[]> {
    return this.auditLog.query(companyId, {
      entityType: query.entityType,
      action: query.action,
      actorUserId: query.actorUserId,
      workflowRunId: query.workflowRunId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
    });
  }

  /**
   * WAVE 4 §4.4 — tamper evidence.
   *
   * Deliberately callable by the tenant rather than only by an operator: the
   * company is the party that needs to be able to prove its own trail is
   * intact, and a verification only we can run is not evidence they can use.
   */
  @Get('verify')
  verify(@CurrentTenant() companyId: string): Promise<ChainVerification> {
    return this.auditLog.verify(companyId);
  }

  /**
   * WAVE 4 §4.1 — export as NDJSON, hashes included so the recipient can
   * verify the chain themselves.
   */
  @Get('export')
  @Header('content-type', 'application/x-ndjson; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="audit-log.ndjson"')
  export(
    @CurrentTenant() companyId: string,
    @Query() query: ListAuditLogQueryDto,
  ): Promise<string> {
    return this.auditLog.exportNdjson(companyId, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  // --- §4.5 legal hold ------------------------------------------------------

  @Get('legal-holds')
  listHolds(@CurrentTenant() companyId: string) {
    return this.legalHolds.list(companyId);
  }

  @Post('legal-holds')
  place(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLegalHoldDto,
  ) {
    return this.legalHolds.place(companyId, user.userId, dto.reason, dto.scope);
  }

  /**
   * Release a hold. The row is KEPT with `releasedAt` set, never deleted — the
   * fact that data was held, by whom and for how long, is itself evidence.
   */
  @Post('legal-holds/:id/release')
  release(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.legalHolds.release(companyId, user.userId, id);
  }
}
