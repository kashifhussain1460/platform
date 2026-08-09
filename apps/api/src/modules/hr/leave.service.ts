import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { LeaveRequest } from '@prisma/client';
import type {
  CreateLeaveRequestDto,
  LeaveRequestDto,
} from '@vaep/types';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { LEAVE_REQUEST_PII_FIELDS, openPii, sealPii } from './hr-pii.util';
import { toLeaveRequestDto } from './hr.mapper';

/** Terminal decisions a PENDING leave request can transition to. */
const DECIDABLE_STATUSES = ['APPROVED', 'REJECTED', 'CANCELLED'] as const;

/**
 * Leave requests (P3-01). The free-text `reason` is special-category (health)
 * PII — sealed on write, opened on read via CryptoService. Tenant-scoped by
 * companyId throughout.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toDto(row: LeaveRequest): LeaveRequestDto {
    return toLeaveRequestDto(
      openPii(this.crypto, row, LEAVE_REQUEST_PII_FIELDS),
    );
  }

  async list(companyId: string, staffId?: string): Promise<LeaveRequestDto[]> {
    const rows = await this.prisma.leaveRequest.findMany({
      where: { companyId, ...(staffId ? { staffId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(
    companyId: string,
    dto: CreateLeaveRequestDto,
    actorUserId: string,
  ): Promise<LeaveRequestDto> {
    // The staff member must belong to this tenant (also prevents cross-tenant FKs).
    const staff = await this.prisma.staffMember.findFirst({
      where: { id: dto.staffId, companyId },
      select: { id: true },
    });
    if (!staff) {
      throw new NotFoundException('Staff member not found');
    }
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('startDate and endDate must be valid dates');
    }
    if (end < start) {
      throw new BadRequestException('endDate cannot be before startDate');
    }
    if (dto.days <= 0) {
      throw new BadRequestException('days must be greater than zero');
    }
    const data = sealPii(
      this.crypto,
      {
        companyId,
        staffId: dto.staffId,
        leaveType: dto.leaveType,
        startDate: start,
        endDate: end,
        days: dto.days,
        reason: dto.reason ?? null,
      },
      LEAVE_REQUEST_PII_FIELDS,
    );
    const row = await this.prisma.leaveRequest.create({ data });
    // doc 27 §HR-06: leave is a pay-affecting record → `full` audit (the request
    // creation, not only the decision). Reason is health data — audit the fact,
    // never the reason value.
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'leave.create',
      entityType: 'LeaveRequest',
      entityId: row.id,
      metadata: { staffId: dto.staffId, leaveType: dto.leaveType, days: dto.days },
    });
    this.logger.log(
      `leave.create company=${companyId} staff=${dto.staffId} leave=${row.id}`,
    );
    return this.toDto(row);
  }

  async decide(
    companyId: string,
    id: string,
    status: string,
    actorUserId: string,
  ): Promise<LeaveRequestDto> {
    if (!DECIDABLE_STATUSES.includes(status as (typeof DECIDABLE_STATUSES)[number])) {
      throw new BadRequestException(
        `status must be one of ${DECIDABLE_STATUSES.join(', ')}`,
      );
    }
    const existing = await this.prisma.leaveRequest.findFirst({
      where: { id, companyId },
    });
    if (!existing) {
      throw new NotFoundException('Leave request not found');
    }
    if (existing.status !== 'PENDING') {
      throw new BadRequestException(
        `Leave request is already ${existing.status} and cannot be changed`,
      );
    }
    const row = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, decidedAt: new Date() },
    });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'leave.decide',
      entityType: 'LeaveRequest',
      entityId: id,
      metadata: { status },
    });
    this.logger.log(`leave.decide company=${companyId} leave=${id} → ${status}`);
    return this.toDto(row);
  }
}
