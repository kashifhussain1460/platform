'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { RunsTable } from '@/features/runs/components/RunsTable';
import { useAllRuns, useWorkflow } from '@/features/workflows/hooks';
import { useSessionStore } from '@/stores/session.store';

/**
 * `/workflows/[id]/runs` — the same operations table, scoped to one workflow
 * (UX plan §53). Reuses `GET /workflows/runs?workflowId=` rather than the
 * per-workflow endpoint so both views share one component and one polling rule.
 */
export default function WorkflowRunsPage({
  params,
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();
  const { data: workflow } = useWorkflow(params.id);
  const { data: runs, isLoading } = useAllRuns({
    workflowId: params.id,
    limit: 100,
  });

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
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 pt-2">
        <div className="min-w-0">
          <p className="text-sm text-app-ink-3">Runs</p>
          <h1 className="truncate text-2xl font-bold text-app-ink">
            {workflow?.name ?? 'Workflow'}
          </h1>
        </div>
        <Link
          href={`/workflows/${params.id}`}
          className="text-sm font-medium text-app-ink-2 transition-colors hover:text-app-ink"
        >
          ← Back to the workflow
        </Link>
      </div>

      <RunsTable
        runs={runs}
        isLoading={isLoading}
        showWorkflow={false}
        emptyMessage="This workflow hasn’t run yet."
      />
    </AppShell>
  );
}
