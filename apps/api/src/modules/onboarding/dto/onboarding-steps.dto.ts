import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ONBOARDING_ROLES, type OnboardingRole } from '@vaep/types';

/** PATCH /onboarding/company — step 1. */
export class SaveCompanyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  industry!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  size!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  website?: string;
}

/** PATCH /onboarding/ai-employees — step 2. */
export class SaveAiEmployeesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(ONBOARDING_ROLES, { each: true })
  roles!: OnboardingRole[];
}

/** PATCH /onboarding/goals — step 3. */
export class SaveGoalsDto {
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  goals!: string[];
}

/**
 * PATCH /onboarding/departments — step 4.
 *
 * Names only. The wizard offers presets (`DEPARTMENT_PRESETS`) but a company
 * may type anything, so this accepts free text bounded by `Department.name`'s
 * own 120-char column limit. Blank and duplicate entries are dropped by
 * `normalizeDepartmentNames` rather than rejected — a trailing empty row in a
 * form is a UI artefact, not a client error worth a 400.
 *
 * `ArrayMaxSize(50)` is an abuse bound, not a product limit: no real company
 * onboards with fifty departments, and without it one request could create an
 * unbounded number of rows.
 */
export class SaveDepartmentsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  departments!: string[];
}
