import type { WorkflowRunDto } from '@vaep/types';

/**
 * §22 CREATE NEW — execution-detail credit panel (Task 9.6). Shows the run's
 * total settled spend against its configured cap, and each step's actual
 * `creditsCharged` (null/zero for control-flow nodes like WAIT/CONDITION,
 * which never reserve). Only the actually-tracked figures are shown — this
 * codebase doesn't retain a per-step estimated/refunded breakdown once a
 * reservation settles, so this panel doesn't invent one.
 */
export function RunCreditPanel({ run }: { run: WorkflowRunDto }) {
  const billableSteps = (run.steps ?? []).filter((s) => s.creditsCharged != null);

  return (
    <div className="rounded-2xl border border-app-border bg-app-surface p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-app-ink">Credits</h3>
        <p className="text-sm tabular-nums text-app-ink-2">
          {run.totalCreditsCharged.toLocaleString()}
          {run.creditLimit !== null && (
            <span className="text-app-ink-3"> / {run.creditLimit.toLocaleString()} limit</span>
          )}
        </p>
      </div>

      {billableSteps.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {billableSteps.map((step) => (
            <li key={step.id} className="flex items-center justify-between text-xs">
              <span className="text-app-ink-2">
                {step.nodeId} <span className="text-app-ink-3">({step.type})</span>
              </span>
              <span className="tabular-nums text-app-ink">{step.creditsCharged}</span>
            </li>
          ))}
        </ul>
      )}
      {billableSteps.length === 0 && (
        <p className="mt-3 text-xs text-app-ink-3">No billable steps in this run yet.</p>
      )}
    </div>
  );
}
