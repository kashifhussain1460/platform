import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  LEAVE_TYPES,
  type CreateLeaveRequestDto as ICreateLeaveRequestDto,
  type DecideLeaveRequestDto as IDecideLeaveRequestDto,
} from '@vaep/types';

/** Terminal decisions accepted by POST /hr/leave/:id/decide. */
const LEAVE_DECISIONS = ['APPROVED', 'REJECTED', 'CANCELLED'] as const;

/** POST /hr/leave body. */
export class CreateLeaveRequestDto implements ICreateLeaveRequestDto {
  @IsString()
  staffId!: string;

  @IsIn(LEAVE_TYPES)
  leaveType!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsNumber()
  @IsPositive()
  days!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string | null;
}

/** POST /hr/leave/:id/decide body. */
export class DecideLeaveRequestDto implements IDecideLeaveRequestDto {
  @IsIn(LEAVE_DECISIONS)
  status!: string;
}
