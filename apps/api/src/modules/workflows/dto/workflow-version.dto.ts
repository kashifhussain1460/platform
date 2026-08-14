import { Type } from 'class-transformer';
import {
  IsBoolean,
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

  /**
   * Activate the workflow in the same request (UX plan §14 — the customer sees
   * one "Publish & Activate" action). Publish and activate remain two separate
   * server operations with their own guards and audit entries; this flag only
   * asks the controller to run the second one immediately after the first, and
   * only if the first succeeded.
   */
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}
