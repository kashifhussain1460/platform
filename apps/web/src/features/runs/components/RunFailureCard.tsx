'use client';

import Link from 'next/link';
import { CircleAlert } from 'lucide-react';
import type { WorkflowRunDto } from '@vaep/types';
import { failureAdvice } from '@/features/workflows/lifecycle';
import { NODE_LABELS } from '@/features/workflows/labels';

/**
 * FAILURE UX (UX plan §28) — never just "Workflow Failed".
 *
 * Four things, in the order someone actually needs them: which step, why, what
 * that means for the outside world, and what to do.
 *
 * The retry wording matters. `POST /workflows/runs/:id/retry` starts a NEW run
 * from the beginning — it does not resume the failed one. Saying "retry step"
 * would imply the platform can pick up where it left off and skip what already
 * succeeded, which it cannot; a customer who believed that would double-send
 * every email the run had already sent. So the button says what it does.
 */
export function RunFailureCard({
  run,
  onRetry,
  retrying,
  retryError,
}: {
  run: WorkflowRunDto;
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: string | null;
}) {
  const failedStep = (run.steps ?? []).find((s) => s.status === 'FAILED');
  const stepLabel = failedStep
    ? (NODE_LABELS[failedStep.type as keyof typeof NODE_LABELS] ?? failedStep.type)
    : null;

  const advice = failureAdvice(run.failureClass);
  const completedCount = (run.steps ?? []).filter(
    (s) => s.status === 'COMPLETED',
  ).length;

  return (
    <section
      className="rounded-2xl border border-status-failed/25 bg-status-failed/[0.07] p-5"
      role="alert"
    >
      <h2 className="flex items-center gap-2 font-display text-base font-semibold text-status-failed">
        <CircleAlert className="h-5 w-5" aria-hidden />
        {run.status === 'TIMED_OUT' ? 'This run timed out' : 'This run failed'}
      </h2>

      <dl className="mt-3 space-y-2 text-sm">
        {stepLabel && (
          <Row label="Where">
            {stepLabel}
            <span className="ml-2 font-mono text-xs text-zinc-500">
              {failedStep?.nodeId}
            </span>
          </Row>
        )}
        <Row label="Why">
          {failedStep?.error ?? run.error ?? 'The platform didn’t record a reason.'}
        </Row>
        <Row label="What it means">
          {advice.impact}
          {completedCount > 0 && (
            <>
              {' '}
              {completedCount} step{completedCount === 1 ? '' : 's'} before it
              did finish.
            </>
          )}
        </Row>
        <Row label="What to do">{advice.recommendation}</Row>
      </dl>

      {retryError && (
        <p className="mt-3 text-sm text-status-failed">{retryError}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {advice.action && (
          <Link
            href={advice.action.href}
            className="rounded-lg border border-white/[0.14] px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-white/30 hover:bg-white/[0.06]"
          >
            {advice.action.label}
          </Link>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            title="Starts a new run from the first step. Anything the failed run already did is not undone."
            className="rounded-lg bg-violet px-4 py-2 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-60"
          >
            {retrying ? 'Starting…' : 'Start a new run'}
          </button>
        )}
        <Link
          href={`/workflows/${run.workflowId}`}
          className="text-sm font-medium text-zinc-400 hover:text-white"
        >
          Open the workflow
        </Link>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        Starting a new run begins at the first step again. It does not continue
        the failed run, and it does not undo anything that already happened —
        check before re-running something that sends messages or moves money.
      </p>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-zinc-200">{children}</dd>
    </div>
  );
}
