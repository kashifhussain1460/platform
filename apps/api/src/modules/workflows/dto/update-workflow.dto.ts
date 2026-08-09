import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  EVENT_CONDITION_OPS,
  TRIGGER_TYPES,
  SETTABLE_WORKFLOW_STATUSES,
  type Condition,
  type EventConditionOp,
  type TriggerConfig,
  type TriggerType,
  type UpdateWorkflowDto as IUpdateWorkflowDto,
  type SettableWorkflowStatus,
} from '@vaep/types';
import { WorkflowDefinitionDto } from './workflow-definition.dto';

/**
 * One EVENT condition-DSL predicate. An unknown `op` fails `@IsIn` → 400 (the
 * ValidationPipe rejects the whole request). `value` is untyped (`@Allow` so the
 * whitelist pipe keeps it) since it may be a string/number/boolean/array.
 */
export class ConditionDto implements Condition {
  @IsString()
  @MaxLength(200)
  path!: string;

  @IsIn(EVENT_CONDITION_OPS)
  op!: EventConditionOp;

  @IsOptional()
  @Allow()
  value?: unknown;
}

/** SCHEDULE/EVENT trigger config (shape-per-type is validated in the service). */
export class TriggerConfigDto implements TriggerConfig {
  @IsOptional()
  @IsInt()
  @Min(15000)
  everyMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cron?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  eventType?: string;

  // EVENT condition DSL (docs §5.2). Optional list; unknown op → 400.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions?: ConditionDto[];

  /**
   * EVENT: restrict this trigger to ONE specific connector (InstalledSkill.id).
   * Absent → matches every connector of this eventType (unchanged back-compat).
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  connectorId?: string;
}

/** PATCH /workflows/:id body. Mirrors the shared @vaep/types contract. */
export class UpdateWorkflowDto implements IUpdateWorkflowDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowDefinitionDto)
  definition?: WorkflowDefinitionDto;

  @IsOptional()
  // ARCHIVED is intentionally not settable here — it is reachable only via
  // DELETE /workflows/:id, which enforces the 409-while-runs-active guard.
  @IsIn(SETTABLE_WORKFLOW_STATUSES)
  status?: SettableWorkflowStatus;

  @IsOptional()
  @IsIn(TRIGGER_TYPES)
  triggerType?: TriggerType;

  @IsOptional()
  @ValidateNested()
  @Type(() => TriggerConfigDto)
  triggerConfig?: TriggerConfigDto;

  /** Optional optimistic-concurrency guard — see the shared schema's docstring. */
  @IsOptional()
  @IsString()
  expectedUpdatedAt?: string;
}
