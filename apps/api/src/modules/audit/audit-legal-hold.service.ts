import { Injectable, NotFoundException } from '@nestjs/common';
import type { LegalHoldScope } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from './audit-log.service';

/**
 * WAVE 4 §4.5, widened in WAVE 8 §8.3 — legal holds.
 *
 * A hold suspends retention for a company. Placing and releasing one are both
 * audited, because "who stopped/started the clock on this evidence" is exactly
 * the kind of act a trail exists to record.
 *
 * The default scope is `ALL`. A hold that froze the audit trail but let the
 * nightly sweep delete the workflow runs, documents and conversations under
 * dispute would be a legal hold in name only.
 */
@Injectable()
export class AuditLegalHoldService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  list(companyId: string) {
    return this.prisma.legalHold.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async place(
    companyId: string,
    actorUserId: string,
    reason: string,
    scope: LegalHoldScope = 'ALL',
  ) {
    const hold = await this.prisma.legalHold.create({
      data: { companyId, placedById: actorUserId, reason, scope },
    });
    await this.audit.record({
      companyId,
      actorUserId,
      action: 'audit.legal_hold.placed',
      entityType: 'LegalHold',
      entityId: hold.id,
      metadata: { reason, scope },
    });
    return hold;
  }

  async release(companyId: string, actorUserId: string, id: string) {
    // Tenant-scoped and guarded on still-active, so a double release cannot
    // rewrite the original release time.
    const released = await this.prisma.legalHold.updateMany({
      where: { id, companyId, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    if (released.count === 0) {
      throw new NotFoundException('Legal hold not found or already released');
    }
    await this.audit.record({
      companyId,
      actorUserId,
      action: 'audit.legal_hold.released',
      entityType: 'LegalHold',
      entityId: id,
    });
    return this.prisma.legalHold.findFirst({ where: { id, companyId } });
  }
}
