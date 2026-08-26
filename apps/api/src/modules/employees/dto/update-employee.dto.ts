import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  EMPLOYEE_STATUSES,
  KNOWLEDGE_ACCESSES,
  type EmployeeStatus,
  type KnowledgeAccess,
  type KpiTargets,
  type UpdateEmployeeDto as IUpdateEmployeeDto,
} from '@vaep/types';

/** PATCH /employees/:id body. Mirrors the shared @vaep/types contract. */
export class UpdateEmployeeDto implements IUpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(EMPLOYEE_STATUSES)
  status?: EmployeeStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  persona?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  // --- Rich configuration (Step 5) -----------------------------------------

  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  managerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  workingHoursStart?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  workingHoursEnd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  language?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_ACCESSES)
  knowledgeAccess?: KnowledgeAccess;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  budgetLimit?: number | null;

  // Credit system §20 — validated identically to budgetLimit.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  maxCreditsPerExecution?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  maxCreditsPerTask?: number | null;

  @IsOptional()
  @IsObject()
  permissions?: Record<string, boolean>;

  @IsOptional()
  @IsObject()
  approvalRules?: Record<string, unknown>;

  // --- Goals + KPI targets (P1 #6) -----------------------------------------

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  goals?: string[];

  // @IsOptional() also skips validation for an explicit null (used to clear).
  @IsOptional()
  @IsObject()
  kpiTargets?: KpiTargets | null;
}
