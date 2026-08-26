'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  WorkflowTemplateSummaryDto,
  WorkflowVersionDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import {
  activateWorkflow,
  cancelWorkflowRun,
  createWorkflow,
  deactivateWorkflow,
  deleteWorkflow,
  generateWorkflowDraft,
  getNodeDefinitions,
  getWorkflow,
  getWorkflowReadiness,
  getWorkflowRun,
  getWorkflowTemplate,
  installWorkflowTemplate,
  listAllRuns,
  listWorkflowRuns,
  listWorkflowTemplates,
  listWorkflowVersions,
  listWorkflows,
  publishWorkflow,
  retryWorkflowRun,
  runWorkflow,
  saveWorkflowDraft,
  updateWorkflow,
  type RunFilters,
} from './api';
import { isRunInFlight } from './lifecycle';

export const workflowKeys = {
  all: ['workflows'] as const,
  list: ['workflows', 'list'] as const,
  detail: (id: string) => ['workflows', 'detail', id] as const,
  runs: (id: string) => ['workflows', id, 'runs'] as const,
  allRuns: (filters: RunFilters) => ['workflows', 'all-runs', filters] as const,
  run: (runId: string) => ['workflows', 'run', runId] as const,
  readiness: (id: string) => ['workflows', id, 'readiness'] as const,
  nodeDefinitions: ['workflows', 'node-definitions'] as const,
  templates: (category?: WorkflowCategory) =>
    ['workflows', 'templates', category ?? null] as const,
  template: (id: string) => ['workflows', 'templates', id] as const,
  versions: (id: string) => ['workflows', id, 'versions'] as const,
};

// --- Templates -------------------------------------------------------------

/**
 * The installable template catalog (first-party + tenant). `category` is
 * optional (gap fix, 2026-08-20) — omitted, this fetches everything exactly
 * as before.
 */
export function useWorkflowTemplates(category?: WorkflowCategory) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowTemplateSummaryDto[], NormalizedApiError>({
    queryKey: workflowKeys.templates(category),
    queryFn: () => listWorkflowTemplates(category),
    enabled: Boolean(accessToken),
  });
}

/** One template's parameters + prerequisites (for the install form). */
export function useWorkflowTemplate(id: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowTemplateSummaryDto, NormalizedApiError>({
    queryKey: workflowKeys.template(id),
    queryFn: () => getWorkflowTemplate(id),
    enabled: Boolean(accessToken && id),
  });
}

/** Install a template → a DRAFT workflow; refresh the workflow list on success. */
export function useInstallWorkflowTemplate() {
  const qc = useQueryClient();
  return useMutation<
    WorkflowDto,
    NormalizedApiError,
    { id: string; body: InstallWorkflowTemplateDto; idempotencyKey: string }
  >({
    mutationFn: installWorkflowTemplate,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
    },
  });
}

// --- Node catalog ----------------------------------------------------------

/**
 * The node-definition catalog for the builder palette + inspector. Static within
 * a session (the registry is code-defined server-side), so cache it aggressively.
 */
export function useNodeDefinitions() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<NodeDefinitionDto[], NormalizedApiError>({
    queryKey: workflowKeys.nodeDefinitions,
    queryFn: getNodeDefinitions,
    enabled: Boolean(accessToken),
    staleTime: 60 * 60 * 1000,
  });
}

// --- Workflows -------------------------------------------------------------

export function useWorkflows() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowDto[], NormalizedApiError>({
    queryKey: workflowKeys.list,
    queryFn: listWorkflows,
    enabled: Boolean(accessToken),
  });
}

export function useWorkflow(id: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowDto, NormalizedApiError>({
    queryKey: workflowKeys.detail(id),
    queryFn: () => getWorkflow(id),
    enabled: Boolean(accessToken && id),
  });
}

interface WorkflowsContext {
  previous?: WorkflowDto[];
}

/** Create (optimistic): prepend a temp workflow, roll back on error. */
export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation<
    WorkflowDto,
    NormalizedApiError,
    CreateWorkflowDto,
    WorkflowsContext
  >({
    mutationFn: createWorkflow,
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: workflowKeys.list });
      const previous = qc.getQueryData<WorkflowDto[]>(workflowKeys.list);
      const now = new Date().toISOString();
      const optimistic: WorkflowDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        name: payload.name,
        description: payload.description ?? null,
        status: 'DRAFT',
        definition: payload.definition ?? { nodes: [], edges: [] },
        triggerType: 'MANUAL',
        triggerConfig: null,
        webhookToken: null,
        activatedAt: null,
        ownerUserId: null,
        activeVersionId: null,
        draftVersionId: null,
        category: null,
        warnings: [],
        createdAt: now,
        updatedAt: now,
      };
      qc.setQueryData<WorkflowDto[]>(workflowKeys.list, (old) => [
        optimistic,
        ...(old ?? []),
      ]);
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(workflowKeys.list, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
    },
  });
}

interface UpdateVars {
  id: string;
  data: UpdateWorkflowDto;
}

/**
 * Autosave the builder canvas. PATCHes the `definition` column — the same path
 * `GET /workflows/:id` and the Steps editor use, so canvas + steps stay in sync
 * and edits actually persist (the `/draft` version system isn't surfaced by GET
 * until the Phase 5 lifecycle work). `expectedUpdatedAt` is optimistic
 * concurrency: a stale value returns 409 → the conflict banner.
 *
 * Deliberately does NOT invalidate the detail cache — mid-edit the canvas is the
 * source of truth, and a refetch would reset selection/layout. On success it
 * only advances the list row's `updatedAt`.
 */
export function useAutosaveWorkflow(id: string) {
  const qc = useQueryClient();
  return useMutation<
    WorkflowDto,
    NormalizedApiError,
    { definition: WorkflowDefinition; expectedUpdatedAt?: string }
  >({
    mutationFn: ({ definition, expectedUpdatedAt }) =>
      updateWorkflow({ id, data: { definition, expectedUpdatedAt } }),
    onSuccess: (updated) => {
      qc.setQueryData<WorkflowDto[]>(workflowKeys.list, (old) =>
        old?.map((w) => (w.id === id ? { ...w, updatedAt: updated.updatedAt } : w)),
      );
    },
  });
}

/**
 * Publish the workflow. The canvas autosaves the definition *column*, so publish
 * snapshots the latest saved definition into a DRAFT version (`PUT /draft`) then
 * freezes it (`POST /publish`). A fresh read first guarantees we publish the
 * latest saved graph regardless of which view (canvas/steps) made the edit.
 * Idempotent server-side: an unchanged graph returns `unchanged:true`.
 */
export function usePublishWorkflow(id: string) {
  const qc = useQueryClient();
  return useMutation<
    PublishWorkflowResultDto,
    NormalizedApiError,
    { changeNote?: string }
  >({
    mutationFn: async ({ changeNote }) => {
      const fresh = await getWorkflow(id);
      await saveWorkflowDraft({ id, definition: fresh.definition });
      return publishWorkflow({ id, changeNote });
    },
    onSuccess: (result) => {
      // Reflect the new active version WITHOUT refetching the detail (a refetch
      // would reset the canvas): patch activeVersionId in place, refresh lists.
      qc.setQueryData<WorkflowDto>(workflowKeys.detail(id), (old) =>
        old
          ? { ...old, activeVersionId: result.version.id, draftVersionId: null }
          : old,
      );
      void qc.invalidateQueries({ queryKey: workflowKeys.versions(id) });
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
    },
  });
}

/**
 * Publish AND activate in one action (UX plan §14).
 *
 * Same sequence as `usePublishWorkflow` — fresh read, save the draft version,
 * publish — with `activate: true` so the server arms the trigger in the same
 * request. It is not a shortcut past any check: activation runs its own guards
 * server-side and only if publish succeeded.
 */
export function usePublishAndActivate(id: string) {
  const qc = useQueryClient();
  return useMutation<
    PublishWorkflowResultDto,
    NormalizedApiError,
    { changeNote?: string }
  >({
    mutationFn: async ({ changeNote }) => {
      const fresh = await getWorkflow(id);
      await saveWorkflowDraft({ id, definition: fresh.definition });
      return publishWorkflow({ id, changeNote, activate: true });
    },
    onSuccess: (result) => {
      // Patch in place rather than invalidating the detail: a refetch mid-edit
      // resets the canvas (see useAutosaveWorkflow's note).
      qc.setQueryData<WorkflowDto>(workflowKeys.detail(id), (old) =>
        old
          ? {
              ...old,
              activeVersionId: result.version.id,
              draftVersionId: null,
              status: result.workflow?.status ?? old.status,
              activatedAt: result.workflow?.activatedAt ?? old.activatedAt,
              webhookToken: result.workflow?.webhookToken ?? old.webhookToken,
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: workflowKeys.versions(id) });
      void qc.invalidateQueries({ queryKey: workflowKeys.readiness(id) });
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
    },
  });
}

/**
 * The publish preflight. Always refetched when the Review & Publish surface
 * opens (`staleTime: 0`): reporting a stale "ready" would let someone publish a
 * workflow whose Gmail connection expired a minute ago.
 */
export function useWorkflowReadiness(id: string, enabled = true) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowReadinessDto, NormalizedApiError>({
    queryKey: workflowKeys.readiness(id),
    queryFn: () => getWorkflowReadiness(id),
    enabled: Boolean(accessToken && id && enabled),
    staleTime: 0,
    gcTime: 0,
  });
}

/**
 * Every run in the company — the `/runs` operations table. Polls while any
 * listed run is still in flight, then stops, so an idle operations page costs
 * nothing.
 */
export function useAllRuns(filters: RunFilters = {}) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowRunDto[], NormalizedApiError>({
    queryKey: workflowKeys.allRuns(filters),
    queryFn: () => listAllRuns(filters),
    enabled: Boolean(accessToken),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => isRunInFlight(r.status)) ? 2000 : false,
  });
}

/** The workflow's version history (newest first). */
export function useWorkflowVersions(id: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowVersionDto[], NormalizedApiError>({
    queryKey: workflowKeys.versions(id),
    queryFn: () => listWorkflowVersions(id),
    enabled: Boolean(accessToken && id),
  });
}

/**
 * Restore a past version by making its definition the working draft — PATCHes the
 * definition column (no `expectedUpdatedAt`: an explicit overwrite, not a
 * concurrent-edit save) then invalidates the detail so the canvas reloads from
 * it. It does NOT publish; the restored graph is a draft to review and re-publish.
 */
export function useRestoreVersion(id: string) {
  const qc = useQueryClient();
  return useMutation<WorkflowDto, NormalizedApiError, { definition: WorkflowDefinition }>({
    mutationFn: ({ definition }) => updateWorkflow({ id, data: { definition } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: workflowKeys.versions(id) });
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
    },
  });
}

/** Update (optimistic status/name; definition persists on save). */
export function useUpdateWorkflow() {
  const qc = useQueryClient();
  return useMutation<
    WorkflowDto,
    NormalizedApiError,
    UpdateVars,
    WorkflowsContext
  >({
    mutationFn: updateWorkflow,
    onMutate: async ({ id, data }) => {
      await qc.cancelQueries({ queryKey: workflowKeys.list });
      const previous = qc.getQueryData<WorkflowDto[]>(workflowKeys.list);
      // Drop keys the caller left undefined before merging. A PATCH body means
      // "leave this alone", but spreading it would overwrite the cached value
      // with `undefined` — the row would flicker blank until the refetch landed.
      const patch = Object.fromEntries(
        Object.entries(data).filter(([, v]) => v !== undefined),
      ) as Partial<WorkflowDto>;
      qc.setQueryData<WorkflowDto[]>(workflowKeys.list, (old) =>
        (old ?? []).map((w) => (w.id === id ? { ...w, ...patch } : w)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(workflowKeys.list, context.previous);
      }
    },
    onSettled: (_data, _err, { id }) => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
      void qc.invalidateQueries({ queryKey: workflowKeys.detail(id) });
    },
  });
}

/**
 * Delete (optimistic): remove the row immediately, roll back on error.
 * `hard` erases for good (OWNER-only server-side); default is a soft archive —
 * either way the row leaves the list, so the optimistic removal is the same.
 */
export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation<
    void,
    NormalizedApiError,
    { id: string; hard?: boolean },
    WorkflowsContext
  >({
    mutationFn: ({ id, hard }) => deleteWorkflow(id, hard),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: workflowKeys.list });
      const previous = qc.getQueryData<WorkflowDto[]>(workflowKeys.list);
      qc.setQueryData<WorkflowDto[]>(workflowKeys.list, (old) =>
        (old ?? []).filter((w) => w.id !== id),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(workflowKeys.list, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
    },
  });
}

/**
 * Duplicate a workflow — there is no clone endpoint, so read the source graph
 * and create a fresh DRAFT copy (name + description + definition, per doc 29 §1).
 * The copy lands as a new row; it is never auto-activated.
 */
export function useDuplicateWorkflow() {
  const qc = useQueryClient();
  return useMutation<
    WorkflowDto,
    NormalizedApiError,
    { id: string; name: string }
  >({
    mutationFn: async ({ id, name }) => {
      const source = await getWorkflow(id);
      return createWorkflow({
        name,
        description: source.description ?? undefined,
        definition: source.definition,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
    },
  });
}

interface ActivateContext {
  previousList?: WorkflowDto[];
  previousDetail?: WorkflowDto;
}

/**
 * Activate/deactivate share one optimistic shape: flip the workflow's status in
 * both the list and detail caches, roll back on error, then invalidate so the
 * server truth (webhookToken/activatedAt) lands.
 */
function useSetActive(activate: boolean) {
  const qc = useQueryClient();
  const status: WorkflowDto['status'] = activate ? 'ACTIVE' : 'PAUSED';
  return useMutation<WorkflowDto, NormalizedApiError, string, ActivateContext>({
    mutationFn: (id) => (activate ? activateWorkflow(id) : deactivateWorkflow(id)),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: workflowKeys.list });
      await qc.cancelQueries({ queryKey: workflowKeys.detail(id) });
      const previousList = qc.getQueryData<WorkflowDto[]>(workflowKeys.list);
      const previousDetail = qc.getQueryData<WorkflowDto>(
        workflowKeys.detail(id),
      );
      qc.setQueryData<WorkflowDto[]>(workflowKeys.list, (old) =>
        (old ?? []).map((w) => (w.id === id ? { ...w, status } : w)),
      );
      qc.setQueryData<WorkflowDto>(workflowKeys.detail(id), (old) =>
        old ? { ...old, status } : old,
      );
      return { previousList, previousDetail };
    },
    onError: (_err, id, context) => {
      if (context?.previousList) {
        qc.setQueryData(workflowKeys.list, context.previousList);
      }
      if (context?.previousDetail) {
        qc.setQueryData(workflowKeys.detail(id), context.previousDetail);
      }
    },
    onSettled: (_data, _err, id) => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
      void qc.invalidateQueries({ queryKey: workflowKeys.detail(id) });
    },
  });
}

/** Activate a workflow (arms its trigger). Optimistic status → ACTIVE. */
export function useActivateWorkflow() {
  return useSetActive(true);
}

/** Deactivate a workflow. Optimistic status → PAUSED. */
export function useDeactivateWorkflow() {
  return useSetActive(false);
}

// --- Runs ------------------------------------------------------------------

export function useRunWorkflow(id: string) {
  const qc = useQueryClient();
  return useMutation<
    WorkflowRunDto,
    NormalizedApiError,
    { trigger?: Record<string, unknown>; dryRun?: boolean }
  >({
    mutationFn: ({ trigger, dryRun }) => runWorkflow({ id, trigger, dryRun }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.runs(id) });
    },
  });
}

/**
 * Run any workflow from the list (id in the variables, not fixed at hook
 * creation) so one instance serves every row. Invalidates that workflow's runs
 * so a subsequent Watch view is fresh.
 */
export function useRunFromList() {
  const qc = useQueryClient();
  return useMutation<
    WorkflowRunDto,
    NormalizedApiError,
    { id: string; trigger?: Record<string, unknown>; dryRun?: boolean }
  >({
    mutationFn: ({ id, trigger, dryRun }) => runWorkflow({ id, trigger, dryRun }),
    onSettled: (_data, _err, { id }) => {
      void qc.invalidateQueries({ queryKey: workflowKeys.runs(id) });
    },
  });
}

export function useWorkflowRuns(id: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowRunDto[], NormalizedApiError>({
    queryKey: workflowKeys.runs(id),
    queryFn: () => listWorkflowRuns(id),
    enabled: Boolean(accessToken && id),
  });
}

/** True while the run is still executing. */
function isActive(run: WorkflowRunDto | undefined): boolean {
  return run?.status === 'PENDING' || run?.status === 'RUNNING';
}

/**
 * A single run WITH its steps. Polls every 1s while PENDING/RUNNING so the run
 * log advances live, then stops (refetchInterval → false).
 */
export function useWorkflowRun(runId: string | null) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WorkflowRunDto, NormalizedApiError>({
    queryKey: workflowKeys.run(runId ?? ''),
    queryFn: () => getWorkflowRun(runId as string),
    enabled: Boolean(accessToken && runId),
    refetchInterval: (query) => (isActive(query.state.data) ? 1000 : false),
  });
}

/** Cancel a non-terminal run; refresh its polling query + the runs list. */
export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation<WorkflowRunDto, NormalizedApiError, string>({
    mutationFn: (runId) => cancelWorkflowRun(runId),
    onSuccess: (run) => {
      qc.setQueryData(workflowKeys.run(run.id), run);
      void qc.invalidateQueries({ queryKey: workflowKeys.runs(run.workflowId) });
    },
  });
}

/** Retry a run — starts a FRESH run of the same workflow (never resurrects the old one). */
export function useRetryRun() {
  const qc = useQueryClient();
  return useMutation<WorkflowRunDto, NormalizedApiError, string>({
    mutationFn: (runId) => retryWorkflowRun(runId),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: workflowKeys.runs(run.workflowId) });
    },
  });
}

/** AI-assisted draft generation — no cache to update; the chat holds its own state. */
export function useGenerateWorkflowDraft() {
  return useMutation<GenerateWorkflowResultDto, NormalizedApiError, GenerateWorkflowMessageDto[]>({
    mutationFn: generateWorkflowDraft,
  });
}
