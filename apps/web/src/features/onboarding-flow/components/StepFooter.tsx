'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

/** Shared Back/Continue bar. `continueDisabled` renders the button visibly
 * disabled rather than hiding it — a missing button reads as broken, a
 * disabled one reads as "not yet". */
export function StepFooter({
  onBack,
  onContinue,
  continueLabel = 'Continue →',
  continueDisabled = false,
  backLabel = 'Back',
  hideBack = false,
  extra,
}: {
  onBack?: () => void;
  onContinue: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  backLabel?: string;
  hideBack?: boolean;
  /** e.g. a "Skip for now" link, rendered between Back and Continue. */
  extra?: ReactNode;
}) {
  return (
    <div className="mt-8 flex items-center justify-between gap-3">
      {!hideBack ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border border-white/[0.1] bg-white/[0.02] px-5 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-white/[0.2] hover:bg-white/[0.05]"
        >
          {backLabel}
        </button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-4">
        {extra}
        <Button variant="violet" onClick={onContinue} disabled={continueDisabled}>
          {continueLabel}
        </Button>
      </div>
    </div>
  );
}
