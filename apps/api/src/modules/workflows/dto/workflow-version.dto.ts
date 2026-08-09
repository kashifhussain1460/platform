import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { WorkflowDefinitionDto } from './workflow-definition.dto';

/**
 * `PUT /workflows/:id/draft` body.
 *
 * `definition` is REQUIRED here, unlike on create/patch: saving a draft with no
 * graph is meaningless, and silently accepting it would leave the caller
 * thinking their edit was stored.
 */
export class SaveDraftDto {
  @ValidateNested()
  @Type(() => WorkflowDefinitionDto)
  definition!: WorkflowDefinitionDto;
}

/** `POST /workflows/:id/publish` body. */
export class PublishWorkflowDto {
  /** Optional free-text note recorded on the frozen version, for the history. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeNote?: string;
}
