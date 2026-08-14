import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { WORKFLOW_CATEGORIES, type WorkflowCategory } from '@vaep/types';
import type { CreateWorkflowDto as ICreateWorkflowDto } from '@vaep/types';
import { WorkflowDefinitionDto } from './workflow-definition.dto';

/** POST /workflows body. Mirrors the shared @vaep/types contract. */
export class CreateWorkflowDto implements ICreateWorkflowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowDefinitionDto)
  definition?: WorkflowDefinitionDto;

  /**
   * WAVE 2 §2.1 — the department axis department isolation scopes on.
   */
  @IsOptional()
  @IsIn(WORKFLOW_CATEGORIES as unknown as string[])
  category?: WorkflowCategory;
}
