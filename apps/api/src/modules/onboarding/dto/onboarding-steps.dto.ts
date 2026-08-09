import {
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
