import type { ReactNode } from 'react';

/** A checkbox-driven selectable card — department picker, role picker. */
export function ToggleCard({
  checked,
  onChange,
  children,
  className = '',
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors ${
        checked
          ? 'border-violet-secondary/60 bg-violet/[0.08]'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]'
      } ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-5 w-5 shrink-0 rounded-md border-white/20 bg-white/5 accent-[#6a30ec]"
      />
      {children}
    </label>
  );
}

/**
 * A labelled field with an icon inside the control and optional helper text.
 *
 * The icon is `aria-hidden` and the label stays a real `<label>`: the picture is
 * a landmark for someone scanning the form, never the name of the field. A
 * screen reader announces "Company size", not "people icon".
 */
export function IconField({
  id,
  label,
  optional,
  hint,
  icon,
  children,
}: {
  id: string;
  label: string;
  /** Rendered as a quieter suffix, so "optional" reads as part of the label. */
  optional?: boolean;
  hint?: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-zinc-300">
        {label}
        {optional && <span className="font-normal text-fg-muted"> (optional)</span>}
      </label>
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-violet-secondary"
        >
          {icon}
        </span>
        {children}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-fg-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
