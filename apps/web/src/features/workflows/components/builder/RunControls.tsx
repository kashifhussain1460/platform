'use client';

import { useState } from 'react';
import { History, Play } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useRunWorkflow, useWorkflowRuns } from '../../hooks';
import { RUN_STATUS_STYLES } from '../../labels';
import { formatRelativeTime } from '@/lib/time';

const violetBtn =
  'inline-flex items-center gap-1.5 rounded-lg bg-violet px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus';
const secondaryBtn =
  'inline-flex items-center gap-1.5 rounded-lg border border-wf-hairline px-3 py-1.5 text-sm font-medium text-wf-ink-2 transition-colors hover:border-wf-hairline-hover hover:text-wf-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus';

/**
 * RunControls — start a run (optionally a test/dry run with a trigger payload)
 * or open the run history (doc 29 §3.F). On start / on picking a past run, the
 * parent switches to watch mode via `onWatchRun`.
 */
export function RunControls({
  workflowId,
  canRun,
  onWatchRun,
}: {
  workflowId: string;
  canRun: boolean;
  onWatchRun: (runId: string) => void;
}) {
  const [showLaunch, setShowLaunch] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [triggerText, setTriggerText] = useState('');
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const run = useRunWorkflow(workflowId);

  const start = () => {
    let trigger: Record<string, unknown> | undefined;
    if (triggerText.trim()) {
      try {
        const parsed = JSON.parse(triggerText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          trigger = parsed as Record<string, unknown>;
        } else {
          setTriggerError('Trigger must be a JSON object.');
          return;
        }
      } catch {
        setTriggerError('Invalid JSON.');
        return;
      }
    }
    setTriggerError(null);
    run.mutate(
      { trigger, dryRun },
      { onSuccess: (created) => {
          setShowLaunch(false);
          onWatchRun(created.id);
        } },
    );
  };

  return (
    <div className="rounded-2xl border border-wf-hairline bg-void-section p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowLaunch((v) => !v)}
          disabled={!canRun}
          title={!canRun ? 'Add at least one step first.' : undefined}
          className={violetBtn}
        >
          <Play className="h-4 w-4" aria-hidden />
          Run
        </button>
        <button type="button" onClick={() => setShowHistory(true)} className={secondaryBtn}>
          <History className="h-4 w-4" aria-hidden />
          Runs
        </button>
      </div>

      {showLaunch && (
        <div className="mt-3 rounded-xl border border-wf-hairline bg-void-card p-3">
          <label className="flex items-center gap-2 text-sm text-wf-ink-2">
            <input
              type="checkbox"
              className="accent-violet"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            Test run — preview tool actions, don&apos;t really send
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium text-wf-ink-2">
              Trigger payload (optional JSON)
            </span>
            <textarea
              rows={3}
              value={triggerText}
              onChange={(e) => setTriggerText(e.target.value)}
              placeholder={'{ "candidateEmail": "a@b.com" }'}
              className="w-full rounded-lg border border-wf-hairline bg-void-section px-3 py-2 font-mono text-sm text-wf-ink outline-none placeholder:text-wf-ink-3 focus-visible:ring-2 focus-visible:ring-wf-focus"
            />
          </label>
          {triggerError ? <p className="mt-1 text-xs text-status-failed">{triggerError}</p> : null}
          {run.isError ? <p className="mt-1 text-xs text-status-failed">{run.error.message}</p> : null}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button type="button" onClick={() => setShowLaunch(false)} className={secondaryBtn}>
              Cancel
            </button>
            <button type="button" onClick={start} disabled={run.isPending} className={violetBtn}>
              {run.isPending ? 'Starting…' : 'Start run'}
            </button>
          </div>
        </div>
      )}

      <Modal open={showHistory} onClose={() => setShowHistory(false)} title="Run history" size="md">
        <RunHistoryList
          workflowId={workflowId}
          onWatch={(id) => {
            setShowHistory(false);
            onWatchRun(id);
          }}
        />
      </Modal>
    </div>
  );
}

function RunHistoryList({
  workflowId,
  onWatch,
}: {
  workflowId: string;
  onWatch: (runId: string) => void;
}) {
  const { data: runs, isLoading, isError, error } = useWorkflowRuns(workflowId);

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg border border-wf-hairline bg-void-card" />
        ))}
      </div>
    );
  }
  if (isError) return <p className="text-sm text-status-failed">{error.message}</p>;
  if (!runs || runs.length === 0) {
    return <p className="text-sm text-wf-ink-3">No runs yet. Start one to see it here.</p>;
  }

  return (
    <ol className="space-y-2">
      {runs.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onWatch(r.id)}
            className="flex w-full items-center gap-2 rounded-lg border border-wf-hairline bg-void-card px-3 py-2 text-left transition-colors hover:border-wf-hairline-hover"
          >
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${RUN_STATUS_STYLES[r.status]}`}
            >
              {r.status}
            </span>
            <span className="text-xs text-wf-ink-2">
              {r.source}
              {r.dryRun ? ' · test' : ''}
            </span>
            <span className="ml-auto text-xs text-wf-ink-3">
              {formatRelativeTime(r.startedAt ?? r.createdAt)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
