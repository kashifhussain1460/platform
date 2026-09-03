'use client';

import type { LeaveRequestDto } from '@vaep/types';
import { useDecideLeave, useLeave, useStaff } from '../hooks';
import { humanise } from './StaffRoster';

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-status-warning/15 text-sl-warning',
  APPROVED: 'bg-status-active/15 text-sl-active',
  REJECTED: 'bg-status-failed/15 text-sl-failed',
  CANCELLED: 'bg-app-raised text-app-ink-3',
};

function formatRange(start: string, end: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  const from = new Date(start).toLocaleDateString(undefined, opts);
  const to = new Date(end).toLocaleDateString(undefined, opts);
  return from === to ? from : `${from} – ${to}`;
}

/**
 * Time off: who asked, for how long, and the decision.
 *
 * ## The reason field is not shown by default
 *
 * `LeaveRequest.reason` is doubly marked in the schema (🔒🔒) because it is
 * special-category HEALTH data — "hospital appointment", "chemotherapy" — and
 * it is encrypted at rest for that reason. A queue that prints everyone's
 * medical circumstances in a list, on a screen an admin leaves open, would
 * undo the point of encrypting it. It is revealed per row, on a deliberate
 * click, so reading it is a choice someone makes rather than something that
 * happens to them.
 */
export function LeaveQueue({ staffId }: { staffId: string | null }) {
  const { data: leave, isLoading } = useLeave(staffId ?? undefined);
  const { data: staff } = useStaff();
  const decide = useDecideLeave();

  const nameOf = (id: string) =>
    staff?.find((s) => s.id === id)?.fullName ?? 'Unknown person';

  const pending = (leave ?? []).filter((l) => l.status === 'PENDING');
  const decided = (leave ?? []).filter((l) => l.status !== 'PENDING');

  const row = (request: LeaveRequestDto) => (
    <li key={request.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-app-ink">{nameOf(request.staffId)}</p>
          <span className="rounded-full bg-app-raised px-2 py-0.5 text-xs text-app-ink-2">
            {humanise(request.leaveType)}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_STYLE[request.status] ?? 'bg-app-raised text-app-ink-2'
            }`}
          >
            {humanise(request.status)}
          </span>
        </div>
        <p className="mt-1 text-xs text-app-ink-2">
          {formatRange(request.startDate, request.endDate)} · {request.days}{' '}
          {request.days === 1 ? 'day' : 'days'}
        </p>
        {request.reason && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-app-ink-3 hover:text-app-ink-2">
              Show reason
            </summary>
            <p className="mt-1 rounded-lg bg-app-raised p-2 text-xs text-app-ink-2">
              {request.reason}
            </p>
          </details>
        )}
        {request.approvalRequestId && (
          // A leave request can be gated through the Approval Center. Saying so
          // stops an admin wondering why the buttons are not the whole story.
          <p className="mt-1 text-xs text-app-ink-3">
            Also queued in the Approval Center.
          </p>
        )}
      </div>

      {request.status === 'PENDING' && (
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => decide.mutate({ id: request.id, status: 'APPROVED' })}
            disabled={decide.isPending}
            className="rounded-lg bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-60"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => decide.mutate({ id: request.id, status: 'REJECTED' })}
            disabled={decide.isPending}
            className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-500/20 disabled:opacity-60"
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );

  if (isLoading) return <p className="text-sm text-app-ink-3">Loading time off…</p>;

  if (!leave || leave.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-app-border p-6 text-center">
        <p className="text-sm text-app-ink-2">No time-off requests.</p>
        <p className="mt-1 text-xs text-app-ink-3">
          Requests appear here when someone asks for leave, or when your HR AI
          Employee logs one from an email.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {decide.isError && (
        <p className="text-sm text-sl-failed">{decide.error.message}</p>
      )}
      {pending.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-app-ink-2">
            Waiting for a decision ({pending.length})
          </h3>
          <ul className="divide-y divide-app-border rounded-2xl border border-app-border bg-app-surface">
            {pending.map(row)}
          </ul>
        </div>
      )}
      {decided.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-app-ink-2">Already decided</h3>
          <ul className="divide-y divide-app-border rounded-2xl border border-app-border bg-app-surface">
            {decided.map(row)}
          </ul>
        </div>
      )}
    </div>
  );
}
