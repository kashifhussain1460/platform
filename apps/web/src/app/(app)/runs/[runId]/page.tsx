'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { RunFailureCard } from '@/features/runs/components/RunFailureCard';
import { RunTimeline } from '@/features/runs/components/RunTimeline';
import { RunStatusPill, formatDuration } from '@/features/runs/components/RunsTable';
import {
  useCancelRun,
  useRetryRun,
  useWorkflow,
  useWorkflowRun,
} from '@/features/workflows/hooks';
import { isRunInFlight, triggerSourceLabel } from '@/features/workflows/lifecycle';
import { formatRelativeTime } from '@/lib/time';
import { useSessionStore } from '@/stores/session.store';

/**
 * `/runs/[runId]` — one run's execution truth (UX plan §26, §28, §37).
 *
 * The timeline is the page. A failure card sits above it when there is one,
 * and the internal identifiers are tucked into an admin-only disclosure — a
 * normal user should never need to know what a correlationId is.
 */
export default function RunDetailPage({
  params,
}: {
  params: { runId: string };
}) {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const role = useSessionStore((s) => s.user?.role);
  const shellProps = useAppShellProps();

  const { data: run, isLoading } = useWorkflowRun(params.runId);
  const { data: workflow } = useWorkflow(run?.workflowId ?? '');
  const cancel = useCancelRun();
  const retry = useRetryRun();

  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  if (isLoading || !run) {
    return (
      <AppShell {...shellProps}>
        <p className="pt-4 text-sm text-zinc-500">
          {isLoading ? 'Loading this run…' : 'That run doesn’t exist.'}
        </p>
      </AppShell>
    );
  }

  const failed = run.status === 'FAILED' || run.status === 'TIMED_OUT';
  const canManage = role === 'OWNER' || role === 'ADMIN';

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 pt-2">
        <div className="min-w-0">
          <p className="text-sm text-zinc-500">Run</p>
          <h1 className="truncate text-2xl font-bold text-white">
            {run.workflowName ?? workflow?.name ?? 'Workflow run'}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-zinc-400">
            <RunStatusPill status={run.status} />
            <span>Started {triggerSourceLabel(run.source).toLowerCase()}</span>
            <span>·</span>
            <span>{formatRelativeTime(run.startedAt ?? run.createdAt)}</span>
            <span>·</span>
            <span>took {formatDuration(run)}</span>
            {run.dryRun && (
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs uppercase tracking-wide text-zinc-400">
                Test run — nothing was really sent
              </span>
            )}
          </div>
        </div>
        <Link
          href="/runs"
          className="text-sm font-medium text-zinc-400 transition-colors hover:text-white"
        >
          ← All runs
        </Link>
      </div>

      {failed && (
        <div className="mb-6">
          <RunFailureCard
            run={run}
            onRetry={
              canManage
                ? () =>
                    retry.mutate(run.id, {
                      onSuccess: (fresh) => router.push(`/runs/${fresh.id}`),
                    })
                : undefined
            }
            retrying={retry.isPending}
            retryError={retry.error?.message ?? null}
          />
        </div>
      )}

      {isRunInFlight(run.status) && canManage && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
          <p className="text-sm text-zinc-400">
            {run.status === 'WAITING'
              ? 'This run is paused until someone decides on the approval.'
              : 'This run is still going. Updates appear here automatically.'}
          </p>
          <div className="flex gap-2">
            {run.status === 'WAITING' && (
              <Link
                href="/approvals"
                className="rounded-lg border border-white/[0.14] px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-white/[0.06]"
              >
                Go to approvals
              </Link>
            )}
            <button
              type="button"
              onClick={() => cancel.mutate(run.id)}
              disabled={cancel.isPending}
              className="rounded-lg border border-status-failed/30 px-3 py-1.5 text-sm font-medium text-status-failed transition-colors hover:bg-status-failed/10 disabled:opacity-50"
            >
              {cancel.isPending ? 'Stopping…' : 'Stop this run'}
            </button>
          </div>
        </div>
      )}
      {cancel.isError && (
        <p className="mb-4 text-sm text-status-failed">{cancel.error.message}</p>
      )}

      <h2 className="mb-3 font-display text-base font-semibold text-white">
        What happened
      </h2>
      <RunTimeline run={run} />

      {/* Advanced/debug identifiers (UX plan §37) — present for the people who
          need them when raising a support ticket, invisible to everyone else. */}
      {canManage && (
        <details className="mt-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
          <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">
            Technical details
          </summary>
          <dl className="mt-3 grid gap-2 font-mono text-xs text-zinc-500 sm:grid-cols-2">
            <DebugRow label="runId" value={run.id} />
            <DebugRow label="workflowId" value={run.workflowId} />
            <DebugRow label="workflowVersionId" value={run.workflowVersionId} />
            <DebugRow label="correlationId" value={run.correlationId} />
            <DebugRow label="triggerEventId" value={run.triggerEventId} />
            <DebugRow label="failureClass" value={run.failureClass} />
            <DebugRow label="resumeNodeId" value={run.resumeNodeId} />
            <DebugRow label="startedByUserId" value={run.startedByUserId} />
          </dl>
        </details>
      )}
    </AppShell>
  );
}

function DebugRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-zinc-600">{label}:</dt>
      <dd className="min-w-0 break-all text-zinc-400">{value ?? '—'}</dd>
    </div>
  );
}
