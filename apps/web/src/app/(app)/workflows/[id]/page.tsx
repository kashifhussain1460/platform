'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { WorkflowDto } from '@vaep/types';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { BuilderLifecycleBar } from '@/features/workflows/components/builder/BuilderLifecycleBar';
import type { AutosaveState } from '@/features/workflows/components/builder/AutosaveStatus';
import { RunBar } from '@/features/workflows/components/builder/RunBar';
import { RunControls } from '@/features/workflows/components/builder/RunControls';
import { WorkflowOverview } from '@/features/workflows/components/builder/WorkflowOverview';
import { WorkflowCanvas } from '@/features/workflows/components/builder/canvas/WorkflowCanvas';
import { NodeList } from '@/features/workflows/components/NodeList';
import { PastRunsPanel } from '@/features/workflows/components/PastRunsPanel';
import { RunPanel } from '@/features/workflows/components/RunPanel';
import { TriggerPanel } from '@/features/workflows/components/TriggerPanel';
import {
  useDeactivateWorkflow,
  useRunWorkflow,
  useWorkflow,
  useWorkflowRun,
  useWorkflowRuns,
} from '@/features/workflows/hooks';
import { useCurrentCompany } from '@/features/tenant/hooks';
import { simplifiedWorkflowUX } from '@/lib/featureFlags';
import { useSessionStore } from '@/stores/session.store';

export default function WorkflowEditorPage({
  params,
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const role = useSessionStore((s) => s.user?.role);
  const shellProps = useAppShellProps();
  const workflowId = params.id;
  const { data: workflow, isLoading } = useWorkflow(workflowId);
  const searchParams = useSearchParams();
  const unresolvedIds = (searchParams.get('unresolved') ?? '').split(',').filter(Boolean);
  const [dismissed, setDismissed] = useState(false);
  const [view, setView] = useState<'canvas' | 'steps'>('canvas');

  // The canvas autosaves the graph without refetching the workflow — a refetch
  // mid-edit would discard unsaved edits. That means the cached `workflow` is
  // the state at page LOAD, which is the wrong thing for Run/Activate to gate
  // on: you could draw a workflow, publish it, and still find both greyed out
  // until you reloaded. The canvas hands up the server's response to each save
  // instead. Found by driving the builder in a browser (WAVE 7).
  const [savedWorkflow, setSavedWorkflow] = useState<WorkflowDto | null>(null);
  const live = savedWorkflow ?? workflow;
  const liveDefinition = live?.definition;
  const hasRunnableStep = (liveDefinition?.nodes ?? []).some(
    (n) => n.type !== 'TRIGGER',
  );
  // Server-computed: steps the trigger can't reach, which would never run.
  const warnings = live?.warnings ?? [];

  // Live autosave state, lifted out of the canvas so the lifecycle bar can show
  // ONE truthful indicator instead of a relative time that goes stale (§11).
  const [saveState, setSaveState] = useState<AutosaveState>('idle');
  // The retry callback is held in a ref, not state: storing it in state made
  // every canvas render a parent state update, and the resulting render loop
  // tripped React's "Maximum update depth exceeded". The state update below is
  // also guarded so an unchanged status is a no-op re-render.
  const retryRef = useRef<() => void>(() => {});
  const handleSaveState = useCallback((state: AutosaveState, retry: () => void) => {
    retryRef.current = retry;
    setSaveState((prev) => (prev === state ? prev : state));
  }, []);

  // A blocking issue in Review & Publish can point at the step that caused it.
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);

  // Watch mode: `?run=<id>` overlays that run's live status on the canvas.
  const runId = searchParams.get('run');
  const watching = Boolean(runId);
  const runQuery = useWorkflowRun(runId);

  // Overview vs builder (§36). An ACTIVE workflow rests on its overview; `?edit=1`
  // opens the canvas. A DRAFT goes straight to the canvas — there is nothing to
  // report on yet.
  const editing = searchParams.get('edit') === '1';
  const showOverview =
    simplifiedWorkflowUX && !watching && !editing && workflow?.status === 'ACTIVE';

  const runs = useWorkflowRuns(workflowId);
  const { data: company } = useCurrentCompany();
  const runNow = useRunWorkflow(workflowId);
  const deactivate = useDeactivateWorkflow();

  // Client-side route guard.
  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  const canManage = role === 'OWNER' || role === 'ADMIN';

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 flex items-center justify-between gap-4 pt-2">
        <div>
          <p className="text-sm text-app-ink-3">Workflow</p>
          <h1 className="text-2xl font-bold text-app-ink">
            {workflow?.name ?? 'Loading…'}
          </h1>
        </div>
        <Link
          href="/workflows"
          className="text-sm font-medium text-app-ink-2 transition-colors hover:text-app-ink"
        >
          ← Workflows
        </Link>
      </div>

      {!dismissed && unresolvedIds.length > 0 && workflow && (
        <div className="mb-6 flex items-start justify-between gap-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-700">
            AI couldn&apos;t confidently fill in{' '}
            {unresolvedIds
              .map((id) => workflow.definition.nodes.find((n) => n.id === id)?.name ?? id)
              .join(', ')}
            . Open that step in the Steps view and choose a tool before activating.
          </p>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 text-sm text-amber-700 hover:text-amber-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {isLoading || !workflow ? (
        <p className="text-sm text-app-ink-3">Loading workflow…</p>
      ) : showOverview ? (
        <WorkflowOverview
          workflow={workflow}
          runs={runs.data}
          canManage={canManage}
          timeZone={company?.timezone ?? undefined}
          onEdit={() => router.push(`/workflows/${workflowId}?edit=1`)}
          onRunNow={() =>
            runNow.mutate(
              {},
              {
                onSuccess: (run) => router.push(`/runs/${run.id}`),
              },
            )
          }
          runPending={runNow.isPending}
          onPause={() => deactivate.mutate(workflowId)}
          pausePending={deactivate.isPending}
        />
      ) : (
        <>
          <div className="mb-4">
            <BuilderLifecycleBar
              workflow={workflow}
              canManage={canManage}
              canActivate={hasRunnableStep}
              saveState={saveState}
              onRetrySave={() => retryRef.current()}
              onFocusNode={(nodeId) => {
                setView('canvas');
                setFocusNodeId(nodeId);
              }}
              onOpenTrigger={() => {
                setView('canvas');
                setFocusNodeId(
                  (liveDefinition?.nodes ?? []).find((n) => n.type === 'TRIGGER')?.id ??
                    null,
                );
              }}
            />
          </div>

          {/* Unreachable steps, in the view where workflows are actually built.
              The server has always returned these on the DTO, but only the
              Steps list rendered them — and Canvas is the default view. So a
              graph could be published and run with its approval gate wired to
              nothing, reporting COMPLETED, with the warning sitting unread one
              tab away. Found in a browser (WAVE 7). */}
          {!watching && warnings.length > 0 && (
            <div
              className="mb-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3"
              role="status"
            >
              <p className="text-sm font-medium text-amber-700">
                {warnings.length === 1
                  ? 'One step isn’t connected yet'
                  : `${warnings.length} steps aren’t connected yet`}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-amber-700/90">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-amber-700/70">
                Drag a connection from the previous step. Until then this
                workflow can’t be published or run.
              </p>
            </div>
          )}

          <div className="mb-4">
            {watching ? (
              <RunBar
                run={runQuery.data}
                isLoading={runQuery.isLoading}
                nodeCount={(liveDefinition?.nodes ?? []).length}
                onClose={() => router.push(`/workflows/${workflowId}`)}
                onWatchRun={(rid) => router.push(`/workflows/${workflowId}?run=${rid}`)}
              />
            ) : (
              <RunControls
                workflowId={workflowId}
                canRun={hasRunnableStep}
                onWatchRun={(rid) => router.push(`/workflows/${workflowId}?run=${rid}`)}
              />
            )}
          </div>

          {!watching && (
            <div
              className="mb-5 inline-flex rounded-lg border border-app-border p-0.5"
              role="tablist"
              aria-label="Workflow view"
            >
            {(['canvas', 'steps'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                  view === v ? 'bg-violet text-white' : 'text-app-ink-2 hover:text-app-ink'
                }`}
              >
                {v === 'canvas' ? 'Canvas' : 'Steps'}
              </button>
            ))}
          </div>

          )}

          {watching || view === 'canvas' ? (
            <WorkflowCanvas
              workflow={workflow}
              mode={
                watching
                  ? 'watch'
                  : canManage && workflow.status !== 'ARCHIVED'
                    ? 'edit'
                    : 'preview'
              }
              run={runQuery.data}
              onSaved={setSavedWorkflow}
              onSaveStateChange={handleSaveState}
              selectNodeId={focusNodeId}
            />
          ) : (
            <div className="space-y-6">
              <NodeList workflow={workflow} />
              <TriggerPanel workflow={workflow} canActivate={hasRunnableStep} />
              <RunPanel workflowId={workflow.id} canRun={hasRunnableStep} />
              <PastRunsPanel workflowId={workflow.id} />
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
