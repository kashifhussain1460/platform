import { Body, Controller, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { SetCreditEnforcementDto } from './dto/set-credit-enforcement.dto';
import { PlatformAdminGuard, type AuthenticatedPlatformOperator } from './platform-admin.guard';

interface RequestWithOperator {
  platformOperator: AuthenticatedPlatformOperator;
}

/**
 * Credit system Phase 12, Task 12.1 (§36.1) — the operable surface for the
 * per-company enforcement canary allowlist (`Company.creditEnforcementEnabledAt`,
 * schema added in Task 8.3). `PlatformAdminGuard`-only: this is the
 * per-company half of the rollout — the OTHER half, the global
 * `CREDIT_ENFORCEMENT_ENABLED` flag, is a plain env var flip, not an HTTP
 * surface, by design (§36.1's "smallest addition" reasoning).
 */
@Controller('internal/platform-admin/companies/:companyId/credit-enforcement')
@UseGuards(PlatformAdminGuard)
export class EnforcementCohortController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Patch()
  async set(
    @Param('companyId') companyId: string,
    @Body() dto: SetCreditEnforcementDto,
    @Req() req: RequestWithOperator,
  ): Promise<{ companyId: string; creditEnforcementEnabledAt: string | null }> {
    const operator = req.platformOperator;

    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data: { creditEnforcementEnabledAt: dto.enabled ? new Date() : null },
      select: { id: true, creditEnforcementEnabledAt: true },
    });

    await this.auditLog.record({
      companyId,
      actorType: 'PLATFORM_OPERATOR',
      action: dto.enabled ? 'credits.enforcement_enrolled' : 'credits.enforcement_reverted',
      entityType: 'Company',
      entityId: companyId,
      metadata: { platformOperatorId: operator.id, platformOperatorEmail: operator.email },
    });

    return {
      companyId: updated.id,
      creditEnforcementEnabledAt: updated.creditEnforcementEnabledAt?.toISOString() ?? null,
    };
  }
}
