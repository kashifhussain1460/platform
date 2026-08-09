'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { BuilderLifecycleBar } from '@/features/workflows/components/builder/BuilderLifecycleBar';
import { RunBar } from '@/features/workflows/components/builder/RunBar';
import { RunControls } from '@/features/workflows/components/builder/RunControls';
import { WorkflowCanvas } from '@/features/workflows/components/builder/canvas/WorkflowCanvas';
import { NodeList } from '@/features/workflows/components/NodeList';
import { PastRunsPanel } from '@/features/workflows/components/PastRunsPanel';
import { RunPanel } from '@/features/workflows/components/RunPanel';
import { TriggerPanel } from '@/features/workflows/components/TriggerPanel';
import { useWorkflow, useWorkflowRun } from '@/features/workflows/hooks';
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

  // Watch mode: `?run=<id>` overlays that run's live status on the canvas.
  const runId = searchParams.get('run');
  const watching = Boolean(runId);
  const runQuery = useWorkflowRun(runId);

  // Client-side route guard.
  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 flex items-center justify-between gap-4 pt-2">
        <div>
          <p className="text-sm text-zinc-500">Workflow</p>
          <h1 className="text-2xl font-bold text-white">
            {workflow?.name ?? 'Loading…'}
          </h1>
        </div>
        <Link
          href="/workflows"
          className="text-sm font-medium text-zinc-400 transition-colors hover:text-white"
        >
          ← Workflows
        </Link>
      </div>

      {!dismissed && unresolvedIds.length > 0 && workflow && (
        <div className="mb-6 flex items-start justify-between gap-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-400">
            AI couldn&apos;t confidently fill in{' '}
            {unresolvedIds
              .map((id) => workflow.definition.nodes.find((n) => n.id === id)?.name ?? id)
              .join(', ')}
            . Open that step in the Steps view and choose a tool before activating.
          </p>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 text-sm text-amber-400 hover:text-amber-300"
          >
            Dismiss
          </button>
        </div>
      )}

      {isLoading || !workflow ? (
        <p className="text-sm text-zinc-500">Loading workflow…</p>
      ) : (
        <>
          <div className="mb-4">
            <BuilderLifecycleBar
              workflow={workflow}
              canManage={role === 'OWNER' || role === 'ADMIN'}
            />
          </div>

          <div className="mb-4">
            {watching ? (
              <RunBar
                run={runQuery.data}
                isLoading={runQuery.isLoading}
                nodeCount={(workflow.definition?.nodes ?? []).length}
                onClose={() => router.push(`/workflows/${workflowId}`)}
                onWatchRun={(rid) => router.push(`/workflows/${workflowId}?run=${rid}`)}
              />
            ) : (
              <RunControls
                workflowId={workflowId}
                canRun={(workflow.definition?.nodes ?? []).some((n) => n.type !== 'TRIGGER')}
                onWatchRun={(rid) => router.push(`/workflows/${workflowId}?run=${rid}`)}
              />
            )}
          </div>

          {!watching && (
            <div
              className="mb-5 inline-flex rounded-lg border border-wf-hairline p-0.5"
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
                  view === v ? 'bg-violet text-white' : 'text-wf-ink-2 hover:text-wf-ink'
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
                  : (role === 'OWNER' || role === 'ADMIN') && workflow.status !== 'ARCHIVED'
                    ? 'edit'
                    : 'preview'
              }
              run={runQuery.data}
            />
          ) : (
            <div className="space-y-6">
              <NodeList workflow={workflow} />
              <TriggerPanel
                workflow={workflow}
                canActivate={(workflow.definition?.nodes ?? []).some(
                  (n) => n.type !== 'TRIGGER',
                )}
              />
              <RunPanel
                workflowId={workflow.id}
                canRun={(workflow.definition?.nodes ?? []).some(
                  (n) => n.type !== 'TRIGGER',
                )}
              />
              <PastRunsPanel workflowId={workflow.id} />
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
