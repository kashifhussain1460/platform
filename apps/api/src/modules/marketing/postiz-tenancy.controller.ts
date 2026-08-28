import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import {
  PlatformAdminGuard,
  type AuthenticatedPlatformOperator,
} from '../billing/platform-admin/platform-admin.guard';
import { SetPostizCustomerGroupDto } from './dto/marketing.dto';

interface RequestWithOperator {
  platformOperator: AuthenticatedPlatformOperator;
}

/**
 * Assigns a company its Postiz `Customer`/group — the tenancy bridge for
 * social publishing (postiz-engine.md §20: one Orlixa-owned Postiz
 * organization, one Postiz Customer per Orlixa Company).
 *
 * ## Why this is platform-operator-only, and not a tenant setting
 *
 * Every Orlixa company shares ONE Postiz instance, so this id is the entire
 * boundary between one company's connected social accounts and another's. If a
 * tenant could type it, they could enter a competitor's group id and import
 * that competitor's Instagram and LinkedIn accounts — and then publish to
 * them. That is not a settings field; it is a tenant-isolation control, so it
 * sits behind `PlatformAdminGuard`, whose token is signed with a secret
 * distinct from the company JWT secret.
 *
 * Mirrors the existing `EnforcementCohortController` exactly, including the
 * audit record, rather than introducing a second operator surface.
 *
 * The remaining manual step is real and worth stating: Postiz's public API can
 * LIST customers/groups and FILTER integrations by them, but cannot TAG a
 * newly-connected integration to one (`PUT /:id/group` is internal-session
 * only — postiz-integration-plan.md Phase 3). So an operator still tags the
 * integration inside Postiz; this endpoint records which group is which
 * company, and `importAccounts` refuses to run until it has.
 */
@Controller('internal/platform-admin/companies/:companyId/postiz-group')
@UseGuards(PlatformAdminGuard)
export class PostizTenancyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  async get(
    @Param('companyId') companyId: string,
  ): Promise<{ companyId: string; postizCustomerGroupId: string | null }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, postizCustomerGroupId: true },
    });
    return {
      companyId,
      postizCustomerGroupId: company?.postizCustomerGroupId ?? null,
    };
  }

  @Patch()
  async set(
    @Param('companyId') companyId: string,
    @Body() dto: SetPostizCustomerGroupDto,
    @Req() req: RequestWithOperator,
  ): Promise<{ companyId: string; postizCustomerGroupId: string | null }> {
    const operator = req.platformOperator;
    const value = dto.postizCustomerGroupId?.trim() || null;

    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data: { postizCustomerGroupId: value },
      select: { id: true, postizCustomerGroupId: true },
    });

    await this.auditLog.record({
      companyId,
      actorType: 'PLATFORM_OPERATOR',
      action: value ? 'marketing.postiz_group_assigned' : 'marketing.postiz_group_cleared',
      entityType: 'Company',
      entityId: companyId,
      metadata: {
        platformOperatorId: operator.id,
        platformOperatorEmail: operator.email,
        postizCustomerGroupId: value,
      },
    });

    return {
      companyId: updated.id,
      postizCustomerGroupId: updated.postizCustomerGroupId,
    };
  }
}
