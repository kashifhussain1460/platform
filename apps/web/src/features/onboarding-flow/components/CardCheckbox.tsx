import { Check } from 'lucide-react';

/** Persistent checkbox square for multi-select card grids (Goals, Select
 * Employees, recommended Skills) — always visible in both states, not just a
 * checkmark that appears on selection, so the card grid reads as
 * multi-select at a glance. */
export function CardCheckbox({ checked, className = '' }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
        checked ? 'border-violet bg-violet' : 'border-white/25 bg-white/5'
      } ${className}`}
    >
      {checked && <Check className="h-3.5 w-3.5 text-white" />}
    </span>
  );
}
