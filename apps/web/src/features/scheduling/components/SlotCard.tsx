'use client';

import { useState } from 'react';
import type { InterviewSlotDto } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useCancelSlot, useRescheduleSlot } from '../hooks';
import { STATUS_STYLES, formatStatus } from '../labels';

const secondaryBtnClass =
  'rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50';

/** A single interview slot: Cancel (OPEN) or Reschedule (BOOKED). */
export function SlotCard({ slot }: { slot: InterviewSlotDto }) {
  const cancel = useCancelSlot();
  const reschedule = useRescheduleSlot();
  const [rescheduling, setRescheduling] = useState(false);
  const [title, setTitle] = useState('');

  const busy = cancel.isPending || reschedule.isPending;

  const submitReschedule = () => {
    reschedule.mutate(
      { id: slot.id, data: title.trim() ? { title: title.trim() } : undefined },
      { onSuccess: () => setRescheduling(false) },
    );
  };

  return (
    <li className="rounded-2xl border border-app-border bg-app-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-app-ink">
              {new Date(slot.start).toLocaleString()} –{' '}
              {new Date(slot.end).toLocaleTimeString()}
            </p>
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[slot.status]}`}
            >
              {formatStatus(slot.status)}
            </span>
          </div>
          {slot.bookedFor && (
            <p className="mt-0.5 text-xs text-app-ink-3">
              Candidate: {slot.bookedFor}
            </p>
          )}
          {slot.meetLink && (
            <p className="mt-0.5 text-xs">
              <a
                href={slot.meetLink}
                target="_blank"
                rel="noreferrer"
                className="text-violet hover:text-app-ink hover:underline"
              >
                Meet link
              </a>
            </p>
          )}
          {slot.cancelReason && (
            <p className="mt-0.5 text-xs text-app-ink-3">
              Reason: {slot.cancelReason}
            </p>
          )}
        </div>
      </div>

      {reschedule.isError && (
        <p className="mt-2 text-sm text-red-600">
          {reschedule.error?.message ?? 'Could not reschedule'}
        </p>
      )}
      {cancel.isError && (
        <p className="mt-2 text-sm text-red-600">
          {cancel.error?.message ?? 'Could not cancel'}
        </p>
      )}

      {slot.status === 'OPEN' && (
        <div className="mt-3">
          <button className={secondaryBtnClass} onClick={() => cancel.mutate(slot.id)} disabled={busy}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      )}

      {slot.status === 'BOOKED' &&
        (rescheduling ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              className="field-modern w-auto flex-1"
              placeholder="Meeting title (optional)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Button variant="violet" onClick={submitReschedule} disabled={busy}>
              {reschedule.isPending ? 'Rescheduling…' : 'Book new slot'}
            </Button>
            <button className={secondaryBtnClass} onClick={() => setRescheduling(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <button className={secondaryBtnClass} onClick={() => setRescheduling(true)} disabled={busy}>
              Reschedule
            </button>
          </div>
        ))}
    </li>
  );
}
