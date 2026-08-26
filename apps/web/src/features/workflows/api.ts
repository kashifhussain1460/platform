import { apiClient } from '@/lib/apiClient';
import type {
  CreateWorkflowDto,
  GenerateWorkflowMessageDto,
  GenerateWorkflowResultDto,
  InstallWorkflowTemplateDto,
  NodeDefinitionDto,
  PublishWorkflowResultDto,
  UpdateWorkflowDto,
  WorkflowCategory,
  WorkflowDefinition,
  WorkflowDto,
  WorkflowReadinessDto,
  WorkflowRunDto,
  WorkflowRunStatus,
  WorkflowTemplateSummaryDto,
  WorkflowVersionDto,
} from '@vaep/types';

// --- Workflow templates (P3-02 install) ------------------------------------

/**
 * The installable first-party + tenant template catalog. `category` is
 * optional (gap fix) — omitted, this is byte-identical to the old
 * unfiltered call.
 */
export async function listWorkflowTemplates(
  category?: WorkflowCategory,
): Promise<WorkflowTemplateSummaryDto[]> {
  const { data } = await apiClient.get<WorkflowTemplateSummaryDto[]>(
    '/workflow-templates',
    { params: category ? { category } : undefined },
  );
  return data;
}

/** One template's declared parameters + prerequisites (for the install form). */
export async function getWorkflowTemplate(
  id: string,
): Promise<WorkflowTemplateSummaryDto> {
  const { data } = await apiClient.get<WorkflowTemplateSummaryDto>(
    `/workflow-templates/${id}/parameters`,
  );
  return data;
}

/**
 * Install a template into a DRAFT workflow. An Idempotency-Key makes a double
 * submit safe (the server returns the same workflow instead of a duplicate).
 */
export async function installWorkflowTemplate(vars: {
  id: string;
  body: InstallWorkflowTemplateDto;
  idempotencyKey: string;
}): Promise<WorkflowDto> {
  const { data } = await apiClient.post<WorkflowDto>(
    `/workflow-templates/${vars.id}/install`,
    vars.body,
    { headers: { 'Idempotency-Key': vars.idempotencyKey } },
  );
  return data;
}

// --- Node metadata catalog (for the builder palette + inspector) -----------

/** The full node-definition catalog (category, handles, config schema, flags). */
export async function getNodeDefinitions(): Promise<NodeDefinitionDto[]> {
  const { data } = await apiClient.get<NodeDefinitionDto[]>(
    '/workflows/node-definitions',
  );
  return data;
}

// --- Workflow CRUD ---------------------------------------------------------

export async function listWorkflows(): Promise<WorkflowDto[]> {
  const { data } = await apiClient.get<WorkflowDto[]>('/workflows');
  return data;
}

export async function getWorkflow(id: string): Promise<WorkflowDto> {
  const { data } = await apiClient.get<WorkflowDto>(`/workflows/${id}`);
  return data;
}

export async function createWorkflow(
  payload: CreateWorkflowDto,
): Promise<WorkflowDto> {
  const { data } = await apiClient.post<WorkflowDto>('/workflows', payload);
  return data;
}

export async function updateWorkflow(vars: {
  id: string;
  data: UpdateWorkflowDto;
}): Promise<WorkflowDto> {
  const { data } = await apiClient.patch<WorkflowDto>(
    `/workflows/${vars.id}`,
    vars.data,
  );
  return data;
}

/**
 * Delete a workflow. Default is a soft archive (status → ARCHIVED, run history
 * kept). `hard` performs a genuine cascading erasure and is OWNER-only server-side
 * (a non-owner gets 403); the run history goes with it.
 */
export async function deleteWorkflow(id: string, hard = false): Promise<void> {
  await apiClient.delete(`/workflows/${id}${hard ? '?hard=true' : ''}`);
}

export async function activateWorkflow(id: string): Promise<WorkflowDto> {
  const { data } = await apiClient.post<WorkflowDto>(
    `/workflows/${id}/activate`,
  );
  return data;
}

export async function deactivateWorkflow(id: string): Promise<WorkflowDto> {
  const { data } = await apiClient.post<WorkflowDto>(
    `/workflows/${id}/deactivate`,
  );
  return data;
}

// --- Lifecycle: draft / publish / versions ---------------------------------

/** Save the editable draft graph as the workflow's DRAFT version. */
export async function saveWorkflowDraft(vars: {
  id: string;
  definition: WorkflowDefinition;
}): Promise<WorkflowVersionDto> {
  const { data } = await apiClient.put<WorkflowVersionDto>(
    `/workflows/${vars.id}/draft`,
    { definition: vars.definition },
  );
  return data;
}

/**
 * Freeze the draft as a PUBLISHED version and make it the active one.
 *
 * `activate: true` also arms the trigger in the same request — the single
 * "Publish & Activate" action of the simplified UX. The server still runs both
 * operations with their own guards and audit entries; a validation failure
 * throws before anything is activated.
 */
export async function publishWorkflow(vars: {
  id: string;
  changeNote?: string;
  activate?: boolean;
}): Promise<PublishWorkflowResultDto> {
  const { data } = await apiClient.post<PublishWorkflowResultDto>(
    `/workflows/${vars.id}/publish`,
    { changeNote: vars.changeNote, activate: vars.activate },
  );
  return data;
}

/**
 * The publish preflight: every check publish + activate would run, without
 * changing anything. Backs the Review & Publish surface, which is why there is
 * no separate "Validate" button in the builder.
 */
export async function getWorkflowReadiness(
  id: string,
): Promise<WorkflowReadinessDto> {
  const { data } = await apiClient.get<WorkflowReadinessDto>(
    `/workflows/${id}/readiness`,
  );
  return data;
}

/** The workflow's version history (newest first). */
export async function listWorkflowVersions(id: string): Promise<WorkflowVersionDto[]> {
  const { data } = await apiClient.get<WorkflowVersionDto[]>(
    `/workflows/${id}/versions`,
  );
  return data;
}

// --- Runs ------------------------------------------------------------------

export async function runWorkflow(vars: {
  id: string;
  trigger?: Record<string, unknown>;
  dryRun?: boolean;
}): Promise<WorkflowRunDto> {
  const { data } = await apiClient.post<WorkflowRunDto>(
    `/workflows/${vars.id}/run`,
    { trigger: vars.trigger, dryRun: vars.dryRun },
  );
  return data;
}

export async function listWorkflowRuns(id: string): Promise<WorkflowRunDto[]> {
  const { data } = await apiClient.get<WorkflowRunDto[]>(
    `/workflows/${id}/runs`,
  );
  return data;
}

/** Filters for the cross-workflow operations list. */
export interface RunFilters {
  status?: WorkflowRunStatus;
  workflowId?: string;
  limit?: number;
}

/**
 * Every run in the company, newest first — the `/runs` operations surface. Each
 * row carries `workflowName`, so the table needs no per-row lookup.
 */
export async function listAllRuns(
  filters: RunFilters = {},
): Promise<WorkflowRunDto[]> {
  const { data } = await apiClient.get<WorkflowRunDto[]>('/workflows/runs', {
    params: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.workflowId ? { workflowId: filters.workflowId } : {}),
      ...(filters.limit ? { limit: filters.limit } : {}),
    },
  });
  return data;
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunDto> {
  const { data } = await apiClient.get<WorkflowRunDto>(
    `/workflows/runs/${runId}`,
  );
  return data;
}

/** Cancel a non-terminal run (privileged + audited). */
export async function cancelWorkflowRun(runId: string): Promise<WorkflowRunDto> {
  const { data } = await apiClient.post<WorkflowRunDto>(
    `/workflows/runs/${runId}/cancel`,
  );
  return data;
}

/** Retry a run by starting a fresh run of the same workflow. */
export async function retryWorkflowRun(runId: string): Promise<WorkflowRunDto> {
  const { data } = await apiClient.post<WorkflowRunDto>(
    `/workflows/runs/${runId}/retry`,
  );
  return data;
}

// --- AI generation -----------------------------------------------------------

export async function generateWorkflowDraft(
  messages: GenerateWorkflowMessageDto[],
): Promise<GenerateWorkflowResultDto> {
  const { data } = await apiClient.post<GenerateWorkflowResultDto>(
    '/workflows/generate',
    { messages },
  );
  return data;
}
