'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useRunWorkflow, useWorkflowRun } from '../hooks';
import { RUN_STATUS_STYLES } from '../labels';
import { RunSteps } from './RunSteps';

/**
 * Trigger a run (optional JSON trigger payload) and poll GET /workflows/runs/:id
 * while PENDING/RUNNING, showing each WorkflowStepRun's status + output (a live
 * run log). Save the workflow first so the run executes the latest steps.
 */
export function RunPanel({
  workflowId,
  canRun = true,
}: {
  workflowId: string;
  /** False when the saved workflow has no runnable steps (only a TRIGGER). */
  canRun?: boolean;
}) {
  const [triggerText, setTriggerText] = useState('{\n  "query": "refund policy"\n}');
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  const run = useRunWorkflow(workflowId);
  const { data: current } = useWorkflowRun(runId);

  const onRun = () => {
    let trigger: Record<string, unknown> | undefined;
    const text = triggerText.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          trigger = parsed as Record<string, unknown>;
        } else {
          setTriggerError('Trigger must be a JSON object');
          return;
        }
      } catch {
        setTriggerError('Invalid JSON');
        return;
      }
    }
    setTriggerError(null);
    run.mutate(
      { trigger, dryRun },
      { onSuccess: (created) => setRunId(created.id) },
    );
  };

  const steps = current?.steps ?? [];

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <h2 className="mb-3 text-sm font-medium text-app-ink-2">Run</h2>

      <label className="mb-1 block text-xs font-medium text-app-ink-2">
        Trigger payload (JSON, optional)
      </label>
      <textarea
        rows={4}
        className="field-modern font-mono text-sm"
        value={triggerText}
        onChange={(e) => setTriggerText(e.target.value)}
      />
      {triggerError && (
        <p className="mt-1 text-xs text-red-600">{triggerError}</p>
      )}

      <label className="mt-2 flex items-center gap-2 text-sm text-app-ink-2">
        <input
          type="checkbox"
          checked={dryRun}
          onChange={(e) => setDryRun(e.target.checked)}
          className="h-4 w-4 rounded border-app-border bg-app-surface accent-violet-secondary"
        />
        Dry run (preview only — won&rsquo;t actually send emails, create calendar events, etc.)
      </label>

      {!canRun && (
        <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-800">
          Add at least one step and click <strong>Save</strong> above before running.
        </p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <Button variant="violet" onClick={onRun} disabled={run.isPending || !canRun}>
          {run.isPending ? 'Starting…' : 'Run workflow'}
        </Button>
        {current && (
          <span
            className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${RUN_STATUS_STYLES[current.status]}`}
          >
            {current.status}
          </span>
        )}
        {current?.source && (
          <span className="inline-block rounded-full bg-app-raised px-2.5 py-0.5 text-xs font-medium text-app-ink-2">
            {current.source}
          </span>
        )}
        {current?.dryRun && (
          <span className="inline-block rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-800">
            DRY RUN
          </span>
        )}
      </div>

      {current?.correlationId && (
        <p className="mt-2 font-mono text-xs text-app-ink-3">
          corr: {current.correlationId}
          {current.triggerEventId ? ` · event: ${current.triggerEventId}` : ''}
        </p>
      )}

      {run.isError && (
        <p className="mt-2 text-sm text-red-600">
          {run.error?.message ?? 'Could not start run'}
        </p>
      )}
      {current?.error && (
        <p className="mt-2 text-sm text-red-600">{current.error}</p>
      )}

      {runId && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-medium text-app-ink-2">Run log</h3>
          <RunSteps steps={steps} />
        </div>
      )}
    </section>
  );
}
