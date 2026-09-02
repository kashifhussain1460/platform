'use client';

import { useState } from 'react';
import type { ApprovalStatus } from '@vaep/types';
import { useApprovals } from '../hooks';
import { ApprovalCard } from './ApprovalCard';

const TABS: { key: ApprovalStatus; label: string }[] = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

/** The approval queue: Pending (default) / Approved / Rejected tabs, each item Approve/Reject/Modify. */
export function ApprovalList() {
  const [tab, setTab] = useState<ApprovalStatus>('PENDING');
  /**
   * "Waiting on me" vs everything the company is waiting on.
   *
   * The server has supported `?assignedToMe=true` since Wave P3-05 and nothing
   * called it. That was fine while every approval was unrouted — the whole
   * queue was "any admin", so every row was yours. Now that routing is
   * configurable, a company can have dozens of pending approvals of which two
   * are actually yours to decide, and a queue that cannot tell you which is a
   * queue people stop opening.
   *
   * The filter runs SERVER-side through the same `canDecide` the decision
   * endpoint enforces, so this view can never show you something you would then
   * be refused — and never hides something you could actually decide.
   */
  const [mineOnly, setMineOnly] = useState(false);

  // Independent of the active tab so the "Pending (N)" pill stays accurate.
  // Deliberately follows `mineOnly`: a count of everyone's work under a
  // "waiting on me" view is worse than no count.
  const { data: pending } = useApprovals('PENDING', mineOnly);
  const { data: requests, isLoading } = useApprovals(tab, mineOnly);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key
                  ? 'bg-violet text-white'
                  : 'border border-app-border text-app-ink-2 hover:text-app-ink'
              }`}
            >
              {t.key === 'PENDING' ? `Pending (${pending?.length ?? 0})` : t.label}
            </button>
          ))}
        </div>

        <div className="flex gap-1 rounded-xl border border-app-border bg-app-surface p-1">
          <button
            type="button"
            onClick={() => setMineOnly(false)}
            className={`rounded-lg px-3 py-1 text-sm font-medium transition-colors ${
              mineOnly ? 'text-app-ink-2 hover:text-app-ink' : 'bg-violet text-white'
            }`}
          >
            Everyone
          </button>
          <button
            type="button"
            onClick={() => setMineOnly(true)}
            className={`rounded-lg px-3 py-1 text-sm font-medium transition-colors ${
              mineOnly ? 'bg-violet text-white' : 'text-app-ink-2 hover:text-app-ink'
            }`}
          >
            Waiting on me
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading approvals…</p>
      ) : !requests || requests.length === 0 ? (
        <p className="text-sm text-app-ink-3">
          {tab === 'PENDING'
            ? mineOnly
              ? 'Nothing is waiting on you. Switch to “Everyone” to see the whole company’s queue.'
              : 'No pending approvals. High-risk actions will appear here for review.'
            : tab === 'APPROVED'
              ? 'No approved requests yet.'
              : 'No rejected requests yet.'}
        </p>
      ) : (
        <div className="rounded-2xl border border-app-border bg-app-surface">
          <ul className="divide-y divide-app-border">
            {requests.map((request) => (
              <ApprovalCard key={request.id} request={request} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
