'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { WorkflowRunStatus } from '@vaep/types';
import { WORKFLOW_RUN_STATUSES } from '@vaep/types';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { RunStatusFilter, RunsTable } from '@/features/runs/components/RunsTable';
import { useAllRuns } from '@/features/workflows/hooks';
import { isRunInFlight } from '@/features/workflows/lifecycle';
import { useSessionStore } from '@/stores/session.store';

/**
 * `/runs` — the cross-workflow operations view (UX plan §22, §25).
 *
 * Separate from the builder on purpose: this is the surface you open when
 * something is wrong, not when you're creating something. The filter lives in
 * the URL so "show me everything that failed" is a link you can send someone.
 */
export default function RunsPage() {
  const router = useRouter();
  const search = useSearchParams();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();

  const statusParam = search.get('status');
  const status = WORKFLOW_RUN_STATUSES.includes(statusParam as WorkflowRunStatus)
    ? (statusParam as WorkflowRunStatus)
    : undefined;

  const { data: runs, isLoading } = useAllRuns({ status, limit: 100 });

  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  const inFlight = (runs ?? []).filter((r) => isRunInFlight(r.status)).length;

  const setStatus = (next: WorkflowRunStatus | undefined) => {
    router.replace(next ? `/runs?status=${next}` : '/runs');
  };

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 pt-2">
        <h1 className="text-2xl font-bold text-app-ink">Runs</h1>
        <p className="mt-1 text-sm text-app-ink-3">
          Every time one of your workflows has run.
          {inFlight > 0 && ` ${inFlight} going right now.`}
        </p>
      </div>

      <div className="mb-4">
        <RunStatusFilter value={status} onChange={setStatus} />
      </div>

      <RunsTable
        runs={runs}
        isLoading={isLoading}
        emptyMessage={
          status
            ? 'No runs with that status.'
            : 'Nothing has run yet. Turn a workflow on, or open one and press Run now.'
        }
      />
    </AppShell>
  );
}
