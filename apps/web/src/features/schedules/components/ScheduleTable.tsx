'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Pause, Play } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { RunStatusPill } from '@/features/runs/components/RunsTable';
import {
  useActivateWorkflow,
  useDeactivateWorkflow,
} from '@/features/workflows/hooks';
import { formatRelativeTime } from '@/lib/time';
import type { ScheduleRow } from '../hooks';

/**
 * The schedules table (UX plan §22, §47) — an OPERATIONS view, not another way
 * to create a workflow. Everything here acts on schedules that already exist.
 */
export function ScheduleTable({
  rows,
  isLoading,
  canManage,
}: {
  rows: ScheduleRow[];
  isLoading?: boolean;
  canManage: boolean;
}) {
  const [confirmPause, setConfirmPause] = useState<ScheduleRow | null>(null);
  const activate = useActivateWorkflow();
  const deactivate = useDeactivateWorkflow();

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading schedules…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-2xl border border-app-border bg-app-surface px-5 py-6 text-sm text-app-ink-3">
        No workflows run on a schedule yet. Open a workflow, set its trigger to
        Schedule, and it will show up here.
      </p>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-2xl border border-app-border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-app-surface text-xs uppercase tracking-wide text-app-ink-3">
            <tr>
              <th className="px-4 py-3 font-medium">Workflow</th>
              <th className="px-4 py-3 font-medium">Runs</th>
              <th className="px-4 py-3 font-medium">Next</th>
              <th className="px-4 py-3 font-medium">Last</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {rows.map((row) => (
              <tr key={row.workflow.id} className="transition-colors hover:bg-app-raised">
                <td className="px-4 py-3">
                  <Link
                    href={`/workflows/${row.workflow.id}`}
                    className="font-medium text-app-ink hover:text-app-ink"
                  >
                    {row.workflow.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-app-ink-2">
                  {row.summary}
                  <span className="block text-xs text-app-ink-3">{row.timeZone}</span>
                </td>
                <td className="px-4 py-3 text-app-ink-2">
                  {row.active ? (
                    row.nextRun ? (
                      row.nextRun.toLocaleString(undefined, {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    ) : (
                      <span className="text-app-ink-3">custom schedule</span>
                    )
                  ) : (
                    <span className="text-app-ink-3">paused</span>
                  )}
                </td>
                <td className="px-4 py-3 text-app-ink-2">
                  {row.lastRun ? (
                    <Link href={`/runs/${row.lastRun.id}`} className="hover:text-app-ink">
                      {formatRelativeTime(
                        row.lastRun.startedAt ?? row.lastRun.createdAt,
                      )}
                    </Link>
                  ) : (
                    <span className="text-app-ink-3">never</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {row.lastRun ? (
                    <RunStatusPill status={row.lastRun.status} />
                  ) : (
                    <span className="text-xs text-app-ink-3">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-3">
                    {canManage &&
                      (row.active ? (
                        <button
                          type="button"
                          onClick={() => setConfirmPause(row)}
                          className="inline-flex items-center gap-1 text-sm text-app-ink-2 hover:text-app-ink"
                        >
                          <Pause className="h-3.5 w-3.5" aria-hidden />
                          Pause
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => activate.mutate(row.workflow.id)}
                          disabled={activate.isPending}
                          className="inline-flex items-center gap-1 text-sm text-sl-succeeded hover:brightness-125 disabled:opacity-50"
                        >
                          <Play className="h-3.5 w-3.5" aria-hidden />
                          Resume
                        </button>
                      ))}
                    <Link
                      href={`/workflows/${row.workflow.id}/runs`}
                      className="text-sm text-violet hover:text-app-ink"
                    >
                      Runs
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(activate.isError || deactivate.isError) && (
        <p className="mt-3 text-sm text-sl-failed">
          {(activate.error ?? deactivate.error)?.message}
        </p>
      )}

      {/* Pause vs cancel is a distinction people get wrong, and getting it wrong
          here means believing you stopped something you didn't (UX plan §23). */}
      <Modal
        open={Boolean(confirmPause)}
        onClose={() => setConfirmPause(null)}
        title="Pause this schedule?"
        size="md"
      >
        <p className="text-sm text-app-ink-2">
          <span className="font-medium text-app-ink">
            {confirmPause?.workflow.name}
          </span>{' '}
          will stop starting on its own. You can resume it any time.
        </p>
        <p className="mt-3 text-sm text-app-ink-2">
          A run that is already going keeps going. To stop one that is running
          right now, open it from Runs and stop it there.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setConfirmPause(null)}
            className="rounded-lg border border-app-border-strong px-4 py-2 text-sm font-medium text-app-ink-2 hover:bg-app-raised"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirmPause) return;
              deactivate.mutate(confirmPause.workflow.id);
              setConfirmPause(null);
            }}
            className="rounded-lg bg-violet px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Pause it
          </button>
        </div>
      </Modal>
    </>
  );
}
