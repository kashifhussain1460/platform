import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { CreditLedgerService } from '../../credits/credit-ledger.service';
import { AdjustCreditsDto } from './dto/adjust-credits.dto';
import { PlatformAdminGuard, type AuthenticatedPlatformOperator } from './platform-admin.guard';

interface RequestWithOperator {
  platformOperator: AuthenticatedPlatformOperator;
}

/**
 * Credit system Phase 10, Task 10.2 (§31.5) — the single most protected
 * mutation in the system: a platform operator moving credits directly,
 * bypassing every reserve/settle/webhook path. `PlatformAdminGuard`-only.
 */
@Controller('internal/platform-admin/companies/:companyId/credits')
@UseGuards(PlatformAdminGuard)
export class PlatformAdminCreditsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Post('adjustments')
  async adjust(
    @Param('companyId') companyId: string,
    @Body() dto: AdjustCreditsDto,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() req: RequestWithOperator,
  ): Promise<{ ledgerEntryId: string; auditLogId: string | null }> {
    if (!idempotencyKeyHeader) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const idempotencyKey = `adjustment:${companyId}:${idempotencyKeyHeader}`;
    const operator = req.platformOperator;

    // Duplicate-key fast path (T1): a repeat submission is a pure no-op —
    // return the FIRST result, write nothing again (including no second
    // audit entry).
    const existingLedgerEntry = await this.prisma.creditLedger.findUnique({
      where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
    });
    if (existingLedgerEntry) {
      const existingAudit = await this.prisma.auditLog.findFirst({
        where: { companyId, entityType: 'CreditLedger', entityId: existingLedgerEntry.id },
      });
      return { ledgerEntryId: existingLedgerEntry.id, auditLogId: existingAudit?.id ?? null };
    }

    // No-self-adjustment (§31.5): reject regardless of amount if the calling
    // operator also happens to have a User row in the target company (the
    // operator identity itself has no company relation at all — this is the
    // only way a conflict of interest could exist).
    const selfUser = await this.prisma.user.findFirst({
      where: { companyId, email: operator.email },
      select: { id: true },
    });
    if (selfUser) {
      throw new ForbiddenException(
        'A platform operator cannot adjust credits for a company they are also a member of.',
      );
    }

    const entry = await this.ledger.append({
      companyId,
      transactionType: 'ADJUSTMENT',
      grantKind: 'MANUAL_ADMIN',
      amount: dto.amount,
      reason: dto.reason,
      source: 'ADMIN',
      idempotencyKey,
      metadata: { platformOperatorId: operator.id, platformOperatorEmail: operator.email },
    });

    // Known, accepted gap: two genuinely CONCURRENT identical-key submissions
    // both pass the fast-path check above (neither has committed yet), so
    // `append()`'s own per-company advisory lock + unique constraint still
    // guarantees exactly one ledger row (T2), but each caller independently
    // reaches this line and writes its own audit entry — a possible SECOND
    // audit row describing the same adjustment, never a second ledger effect
    // or a wrong amount. Not worth a bespoke lock around the audit write for
    // an observability-only duplicate.
    const auditLogId = await this.auditLog.record({
      companyId,
      actorType: 'PLATFORM_OPERATOR',
      action: 'credits.manual_adjustment',
      entityType: 'CreditLedger',
      entityId: entry.id,
      metadata: {
        platformOperatorId: operator.id,
        platformOperatorEmail: operator.email,
        amount: dto.amount,
        reason: dto.reason,
      },
    });

    return { ledgerEntryId: entry.id, auditLogId };
  }
}
