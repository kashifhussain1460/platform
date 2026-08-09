import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type {
  CreateWorkflowTemplateDto as ICreateWorkflowTemplateDto,
  TemplateParameter,
  WorkflowCategory,
  WorkflowDefinition,
  WorkflowTemplateRequires,
} from '@vaep/types';

const WORKFLOW_CATEGORIES = [
  'HR',
  'RECRUITMENT',
  'MARKETING',
  'SALES',
  'SUPPORT',
  'FINANCE',
  'OPERATIONS',
  'IT',
  'COMPLIANCE',
  'CUSTOM',
] as const;

/**
 * POST /workflow-templates body — author a tenant-owned template. Shallow
 * class-validator checks only; the manifest validator (doc 19 §10) in the service
 * is the real gate (rejects DB_QUERY / inline secrets / undeclared params).
 */
export class CreateWorkflowTemplateDto implements ICreateWorkflowTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  key!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsIn(WORKFLOW_CATEGORIES)
  category!: WorkflowCategory;

  @IsOptional()
  @IsArray()
  parameters?: TemplateParameter[];

  @IsOptional()
  @IsObject()
  requires?: Partial<WorkflowTemplateRequires>;

  @IsObject()
  definition!: WorkflowDefinition;
}
