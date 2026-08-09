import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PerformanceReview } from '@prisma/client';
import type {
  CreatePerformanceReviewDto,
  PerformanceReviewDto,
  UpdatePerformanceReviewDto,
} from '@vaep/types';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { openPii, PERFORMANCE_REVIEW_PII_FIELDS, sealPii } from './hr-pii.util';
import { toPerformanceReviewDto } from './hr.mapper';

/**
 * Performance reviews (P3-01). The AI draft and the final review text are both
 * sensitive free-text — sealed on write, opened on read. Tenant-scoped by
 * companyId throughout.
 */
@Injectable()
export class PerformanceReviewService {
  private readonly logger = new Logger(PerformanceReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toDto(row: PerformanceReview): PerformanceReviewDto {
    return toPerformanceReviewDto(
      openPii(this.crypto, row, PERFORMANCE_REVIEW_PII_FIELDS),
    );
  }

  async list(companyId: string, staffId?: string): Promise<PerformanceReviewDto[]> {
    const rows = await this.prisma.performanceReview.findMany({
      where: { companyId, ...(staffId ? { staffId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(
    companyId: string,
    dto: CreatePerformanceReviewDto,
    actorUserId: string,
  ): Promise<PerformanceReviewDto> {
    const staff = await this.prisma.staffMember.findFirst({
      where: { id: dto.staffId, companyId },
      select: { id: true },
    });
    if (!staff) {
      throw new NotFoundException('Staff member not found');
    }
    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);
    if (
      Number.isNaN(periodStart.getTime()) ||
      Number.isNaN(periodEnd.getTime())
    ) {
      throw new BadRequestException('periodStart and periodEnd must be valid dates');
    }
    if (periodEnd < periodStart) {
      throw new BadRequestException('periodEnd cannot be before periodStart');
    }
    const data = sealPii(
      this.crypto,
      {
        companyId,
        staffId: dto.staffId,
        periodStart,
        periodEnd,
        reviewerUserId: dto.reviewerUserId ?? null,
        aiDraft: dto.aiDraft ?? null,
        finalReview: dto.finalReview ?? null,
        rating: dto.rating ?? null,
        status: dto.status ?? 'DRAFT',
      },
      PERFORMANCE_REVIEW_PII_FIELDS,
    );
    const row = await this.prisma.performanceReview.create({ data });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'performance_review.create',
      entityType: 'PerformanceReview',
      entityId: row.id,
    });
    this.logger.log(
      `performance_review.create company=${companyId} staff=${dto.staffId} review=${row.id}`,
    );
    return this.toDto(row);
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdatePerformanceReviewDto,
    actorUserId: string,
  ): Promise<PerformanceReviewDto> {
    const existing = await this.prisma.performanceReview.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Performance review not found');
    }
    const data = sealPii(
      this.crypto,
      {
        aiDraft: dto.aiDraft,
        finalReview: dto.finalReview,
        rating: dto.rating,
        status: dto.status,
      },
      PERFORMANCE_REVIEW_PII_FIELDS,
    );
    const row = await this.prisma.performanceReview.update({
      where: { id },
      data,
    });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'performance_review.update',
      entityType: 'PerformanceReview',
      entityId: id,
    });
    return this.toDto(row);
  }
}
