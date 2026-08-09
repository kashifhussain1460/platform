import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type StaffMember } from '@prisma/client';
import type {
  AttendanceRecordDto,
  CreateAttendanceRecordDto,
  CreateOnboardingTaskDto,
  CreateStaffMemberDto,
  OnboardingTaskDto,
  StaffMemberDto,
  UpdateStaffMemberDto,
} from '@vaep/types';
import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { openPii, sealPii, STAFF_MEMBER_PII_FIELDS } from './hr-pii.util';
import {
  toAttendanceRecordDto,
  toOnboardingTaskDto,
  toStaffMemberDto,
} from './hr.mapper';

/**
 * Staff roster (StaffMember) plus its operational satellites AttendanceRecord and
 * OnboardingTask (P3-01). Every query is scoped by companyId from the JWT so
 * tenants never touch each other's workforce. Personal PII (personalEmail, phone)
 * is sealed on write and opened on read via CryptoService.
 */
@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toDto(row: StaffMember): StaffMemberDto {
    return toStaffMemberDto(openPii(this.crypto, row, STAFF_MEMBER_PII_FIELDS));
  }

  // --- StaffMember ---------------------------------------------------------

  async list(companyId: string): Promise<StaffMemberDto[]> {
    const rows = await this.prisma.staffMember.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(companyId: string, id: string): Promise<StaffMemberDto> {
    return this.toDto(await this.findOwned(companyId, id));
  }

  async create(
    companyId: string,
    dto: CreateStaffMemberDto,
    actorUserId: string,
  ): Promise<StaffMemberDto> {
    const data = sealPii(
      this.crypto,
      {
        companyId,
        fullName: dto.fullName,
        employeeCode: dto.employeeCode ?? null,
        userId: dto.userId ?? null,
        workEmail: dto.workEmail ?? null,
        personalEmail: dto.personalEmail ?? null,
        phone: dto.phone ?? null,
        departmentId: dto.departmentId ?? null,
        managerStaffId: dto.managerStaffId ?? null,
        jobTitle: dto.jobTitle ?? null,
        employmentType: dto.employmentType ?? null,
        status: dto.status ?? 'ACTIVE',
        hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : null,
      },
      STAFF_MEMBER_PII_FIELDS,
    );
    let row: StaffMember;
    try {
      row = await this.prisma.staffMember.create({ data });
    } catch (err) {
      this.rethrowUnique(err);
    }
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'staff.create',
      entityType: 'StaffMember',
      entityId: row.id,
    });
    this.logger.log(`staff.create company=${companyId} staff=${row.id}`);
    return this.toDto(row);
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateStaffMemberDto,
    actorUserId: string,
  ): Promise<StaffMemberDto> {
    await this.findOwned(companyId, id);
    // undefined → leave unchanged; explicit null → clear. sealPii encrypts the
    // PII fields that are present as non-empty strings.
    const data = sealPii(
      this.crypto,
      {
        fullName: dto.fullName,
        employeeCode: dto.employeeCode,
        userId: dto.userId,
        workEmail: dto.workEmail,
        personalEmail: dto.personalEmail,
        phone: dto.phone,
        departmentId: dto.departmentId,
        managerStaffId: dto.managerStaffId,
        jobTitle: dto.jobTitle,
        employmentType: dto.employmentType,
        status: dto.status,
        hiredAt: dto.hiredAt === undefined ? undefined : dto.hiredAt ? new Date(dto.hiredAt) : null,
        exitedAt: dto.exitedAt === undefined ? undefined : dto.exitedAt ? new Date(dto.exitedAt) : null,
      } satisfies Prisma.StaffMemberUpdateInput as Prisma.StaffMemberUpdateInput,
      STAFF_MEMBER_PII_FIELDS,
    );
    let row: StaffMember;
    try {
      row = await this.prisma.staffMember.update({ where: { id }, data });
    } catch (err) {
      this.rethrowUnique(err);
    }
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'staff.update',
      entityType: 'StaffMember',
      entityId: id,
    });
    return this.toDto(row);
  }

  async remove(
    companyId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    await this.findOwned(companyId, id);
    // Cascade deletes the satellites (leave/docs/reviews/onboarding/attendance).
    await this.prisma.staffMember.delete({ where: { id } });
    await this.auditLog.record({
      companyId,
      actorUserId,
      action: 'staff.delete',
      entityType: 'StaffMember',
      entityId: id,
    });
    this.logger.log(`staff.delete company=${companyId} staff=${id}`);
  }

  // --- AttendanceRecord (satellite) ---------------------------------------

  async listAttendance(
    companyId: string,
    staffId: string,
  ): Promise<AttendanceRecordDto[]> {
    await this.findOwned(companyId, staffId);
    const rows = await this.prisma.attendanceRecord.findMany({
      where: { companyId, staffId },
      orderBy: { date: 'desc' },
    });
    return rows.map(toAttendanceRecordDto);
  }

  async recordAttendance(
    companyId: string,
    dto: CreateAttendanceRecordDto,
  ): Promise<AttendanceRecordDto> {
    await this.findOwned(companyId, dto.staffId);
    try {
      const row = await this.prisma.attendanceRecord.create({
        data: {
          companyId,
          staffId: dto.staffId,
          date: new Date(dto.date),
          status: dto.status,
          note: dto.note ?? null,
        },
      });
      return toAttendanceRecordDto(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'An attendance record already exists for this staff member on that date',
        );
      }
      throw err;
    }
  }

  // --- OnboardingTask (satellite) -----------------------------------------

  async listOnboarding(
    companyId: string,
    staffId: string,
  ): Promise<OnboardingTaskDto[]> {
    await this.findOwned(companyId, staffId);
    const rows = await this.prisma.onboardingTask.findMany({
      where: { companyId, staffId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toOnboardingTaskDto);
  }

  async createOnboardingTask(
    companyId: string,
    dto: CreateOnboardingTaskDto,
  ): Promise<OnboardingTaskDto> {
    await this.findOwned(companyId, dto.staffId);
    const row = await this.prisma.onboardingTask.create({
      data: {
        companyId,
        staffId: dto.staffId,
        title: dto.title,
        ownerType: dto.ownerType,
        ownerId: dto.ownerId ?? null,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        runId: dto.runId ?? null,
      },
    });
    return toOnboardingTaskDto(row);
  }

  async completeOnboardingTask(
    companyId: string,
    id: string,
  ): Promise<OnboardingTaskDto> {
    // Scope-checked update: only a row owned by this tenant is touched.
    const result = await this.prisma.onboardingTask.updateMany({
      where: { id, companyId, completedAt: null },
      data: { completedAt: new Date() },
    });
    if (result.count === 0) {
      // Either it does not exist / not ours, or it was already complete.
      const existing = await this.prisma.onboardingTask.findFirst({
        where: { id, companyId },
      });
      if (!existing) {
        throw new NotFoundException('Onboarding task not found');
      }
      return toOnboardingTaskDto(existing);
    }
    const row = await this.prisma.onboardingTask.findFirstOrThrow({
      where: { id, companyId },
    });
    return toOnboardingTaskDto(row);
  }

  // --- helpers -------------------------------------------------------------

  private async findOwned(
    companyId: string,
    id: string,
  ): Promise<StaffMember> {
    const row = await this.prisma.staffMember.findFirst({
      where: { id, companyId },
    });
    if (!row) {
      throw new NotFoundException('Staff member not found');
    }
    return row;
  }

  private rethrowUnique(err: unknown): never {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ConflictException(
        'A staff member with this employee code already exists',
      );
    }
    throw err;
  }
}
