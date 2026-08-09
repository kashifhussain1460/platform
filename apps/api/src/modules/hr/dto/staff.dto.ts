import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ATTENDANCE_STATUSES,
  EMPLOYMENT_TYPES,
  ONBOARDING_OWNER_TYPES,
  STAFF_STATUSES,
  type CreateAttendanceRecordDto as ICreateAttendanceRecordDto,
  type CreateOnboardingTaskDto as ICreateOnboardingTaskDto,
  type CreateStaffMemberDto as ICreateStaffMemberDto,
  type UpdateStaffMemberDto as IUpdateStaffMemberDto,
} from '@vaep/types';

/** POST /hr/staff body. */
export class CreateStaffMemberDto implements ICreateStaffMemberDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  employeeCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  workEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  personalEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerStaffId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  jobTitle?: string | null;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: string | null;

  @IsOptional()
  @IsIn(STAFF_STATUSES)
  status?: string;

  @IsOptional()
  @IsDateString()
  hiredAt?: string | null;
}

/** PATCH /hr/staff/:id body — every field optional; null clears a nullable field. */
export class UpdateStaffMemberDto implements IUpdateStaffMemberDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  employeeCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  workEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  personalEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerStaffId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  jobTitle?: string | null;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: string | null;

  @IsOptional()
  @IsIn(STAFF_STATUSES)
  status?: string;

  @IsOptional()
  @IsDateString()
  hiredAt?: string | null;

  @IsOptional()
  @IsDateString()
  exitedAt?: string | null;
}

/** POST /hr/staff/:staffId/attendance body. */
export class CreateAttendanceRecordDto implements ICreateAttendanceRecordDto {
  @IsString()
  staffId!: string;

  @IsDateString()
  date!: string;

  @IsIn(ATTENDANCE_STATUSES)
  status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

/** POST /hr/staff/:staffId/onboarding-tasks body. */
export class CreateOnboardingTaskDto implements ICreateOnboardingTaskDto {
  @IsString()
  staffId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsIn(ONBOARDING_OWNER_TYPES)
  ownerType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerId?: string | null;

  @IsOptional()
  @IsDateString()
  dueAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  runId?: string | null;
}
