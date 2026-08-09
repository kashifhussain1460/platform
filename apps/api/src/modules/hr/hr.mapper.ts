import type {
  AttendanceRecord,
  LeaveRequest,
  OnboardingTask,
  PerformanceReview,
  StaffDocument,
  StaffMember,
} from '@prisma/client';
import type {
  AttendanceRecordDto,
  LeaveRequestDto,
  OnboardingTaskDto,
  PerformanceReviewDto,
  StaffDocumentDto,
  StaffMemberDto,
} from '@vaep/types';

/**
 * Prisma row → public DTO mappers for the HR module (P3-01).
 *
 * These are pure: callers MUST decrypt PII (openPii) before mapping, so the DTOs
 * carry plaintext. Dates serialise to ISO strings (the DTO convention).
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toStaffMemberDto(s: StaffMember): StaffMemberDto {
  return {
    id: s.id,
    companyId: s.companyId,
    userId: s.userId,
    employeeCode: s.employeeCode,
    fullName: s.fullName,
    workEmail: s.workEmail,
    personalEmail: s.personalEmail,
    phone: s.phone,
    departmentId: s.departmentId,
    managerStaffId: s.managerStaffId,
    jobTitle: s.jobTitle,
    employmentType: s.employmentType,
    status: s.status,
    hiredAt: iso(s.hiredAt),
    exitedAt: iso(s.exitedAt),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function toLeaveRequestDto(l: LeaveRequest): LeaveRequestDto {
  return {
    id: l.id,
    companyId: l.companyId,
    staffId: l.staffId,
    leaveType: l.leaveType,
    startDate: l.startDate.toISOString(),
    endDate: l.endDate.toISOString(),
    days: l.days,
    reason: l.reason,
    status: l.status,
    approvalRequestId: l.approvalRequestId,
    decidedAt: iso(l.decidedAt),
    createdAt: l.createdAt.toISOString(),
  };
}

export function toStaffDocumentDto(d: StaffDocument): StaffDocumentDto {
  return {
    id: d.id,
    companyId: d.companyId,
    staffId: d.staffId,
    docType: d.docType,
    storageKey: d.storageKey,
    fileName: d.fileName,
    mimeType: d.mimeType,
    verifiedAt: iso(d.verifiedAt),
    verifiedByUserId: d.verifiedByUserId,
    aiConfidence: d.aiConfidence,
    expiresAt: iso(d.expiresAt),
    createdAt: d.createdAt.toISOString(),
  };
}

export function toPerformanceReviewDto(
  r: PerformanceReview,
): PerformanceReviewDto {
  return {
    id: r.id,
    companyId: r.companyId,
    staffId: r.staffId,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    reviewerUserId: r.reviewerUserId,
    aiDraft: r.aiDraft,
    finalReview: r.finalReview,
    rating: r.rating,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toOnboardingTaskDto(t: OnboardingTask): OnboardingTaskDto {
  return {
    id: t.id,
    companyId: t.companyId,
    staffId: t.staffId,
    title: t.title,
    ownerType: t.ownerType,
    ownerId: t.ownerId,
    dueAt: iso(t.dueAt),
    completedAt: iso(t.completedAt),
    runId: t.runId,
    createdAt: t.createdAt.toISOString(),
  };
}

export function toAttendanceRecordDto(a: AttendanceRecord): AttendanceRecordDto {
  return {
    id: a.id,
    companyId: a.companyId,
    staffId: a.staffId,
    date: a.date.toISOString(),
    status: a.status,
    note: a.note,
    createdAt: a.createdAt.toISOString(),
  };
}
