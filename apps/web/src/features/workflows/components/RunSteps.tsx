import type { WorkflowStepRunDto } from '@vaep/types';
import { NODE_ICONS, NODE_LABELS, NODE_TONES, STEP_STATUS_STYLES } from '../labels';

/** Pretty-print a step's output for the run log (bounded). */
function preview(value: unknown): string {
  if (value == null) {
    return '';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}

/** One WorkflowRun's step-by-step trace — shared by the live run log and the past-runs detail view. */
export function RunSteps({ steps }: { steps: WorkflowStepRunDto[] }) {
  if (steps.length === 0) {
    return <p className="text-sm text-app-ink-3">Waiting for steps…</p>;
  }
  return (
    <ol className="space-y-2">
      {steps.map((step) => {
        const Icon = NODE_ICONS[step.type as keyof typeof NODE_ICONS];
        const tone = NODE_TONES[step.type as keyof typeof NODE_TONES];
        return (
          <li
            key={step.id}
            className="rounded-xl border border-app-border bg-app-surface p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-app-ink">
                {Icon && (
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${tone ?? 'bg-app-raised text-app-ink-2'}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                )}
                {NODE_LABELS[step.type as keyof typeof NODE_LABELS] ?? step.type}
              </span>
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STEP_STATUS_STYLES[step.status]}`}
              >
                {step.status}
              </span>
            </div>
            {step.error ? (
              <p className="mt-1 text-xs text-red-600">{step.error}</p>
            ) : (
              step.output != null && (
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-app-ink-2">
                  {preview(step.output)}
                </pre>
              )
            )}
          </li>
        );
      })}
    </ol>
  );
}
