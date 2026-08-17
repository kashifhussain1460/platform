'use client';

/**
 * AUTOSAVE STATUS (UX plan §11).
 *
 * The builder saves as you work; the customer never has to press Save. What
 * they DO need is to know it happened — an editor that silently persists is
 * indistinguishable from one that silently loses work.
 *
 * So this reports all four states honestly, including the one people usually
 * hide: a failed save, with a retry that actually retries. `unsaved` is the
 * gap between typing and the debounce firing, and saying so is better than a
 * reassuring "Saved" that isn't true yet.
 */
export type AutosaveState =
  | 'idle'
  | 'unsaved'
  | 'saving'
  | 'saved'
  | 'error'
  | 'conflict';

export function AutosaveStatus({
  state,
  onRetry,
  className = '',
}: {
  state: AutosaveState;
  /** Re-runs the save. Required for `error` to be actionable rather than a shrug. */
  onRetry?: () => void;
  className?: string;
}) {
  if (state === 'idle') return null;

  if (state === 'error') {
    return (
      <span className={`text-sl-failed ${className}`} aria-live="polite">
        Save failed —{' '}
        <button type="button" onClick={onRetry} className="underline hover:no-underline">
          retry
        </button>
      </span>
    );
  }

  if (state === 'conflict') {
    return (
      <span className={`text-sl-waiting ${className}`} aria-live="polite">
        Someone else edited this — reload to see their version
      </span>
    );
  }

  const text =
    state === 'saving'
      ? 'Saving…'
      : state === 'saved'
        ? 'Saved just now'
        : 'Unsaved changes…';

  return (
    <span className={`text-app-ink-3 ${className}`} aria-live="polite">
      {text}
    </span>
  );
}
