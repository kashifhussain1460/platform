'use client';

import Link from 'next/link';
import type { WorkflowRunDto, WorkflowRunStatus } from '@vaep/types';
import { WORKFLOW_RUN_STATUSES } from '@vaep/types';
import {
  runStateLabel,
  triggerSourceLabel,
  type StateTone,
} from '@/features/workflows/lifecycle';
import { formatRelativeTime } from '@/lib/time';

const TONE_CLS: Record<StateTone, string> = {
  neutral: 'bg-white/[0.06] text-zinc-300',
  good: 'bg-status-succeeded/15 text-status-succeeded',
  warn: 'bg-status-waiting/15 text-status-waiting',
  bad: 'bg-status-failed/15 text-status-failed',
  muted: 'bg-white/[0.04] text-zinc-500',
};

/** Wall-clock length of a run, or how long it has been going. */
export function formatDuration(run: WorkflowRunDto): string {
  const start = run.startedAt ?? run.createdAt;
  if (!start) return '—';
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const ms = end - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function RunStatusPill({ status }: { status: WorkflowRunStatus }) {
  const { label, tone } = runStateLabel(status);
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLS[tone]}`}
    >
      {label}
    </span>
  );
}

/**
 * The operations table (UX plan §25).
 *
 * Every run state is shown as its own thing — "Waiting for approval" is not
 * folded into "Running", because an operator scanning this list needs to see
 * that a run is stuck on a person, not on the machine.
 */
export function RunsTable({
  runs,
  isLoading,
  /** Hide the workflow column when the whole table is one workflow. */
  showWorkflow = true,
  emptyMessage = 'No runs yet.',
}: {
  runs: WorkflowRunDto[] | undefined;
  isLoading?: boolean;
  showWorkflow?: boolean;
  emptyMessage?: string;
}) {
  if (isLoading) {
    return <p className="text-sm text-zinc-500">Loading runs…</p>;
  }
  if (!runs || runs.length === 0) {
    return (
      <p className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-6 text-sm text-zinc-500">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            {showWorkflow && <th className="px-4 py-3 font-medium">Workflow</th>}
            <th className="px-4 py-3 font-medium">Started by</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Started</th>
            <th className="px-4 py-3 font-medium">Took</th>
            <th className="px-4 py-3 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.05]">
          {runs.map((run) => (
            <tr key={run.id} className="transition-colors hover:bg-white/[0.02]">
              {showWorkflow && (
                <td className="px-4 py-3">
                  <Link
                    href={`/workflows/${run.workflowId}`}
                    className="font-medium text-zinc-200 hover:text-white"
                  >
                    {run.workflowName ?? 'Workflow'}
                  </Link>
                  {run.dryRun && (
                    <span className="ml-2 rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                      Test
                    </span>
                  )}
                </td>
              )}
              <td className="px-4 py-3 text-zinc-400">
                {triggerSourceLabel(run.source)}
              </td>
              <td className="px-4 py-3">
                <RunStatusPill status={run.status} />
              </td>
              <td className="px-4 py-3 text-zinc-400">
                {formatRelativeTime(run.startedAt ?? run.createdAt)}
              </td>
              <td className="px-4 py-3 text-zinc-400">{formatDuration(run)}</td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={`/runs/${run.id}`}
                  className="text-sm font-medium text-violet-secondary hover:text-white"
                >
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The status filter chips above the table. URL-driven so a view is shareable. */
export function RunStatusFilter({
  value,
  onChange,
}: {
  value: WorkflowRunStatus | undefined;
  onChange: (status: WorkflowRunStatus | undefined) => void;
}) {
  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-sm transition-colors ${
      active
        ? 'bg-violet text-white'
        : 'border border-white/[0.1] text-zinc-400 hover:border-white/25 hover:text-zinc-200'
    }`;

  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => onChange(undefined)} className={chip(!value)}>
        All
      </button>
      {WORKFLOW_RUN_STATUSES.map((status) => (
        <button
          key={status}
          type="button"
          onClick={() => onChange(status)}
          className={chip(value === status)}
        >
          {runStateLabel(status).label}
        </button>
      ))}
    </div>
  );
}
