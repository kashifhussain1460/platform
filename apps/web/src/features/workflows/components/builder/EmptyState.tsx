import type { ReactNode } from 'react';

/**
 * EmptyState — the builder's canonical "nothing here yet" surface (doc 29 §2.8).
 * An empty screen is an invitation to act, never a dead end: a quiet icon, a plain
 * title, one line of guidance, and a single primary action. Dark-surface tokens.
 *
 * Copy is passed in (user-side, active voice) — this component never invents it.
 */
export interface EmptyStateProps {
  /** Optional decorative glyph (already sized/coloured by the caller). */
  icon?: ReactNode;
  /** What's empty, in the user's words — e.g. "No workflows yet". */
  title: string;
  /** One line of guidance — what this is / why act. */
  body?: string;
  /** The primary invitation (a Button/link). Omit for a purely informational empty. */
  action?: ReactNode;
  /** 'panel' (compact, docked panels) or 'page' (full-height route empty). */
  size?: 'panel' | 'page';
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  size = 'panel',
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={[
        'flex flex-col items-center justify-center text-center',
        size === 'page' ? 'min-h-[60vh] gap-4 px-6' : 'gap-3 px-4 py-10',
      ].join(' ')}
    >
      {icon ? (
        <div className="text-wf-ink-3" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <p className="font-display text-base font-semibold text-wf-ink">{title}</p>
      {body ? (
        <p className="max-w-prose text-sm text-wf-ink-2">{body}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
