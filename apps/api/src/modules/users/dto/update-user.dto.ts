import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ROLES,
  USER_STATUSES,
  type Role,
  type UpdateUserDto as IUpdateUserDto,
  type UserStatus,
} from '@vaep/types';

/** PATCH /users/:id body. Mirrors the shared @vaep/types contract. */
export class UpdateUserDto implements IUpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(ROLES)
  role?: Role;

  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;

  /** WAVE 2 — place the user in a department (null clears it). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  departmentId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  teamId?: string | null;
}
