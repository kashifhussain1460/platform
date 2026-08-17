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
  // Independent of the active tab so the "Pending (N)" pill stays accurate.
  const { data: pending } = useApprovals('PENDING');
  const { data: requests, isLoading } = useApprovals(tab);

  return (
    <div className="space-y-4">
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

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading approvals…</p>
      ) : !requests || requests.length === 0 ? (
        <p className="text-sm text-app-ink-3">
          {tab === 'PENDING'
            ? 'No pending approvals. High-risk actions will appear here for review.'
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
