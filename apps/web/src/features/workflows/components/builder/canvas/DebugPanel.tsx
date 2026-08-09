'use client';

import type { WorkflowNode, WorkflowRunDto } from '@vaep/types';
import { STEP_STATUS_STYLES } from '../../../labels';
import { formatRelativeTime } from '@/lib/time';

function preview(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

function durationMs(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * DebugPanel — what one step actually did on this run (doc 29 §3.F). Shown in the
 * dock while watching a run; picking a node reveals its status, attempt, timing,
 * output and any error. Reads from the polled run's steps (no extra fetch).
 */
export function DebugPanel({
  run,
  selectedNode,
}: {
  run?: WorkflowRunDto;
  selectedNode: WorkflowNode | null;
}) {
  const step = selectedNode
    ? run?.steps?.find((s) => s.nodeId === selectedNode.id)
    : undefined;
  const took = step ? durationMs(step.startedAt, step.finishedAt) : null;

  return (
    <aside
      className="flex w-80 shrink-0 flex-col rounded-2xl border border-wf-hairline bg-void-section"
      aria-label="Run details"
    >
      <div className="border-b border-wf-hairline px-4 py-3">
        <p className="font-display text-sm font-semibold text-wf-ink">Run details</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!selectedNode ? (
          <p className="text-sm text-wf-ink-3">
            Select a step on the canvas to see what it did this run.
          </p>
        ) : !step ? (
          <p className="text-sm text-wf-ink-3">
            {selectedNode.name?.trim() || selectedNode.type} hasn&apos;t run yet on this run.
          </p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${STEP_STATUS_STYLES[step.status]}`}
              >
                {step.status}
              </span>
              {step.attempt > 1 ? (
                <span className="rounded-full bg-status-escalated/15 px-2 py-0.5 text-[10px] font-medium text-status-escalated">
                  attempt {step.attempt}
                </span>
              ) : null}
              {took ? <span className="text-xs text-wf-ink-3">{took}</span> : null}
              {step.startedAt ? (
                <span className="ml-auto text-xs text-wf-ink-3">
                  {formatRelativeTime(step.startedAt)}
                </span>
              ) : null}
            </div>

            {step.error ? (
              <div>
                <p className="mb-1 text-xs font-medium text-wf-ink-2">Error</p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-status-failed/30 bg-status-failed/10 p-2 text-xs text-status-failed">
                  {step.error}
                </pre>
              </div>
            ) : null}

            {step.output != null ? (
              <div>
                <p className="mb-1 text-xs font-medium text-wf-ink-2">Output</p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-wf-hairline bg-void-card p-2 font-mono text-xs text-wf-ink-2">
                  {preview(step.output)}
                </pre>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
