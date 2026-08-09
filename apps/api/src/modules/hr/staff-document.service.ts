import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { StaffDocument } from '@prisma/client';
import type {
  CreateStaffDocumentDto,
  StaffDocumentDto,
} from '@vaep/types';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { openPii, sealPii, STAFF_DOCUMENT_PII_FIELDS } from './hr-pii.util';
import { toStaffDocumentDto } from './hr.mapper';

/**
 * Staff documents (P3-01). The scan itself lives in object storage (storageKey);
 * only metadata is in Postgres. The identity-leaking `fileName` is sealed on
 * write and opened on read. Tenant-scoped by companyId throughout.
 */
@Injectable()
export class StaffDocumentService {
  private readonly logger = new Logger(StaffDocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toDto(row: StaffDocument): StaffDocumentDto {
    return toStaffDocumentDto(
      openPii(this.crypto, row, STAFF_DOCUMENT_PII_FIELDS),
    );
  }

  async list(companyId: string, staffId: string): Promise<StaffDocumentDto[]> {
    await this.assertStaffOwned(companyId, staffId);
    const rows = await this.prisma.staffDocument.findMany({
      where: { companyId, staffId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(
    companyId: string,
    dto: CreateStaffDocumentDto,
    actorUserId: string,
  ): Promise<StaffDocumentDto> {
    await this.assertStaffOwned(companyId, dto.staffId);
    const data = sealPii(
      this.crypto,
      {
        companyId,
        staffId: dto.staffId,
        docType: dto.docType,
        storageKey: dto.storageKey,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        aiConfidence: dto.aiConfidence ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
      STAFF_DOCUMENT_PII_FIELDS,
    );
    const row = await this.prisma.staffDocument.create({ data });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'staff_document.create',
      entityType: 'StaffDocument',
      entityId: row.id,
      metadata: { docType: dto.docType },
    });
    this.logger.log(
      `staff_document.create company=${companyId} staff=${dto.staffId} doc=${row.id}`,
    );
    return this.toDto(row);
  }

  async remove(
    companyId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    const existing = await this.prisma.staffDocument.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Staff document not found');
    }
    await this.prisma.staffDocument.delete({ where: { id } });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'staff_document.delete',
      entityType: 'StaffDocument',
      entityId: id,
    });
  }

  private async assertStaffOwned(
    companyId: string,
    staffId: string,
  ): Promise<void> {
    const staff = await this.prisma.staffMember.findFirst({
      where: { id: staffId, companyId },
      select: { id: true },
    });
    if (!staff) {
      throw new NotFoundException('Staff member not found');
    }
  }
}
