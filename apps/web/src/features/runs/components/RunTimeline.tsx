'use client';

import Link from 'next/link';
import { Check, ChevronRight, Circle, Clock, Loader2, X } from 'lucide-react';
import type { WorkflowRunDto, WorkflowStepRunDto } from '@vaep/types';
import { NODE_LABELS } from '@/features/workflows/labels';

/**
 * What actually happened, step by step (UX plan §26).
 *
 * The design goal is "execution truth": each step shows its real state, and a
 * step waiting on a person says so and links to where that person acts. A step
 * that has not started yet is shown as pending rather than omitted, so the user
 * can see how much is left.
 */
export function RunTimeline({ run }: { run: WorkflowRunDto }) {
  const steps = run.steps ?? [];

  if (steps.length === 0) {
    return (
      <p className="rounded-2xl border border-app-border bg-app-surface px-5 py-6 text-sm text-app-ink-3">
        {run.status === 'PENDING'
          ? 'Queued — waiting for a worker to pick it up.'
          : 'No steps recorded for this run.'}
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {steps.map((step) => (
        <TimelineStep key={step.id} step={step} run={run} />
      ))}
    </ol>
  );
}

function TimelineStep({
  step,
  run,
}: {
  step: WorkflowStepRunDto;
  run: WorkflowRunDto;
}) {
  const label =
    NODE_LABELS[step.type as keyof typeof NODE_LABELS] ?? step.type;

  // An APPROVAL step that hasn't finished while the run is WAITING is the
  // "stuck on a human" case — the one worth pointing somewhere actionable.
  const awaitingPerson =
    step.type === 'APPROVAL' && run.status === 'WAITING' && !step.finishedAt;

  return (
    <li className="rounded-xl border border-app-border bg-app-surface p-3">
      <div className="flex items-start gap-3">
        <StepIcon status={step.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-app-ink">{label}</span>
            <span className="font-mono text-xs text-app-ink-3">{step.nodeId}</span>
            {step.attempt > 1 && (
              <span className="rounded-full bg-status-waiting/15 px-2 py-0.5 text-[10px] font-medium text-sl-waiting">
                attempt {step.attempt}
              </span>
            )}
            <span className="ml-auto text-xs text-app-ink-3">
              {stepDuration(step)}
            </span>
          </div>

          {awaitingPerson && (
            <Link
              href="/approvals"
              className="mt-1 inline-flex items-center gap-1 text-sm text-sl-waiting hover:underline"
            >
              Waiting for someone to approve it
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}

          {step.error && (
            <p className="mt-1 break-words text-sm text-sl-failed">
              {step.error}
            </p>
          )}

          {!step.error && step.output != null && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-app-ink-3 hover:text-app-ink-2">
                What it produced
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs text-app-ink-2">
                {preview(step.output)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

function StepIcon({ status }: { status: string }) {
  const base = 'mt-0.5 h-4 w-4 shrink-0';
  switch (status) {
    case 'COMPLETED':
      return <Check className={`${base} text-sl-succeeded`} aria-label="Done" />;
    case 'FAILED':
      return <X className={`${base} text-sl-failed`} aria-label="Failed" />;
    case 'COMPENSATED':
      return <X className={`${base} text-sl-waiting`} aria-label="Rolled back" />;
    case 'RUNNING':
      return (
        <Loader2
          className={`${base} animate-spin text-violet`}
          aria-label="Running"
        />
      );
    case 'RETRYING':
      return (
        <Loader2
          className={`${base} animate-spin text-sl-waiting`}
          aria-label="Retrying"
        />
      );
    case 'WAITING':
      return <Clock className={`${base} text-sl-waiting`} aria-label="Waiting" />;
    case 'SKIPPED':
      return <Circle className={`${base} text-app-ink-3`} aria-label="Skipped" />;
    default:
      return <Circle className={`${base} text-app-ink-3`} aria-label="Pending" />;
  }
}

function stepDuration(step: WorkflowStepRunDto): string {
  if (!step.startedAt) return '';
  const end = step.finishedAt ? new Date(step.finishedAt).getTime() : Date.now();
  const ms = end - new Date(step.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}
