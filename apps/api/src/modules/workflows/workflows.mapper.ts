import type {
  Workflow,
  WorkflowRun,
  WorkflowStepRun,
} from '@prisma/client';
import type {
  TriggerConfig,
  TriggerType,
  WorkflowDefinition,
  WorkflowDto,
  WorkflowRunDto,
  WorkflowStepRunDto,
} from '@vaep/types';
import { reachableNodeIds } from './engine/definition-validator';

/** Prisma row → public DTO mappers for the workflows module. */

/** An empty definition, used as the fallback when a stored definition is null. */
export const EMPTY_DEFINITION: WorkflowDefinition = { nodes: [], edges: [] };

/**
 * Definition given to a freshly-created workflow: a single TRIGGER entry node so
 * a new workflow is never empty (the editor also assumes a TRIGGER always leads).
 * Users add real steps in the builder and Save; a trigger-only workflow runs to
 * COMPLETED as a harmless no-op instead of failing with "no nodes to run".
 */
export const STARTER_DEFINITION: WorkflowDefinition = {
  nodes: [{ id: 'trigger', type: 'TRIGGER', config: {} }],
  edges: [],
};

/**
 * Non-blocking structural warnings (docs/test-cases WF-D2): a node the trigger
 * cannot reach is dead code the run will never visit. Purely informational here
 * — a draft is allowed to contain one — but the same condition blocks publish,
 * activate and run (`UNREACHABLE_NODE` in the definition validator), so a
 * workflow can no longer go live with steps that silently never execute.
 *
 * Shares `reachableNodeIds` with the validator rather than re-deriving it: this
 * used to test "has an incoming edge", which called every PARALLEL lane start
 * unreachable even though the engine starts lanes from the node's config.
 */
export function computeWarnings(definition: WorkflowDefinition): string[] {
  const reachable = reachableNodeIds(definition);
  return definition.nodes
    .filter((n) => !reachable.has(n.id))
    .map(
      (n) =>
        `Step "${n.name || n.id}" (${n.type}) can't be reached from the trigger — it will never run.`,
    );
}

export function toWorkflowDto(w: Workflow): WorkflowDto {
  const definition =
    (w.definition as unknown as WorkflowDefinition | null) ?? EMPTY_DEFINITION;
  return {
    id: w.id,
    companyId: w.companyId,
    name: w.name,
    description: w.description,
    status: w.status,
    definition,
    triggerType: w.triggerType as TriggerType,
    triggerConfig: (w.triggerConfig as TriggerConfig | null) ?? null,
    webhookToken: w.webhookToken ?? null,
    activatedAt: w.activatedAt?.toISOString() ?? null,
    ownerUserId: w.ownerUserId ?? null,
    activeVersionId: w.activeVersionId ?? null,
    draftVersionId: w.draftVersionId ?? null,
    category: w.category ?? null,
    warnings: computeWarnings(definition),
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function toWorkflowStepRunDto(s: WorkflowStepRun): WorkflowStepRunDto {
  return {
    id: s.id,
    companyId: s.companyId,
    runId: s.runId,
    nodeId: s.nodeId,
    type: s.type,
    status: s.status,
    attempt: s.attempt,
    input: s.input ?? null,
    output: s.output ?? null,
    error: s.error,
    startedAt: s.startedAt?.toISOString() ?? null,
    finishedAt: s.finishedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toWorkflowRunDto(
  r: WorkflowRun & { steps?: WorkflowStepRun[] },
): WorkflowRunDto {
  return {
    id: r.id,
    companyId: r.companyId,
    workflowId: r.workflowId,
    status: r.status,
    source: r.source,
    dryRun: r.dryRun,
    trigger: (r.trigger as Record<string, unknown> | null) ?? null,
    context: (r.context as Record<string, unknown> | null) ?? null,
    triggerEventId: r.triggerEventId ?? null,
    correlationId: r.correlationId ?? null,
    error: r.error,
    failureClass: r.failureClass ?? null,
    resumeNodeId: r.resumeNodeId ?? null,
    startedByUserId: r.startedByUserId ?? null,
    workflowVersionId: r.workflowVersionId ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    steps: r.steps ? r.steps.map(toWorkflowStepRunDto) : undefined,
  };
}
