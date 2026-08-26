'use client';

import { useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { creditBadgeState } from './CreditBadge';
import { useCreditBalance } from '@/features/billing/credits-hooks';

/**
 * §21's Critical-state notification — deliberately the FIRST and, for now,
 * ONLY entry in what will eventually be a real notification center (none
 * exists yet anywhere in this app). Building a full notification-center
 * subsystem (persisted log, read/unread, bell dropdown) is out of scope for
 * this one credit-balance signal — this is a session-dismissible banner, not
 * a claim that the larger system now exists.
 */
export function CreditCriticalBanner() {
  const { data } = useCreditBalance();
  const [dismissed, setDismissed] = useState(false);

  if (!data || dismissed) return null;
  const state = creditBadgeState(data.balance, data.trailingMonthlyDebits);
  if (state !== 'critical') return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-orange-500/15 px-6 py-2 text-sm text-orange-800 sm:px-10">
      <span>
        Your credit balance is critically low.{' '}
        <Link href="/billing#buy-credits" className="font-semibold underline underline-offset-2">
          Buy credits
        </Link>{' '}
        to avoid an interruption.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 hover:bg-black/5"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
