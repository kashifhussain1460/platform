import type { ReactNode } from 'react';

/**
 * DisabledControl — wraps a control so a disabled state ALWAYS explains itself
 * (doc 29 §2 / §3.G): a disabled button is never a dead end with no reason. When
 * `disabled`, the reason surfaces as a hover/focus tooltip + an accessible label
 * (and optionally inline for forms). When enabled, it renders the child untouched.
 *
 * The caller still sets the child's own `disabled` — this only guarantees the WHY
 * is discoverable. Reason copy is user-side (e.g. "Publish once the workflow is
 * valid", "You don't have permission to run this workflow").
 */
export interface DisabledControlProps {
  disabled: boolean;
  /** Why it's disabled, in the user's words. Required whenever `disabled`. */
  reason: string;
  children: ReactNode;
  /** Also render the reason as inline helper text below the control. */
  inline?: boolean;
}

export function DisabledControl({
  disabled,
  reason,
  children,
  inline = false,
}: DisabledControlProps) {
  if (!disabled) return <>{children}</>;
  return (
    <span className="inline-flex flex-col gap-1">
      <span
        className="inline-flex cursor-not-allowed"
        title={reason}
        aria-label={reason}
      >
        {children}
      </span>
      {inline ? (
        <span className="text-xs text-app-ink-3" role="note">
          {reason}
        </span>
      ) : null}
    </span>
  );
}
