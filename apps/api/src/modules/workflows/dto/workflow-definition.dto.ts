import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  NODE_TYPES,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@vaep/types';

/** Canvas world-space position (Workflow Builder). Additive + optional. */
export class WorkflowNodePositionDto {
  @IsNumber()
  x!: number;

  @IsNumber()
  y!: number;
}

/** One node in a workflow graph. `config` is validated loosely (shape per type). */
export class WorkflowNodeDto implements WorkflowNode {
  @IsString()
  @MinLength(1)
  id!: string;

  @IsIn(NODE_TYPES)
  type!: NodeType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsObject()
  config!: Record<string, unknown>;

  // Must be a declared, validated field or the global `whitelist: true` pipe
  // strips it before Save — so a manual canvas layout would never persist.
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowNodePositionDto)
  position?: { x: number; y: number };

  // Same `whitelist: true` reasoning as `position`: undeclared fields are
  // silently stripped, so a "Deactivate" would never persist without this.
  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

/** A directed edge; `branch` selects a CONDITION outcome or a SWITCH case. */
export class WorkflowEdgeDto implements WorkflowEdge {
  @IsString()
  @MinLength(1)
  from!: string;

  @IsString()
  @MinLength(1)
  to!: string;

  // Widened from @IsIn(['true','false']) in P2: SWITCH routes on author-named
  // branches. Length-bounded rather than enumerated, since the valid set is
  // per-node config and is checked by the definition validator (MISSING_BRANCH_EDGE).
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  branch?: string;
}

/** The full graph ({nodes, edges}) persisted on a workflow. */
export class WorkflowDefinitionDto implements WorkflowDefinition {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowNodeDto)
  nodes!: WorkflowNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowEdgeDto)
  edges!: WorkflowEdgeDto[];
}
