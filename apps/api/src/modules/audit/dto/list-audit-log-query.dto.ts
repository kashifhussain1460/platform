import { IsISO8601, IsOptional, IsString } from 'class-validator';

/** GET /audit-log query params (WAVE 4 §4.1 — the query API). */
export class ListAuditLogQueryDto {
  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  actorUserId?: string;

  /** Everything audited for one workflow run — the incident-review query. */
  @IsOptional()
  @IsString()
  workflowRunId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}
