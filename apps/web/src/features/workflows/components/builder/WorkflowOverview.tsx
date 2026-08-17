'use client';

import Link from 'next/link';
import { Pause, Pencil, Play } from 'lucide-react';
import type { WorkflowDto, WorkflowRunDto } from '@vaep/types';
import { RunStatusPill } from '@/features/runs/components/RunsTable';
import { formatRelativeTime } from '@/lib/time';
import { describeSchedule, nextRunAt } from '../../schedule';
import { workflowStateLabel } from '../../lifecycle';
import { LifecycleBadge } from './LifecycleBadge';

/**
 * The workflow's resting state once it is live (UX plan §36).
 *
 * A workflow that is already working should not greet its owner with a canvas
 * and a save indicator — it should answer "is it running, did it work, when's
 * the next one". Editing is one click away and is what puts the canvas back.
 *
 * Success rate is computed from the runs actually loaded and says so; a bare
 * "96%" with no denominator is the kind of number people quote in meetings.
 */
export function WorkflowOverview({
  workflow,
  runs,
  canManage,
  onEdit,
  onRunNow,
  runPending,
  onPause,
  pausePending,
  timeZone,
}: {
  workflow: WorkflowDto;
  runs: WorkflowRunDto[] | undefined;
  canManage: boolean;
  onEdit: () => void;
  onRunNow: () => void;
  runPending?: boolean;
  onPause: () => void;
  pausePending?: boolean;
  timeZone?: string;
}) {
  const stepCount = (workflow.definition?.nodes ?? []).filter(
    (n) => n.type !== 'TRIGGER',
  ).length;

  const finished = (runs ?? []).filter(
    (r) => r.status === 'COMPLETED' || r.status === 'FAILED' || r.status === 'TIMED_OUT',
  );
  const succeeded = finished.filter((r) => r.status === 'COMPLETED').length;
  const lastRun = runs?.[0] ?? null;

  const next =
    workflow.triggerType === 'SCHEDULE' && workflow.status === 'ACTIVE'
      ? nextRunAt(workflow.triggerConfig, new Date(), timeZone)
      : null;

  const triggerSummary =
    workflow.triggerType === 'SCHEDULE'
      ? describeSchedule(workflow.triggerConfig)
      : workflow.triggerType === 'WEBHOOK'
        ? 'When something calls its webhook'
        : workflow.triggerType === 'EVENT'
          ? `When "${workflow.triggerConfig?.eventType ?? 'an event'}" happens`
          : 'Only when you start it';

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-app-border bg-app-surface p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <LifecycleBadge workflow={workflow} />
          <span className="text-sm text-app-ink-3">
            {workflowStateLabel(workflow).label === 'Active'
              ? 'This is running on its own.'
              : 'This is not running right now.'}
          </span>
        </div>

        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Starts">{triggerSummary}</Fact>
          <Fact label="Steps">{stepCount}</Fact>
          <Fact label="Last run">
            {lastRun ? (
              <Link href={`/runs/${lastRun.id}`} className="hover:text-app-ink">
                {formatRelativeTime(lastRun.startedAt ?? lastRun.createdAt)}{' '}
                <RunStatusPill status={lastRun.status} />
              </Link>
            ) : (
              <span className="text-app-ink-3">never</span>
            )}
          </Fact>
          <Fact label="Next run">
            {next ? (
              next.toLocaleString(undefined, {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })
            ) : (
              <span className="text-app-ink-3">
                {workflow.triggerType === 'SCHEDULE'
                  ? workflow.status === 'ACTIVE'
                    ? 'custom schedule'
                    : 'paused'
                  : 'not scheduled'}
              </span>
            )}
          </Fact>
          <Fact label="Finished runs">
            {finished.length === 0 ? (
              <span className="text-app-ink-3">none yet</span>
            ) : (
              <>
                {succeeded} of {finished.length} worked
                <span className="ml-1 text-app-ink-3">
                  ({Math.round((succeeded / finished.length) * 100)}%)
                </span>
              </>
            )}
          </Fact>
        </dl>

        <div className="mt-5 flex flex-wrap gap-2">
          {canManage && workflow.status === 'ACTIVE' && (
            <button
              type="button"
              onClick={onRunNow}
              disabled={runPending}
              className="inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-60"
            >
              <Play className="h-4 w-4" aria-hidden />
              {runPending ? 'Starting…' : 'Run now'}
            </button>
          )}
          {canManage && workflow.status === 'ACTIVE' && (
            <button
              type="button"
              onClick={onPause}
              disabled={pausePending}
              className="inline-flex items-center gap-2 rounded-xl border border-app-border-strong px-5 py-2.5 text-sm font-medium text-app-ink transition-colors hover:border-app-border hover:bg-app-raised disabled:opacity-60"
            >
              <Pause className="h-4 w-4" aria-hidden />
              {pausePending ? 'Pausing…' : 'Pause'}
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-2 rounded-xl border border-app-border-strong px-5 py-2.5 text-sm font-medium text-app-ink transition-colors hover:border-app-border hover:bg-app-raised"
          >
            <Pencil className="h-4 w-4" aria-hidden />
            {canManage ? 'Edit' : 'Open the builder'}
          </button>
          <Link
            href={`/workflows/${workflow.id}/runs`}
            className="inline-flex items-center gap-2 rounded-xl border border-app-border-strong px-5 py-2.5 text-sm font-medium text-app-ink transition-colors hover:border-app-border hover:bg-app-raised"
          >
            View runs
          </Link>
          <Link
            href={`/workflows/${workflow.id}/versions`}
            className="inline-flex items-center gap-2 rounded-xl border border-app-border-strong px-5 py-2.5 text-sm font-medium text-app-ink transition-colors hover:border-app-border hover:bg-app-raised"
          >
            Version history
          </Link>
        </div>

        {canManage && (
          <p className="mt-3 text-xs text-app-ink-3">
            Editing doesn&apos;t change what&apos;s running. Your changes stay a
            draft until you publish them.
          </p>
        )}
      </section>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-app-ink-3">{label}</dt>
      <dd className="mt-1 text-app-ink">{children}</dd>
    </div>
  );
}
