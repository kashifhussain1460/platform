'use client';

import { AlertTriangle, Check, CircleDashed, Clock, X } from 'lucide-react';
import type { AssistTestResult, AssistTestStep } from '@vaep/types';

/**
 * What happened when the agent test-ran the draft.
 *
 * The **"Simulated" chip is not optional decoration** — it is the honesty
 * contract of this whole feature. The agent is allowed to run a workflow only
 * because the engine short-circuits real side effects under `dryRun`, and the
 * user has to be able to see which steps that applied to. A test that looked
 * like a real send would be worse than no test at all.
 */
export function TestResultPanel({ result }: { result: AssistTestResult }) {
  const tone = TONE[result.status];

  return (
    <div className={`rounded-xl border ${tone.border} ${tone.bg} p-3`}>
      <p className={`mb-2 flex items-center gap-1.5 text-xs font-semibold ${tone.text}`}>
        <tone.Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {result.headline}
      </p>
      <ul className="space-y-1">
        {result.steps.map((step) => (
          <StepRow key={`${step.nodeId}-${step.ms}`} step={step} />
        ))}
      </ul>
    </div>
  );
}

function StepRow({ step }: { step: AssistTestStep }) {
  // Defensive on purpose. `status` arrives over the wire, and when the server
  // sent one this map didn't cover, `<undefined />` crashed the entire assist
  // workspace — a whole screen lost to one unrecognised step. The server side
  // is fixed too; this makes an unknown value cost a generic dot instead.
  const Icon = STEP_ICON[step.status] ?? CircleDashed;
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon
        className={`mt-0.5 h-3 w-3 shrink-0 ${STEP_COLOR[step.status] ?? 'text-app-ink-3'}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="text-app-ink-2">{step.name}</span>
        {step.simulated ? (
          <span
            className="ml-1.5 rounded-full bg-app-raised px-1.5 py-0.5 text-[10px] font-medium text-app-ink-2"
            title="Nothing was really sent — this step was simulated because it was a test run."
          >
            Simulated
          </span>
        ) : null}
        {step.error ? (
          <span className="mt-0.5 block text-sl-failed">{step.error}</span>
        ) : null}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-app-ink-3">
        {step.ms}ms
      </span>
    </li>
  );
}

const TONE = {
  COMPLETED: {
    border: 'border-status-succeeded/30',
    bg: 'bg-status-succeeded/10',
    text: 'text-sl-succeeded',
    Icon: Check,
  },
  // A pause at an approval is the gate WORKING, so it reads as success — not as
  // an incomplete run the user should worry about.
  WAITING: {
    border: 'border-cat-approval/30',
    bg: 'bg-cat-approval/10',
    text: 'text-sl-waiting',
    Icon: AlertTriangle,
  },
  FAILED: {
    border: 'border-status-failed/30',
    bg: 'bg-status-failed/10',
    text: 'text-sl-failed',
    Icon: X,
  },
  TIMED_OUT: {
    border: 'border-status-warning/30',
    bg: 'bg-status-warning/10',
    text: 'text-sl-warning',
    Icon: Clock,
  },
} as const;

/**
 * Both maps are typed `Record<AssistTestStep['status'], …>` rather than
 * inferred. That is the point: the union gained `WAITING` and these went red
 * immediately, instead of shipping a hole that only shows up as a blank screen
 * for whoever's test run happens to pause at an approval.
 */
const STEP_ICON: Record<AssistTestStep['status'], typeof Check> = {
  COMPLETED: Check,
  FAILED: X,
  SKIPPED: CircleDashed,
  RUNNING: CircleDashed,
  WAITING: Clock,
};

const STEP_COLOR: Record<AssistTestStep['status'], string> = {
  COMPLETED: 'text-sl-succeeded',
  FAILED: 'text-sl-failed',
  SKIPPED: 'text-app-ink-3',
  RUNNING: 'text-sl-running',
  WAITING: 'text-sl-waiting',
};
