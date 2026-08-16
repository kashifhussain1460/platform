/**
 * POC ONLY — NOT PRODUCTION.
 *
 * The Orlixa side of the boundary. The Workflow SDK never talks to a provider
 * directly: it calls a step, the step calls THIS, and this enforces
 * authorization before it reaches the provider adapter.
 *
 * The signature deliberately takes an `idempotencyKey` from the caller rather
 * than minting one, because in Orlixa that key is derived from run/step/attempt
 * identity — which the SDK owns. That is the exact seam the report has to be
 * explicit about.
 */
import { assertAuthorized } from './authorization';
import { callExternalApi, type ProviderResult } from './mock-external-api';
import { record } from './recorder';

export interface SkillExecutionInput {
  companyId: string;
  employeeId: string;
  runId: string;
  nodeId: string;
  skillTool: string;
  args: Record<string, unknown>;
  /** Supplied by the durable runtime. In Orlixa today: sha256(runId:nodeId:attempt). */
  idempotencyKey: string;
  /** Opaque id of this execution attempt, for the audit trail. */
  executionId: string;
}

export interface SkillExecutionResult extends ProviderResult {
  skillTool: string;
  ok: true;
}

export function executeSkill(input: SkillExecutionInput): SkillExecutionResult {
  record('skill.execution.started', {
    runId: input.runId,
    nodeId: input.nodeId,
    skillTool: input.skillTool,
    executionId: input.executionId,
    idempotencyKey: input.idempotencyKey,
  });

  // 1) Orlixa authorization — BEFORE anything leaves the process.
  assertAuthorized({
    companyId: input.companyId,
    employeeId: input.employeeId,
    skillTool: input.skillTool,
  });

  // 2) Provider adapter.
  const result = callExternalApi({
    executionId: input.executionId,
    idempotencyKey: input.idempotencyKey,
    payload: { skillTool: input.skillTool, args: input.args, runId: input.runId },
  });

  record('skill.execution.finished', {
    runId: input.runId,
    nodeId: input.nodeId,
    executionId: input.executionId,
    resourceId: result.resourceId,
    deduplicated: result.deduplicated,
  });

  return { ...result, skillTool: input.skillTool, ok: true };
}
