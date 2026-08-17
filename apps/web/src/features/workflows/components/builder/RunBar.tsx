'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { WorkflowRunDto, WorkflowRunStatus } from '@vaep/types';
import { RUN_STATUS_STYLES } from '../../labels';
import { formatRelativeTime } from '@/lib/time';
import { useCancelRun, useRetryRun } from '../../hooks';

const CANCELLABLE: WorkflowRunStatus[] = ['PENDING', 'RUNNING', 'WAITING'];
const RETRYABLE: WorkflowRunStatus[] = ['FAILED', 'CANCELLED', 'TIMED_OUT'];

const barBtn =
  'inline-flex items-center gap-1.5 rounded-lg border border-app-border px-3 py-1.5 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:text-app-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus';

/**
 * RunBar — the header of the run-watch surface (doc 29 §3.F). Shows the live run
 * status (it polls via the parent's `useWorkflowRun`), step progress, and the
 * controls that fit the state: Cancel while running, Retry (fresh run) once
 * failed. "Back to editing" leaves watch mode.
 */
export function RunBar({
  run,
  isLoading,
  nodeCount,
  onClose,
  onWatchRun,
}: {
  run?: WorkflowRunDto;
  isLoading: boolean;
  nodeCount: number;
  onClose: () => void;
  onWatchRun: (runId: string) => void;
}) {
  const cancel = useCancelRun();
  const retry = useRetryRun();

  const status = run?.status;
  const completed = run?.steps?.filter((s) => s.status === 'COMPLETED').length ?? 0;

  return (
    <div className="rounded-2xl border border-app-border bg-app-raised p-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onClose} className={barBtn}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to editing
        </button>

        {status ? (
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${RUN_STATUS_STYLES[status]}`}
          >
            {status}
          </span>
        ) : (
          <span className="text-xs text-app-ink-3">{isLoading ? 'Loading run…' : 'Run not found'}</span>
        )}

        {run ? (
          <span className="text-xs text-app-ink-3">
            {completed}/{nodeCount} steps
            {run.dryRun ? ' · test run' : ''}
            {run.startedAt ? ` · started ${formatRelativeTime(run.startedAt)}` : ''}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {status === 'WAITING' ? (
            <Link href="/approvals" className={barBtn}>
              Open approvals
            </Link>
          ) : null}

          {status && CANCELLABLE.includes(status) ? (
            <button
              type="button"
              onClick={() => run && cancel.mutate(run.id)}
              disabled={cancel.isPending}
              className={barBtn}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel'}
            </button>
          ) : null}

          {status && RETRYABLE.includes(status) ? (
            <button
              type="button"
              onClick={() =>
                run &&
                retry.mutate(run.id, { onSuccess: (fresh) => onWatchRun(fresh.id) })
              }
              disabled={retry.isPending}
              className="rounded-lg bg-violet px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-60"
            >
              {retry.isPending ? 'Retrying…' : 'Retry'}
            </button>
          ) : null}
        </div>
      </div>

      {run?.error ? <p className="mt-2 text-xs text-sl-failed">{run.error}</p> : null}
      {cancel.isError ? <p className="mt-2 text-xs text-sl-failed">{cancel.error.message}</p> : null}
    </div>
  );
}
