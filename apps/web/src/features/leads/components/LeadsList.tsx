'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { LeadStatus } from '@vaep/types';
import { useLeads } from '../hooks';

const FILTERS: Array<{ value: LeadStatus | undefined; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'NEW', label: 'New' },
  { value: 'QUALIFIED', label: 'Qualified' },
  { value: 'HOT', label: 'Hot' },
  { value: 'NURTURE', label: 'Nurture' },
  { value: 'DISQUALIFIED', label: 'Disqualified' },
  { value: 'CONVERTED', label: 'Converted' },
];

const STATUS_STYLE: Record<LeadStatus, string> = {
  NEW: 'bg-app-raised text-app-ink-3',
  QUALIFIED: 'bg-violet/15 text-violet-bright',
  HOT: 'bg-status-warning/15 text-sl-warning',
  NURTURE: 'bg-app-raised text-app-ink-3',
  DISQUALIFIED: 'bg-status-failed/15 text-sl-failed',
  CONVERTED: 'bg-status-succeeded/15 text-sl-succeeded',
};

const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  HOT: 'Hot',
  NURTURE: 'Nurture',
  DISQUALIFIED: 'Disqualified',
  CONVERTED: 'Converted',
};

/**
 * The leads list — who has come in through the WhatsApp Sales AI Employee,
 * their status, and where they came from. Read-only (§`lead:read`): this is a
 * visibility screen, not a CRM editor.
 */
export function LeadsList() {
  const [status, setStatus] = useState<LeadStatus | undefined>(undefined);
  const { data, isLoading, isError, error } = useLeads(status);
  const leads = data ?? [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            onClick={() => setStatus(f.value)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              status === f.value
                ? 'bg-violet text-white'
                : 'border border-app-border text-app-ink-2 hover:text-app-ink'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">{error?.message ?? 'Could not load leads'}</p>
      ) : leads.length === 0 ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-6 text-center">
          <p className="text-sm text-app-ink-2">No leads yet.</p>
          <p className="mt-1 text-xs text-app-ink-3">
            Prospects your WhatsApp Sales AI Employee talks to will show up here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {leads.map((lead) => (
            <li key={lead.id}>
              <Link
                href={`/leads/${lead.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-app-border bg-app-surface p-4 transition-colors hover:bg-app-raised"
              >
                <div className="min-w-0">
                  <p className="font-medium text-app-ink">{lead.name ?? lead.phone}</p>
                  <p className="text-xs text-app-ink-3">
                    {lead.name && `${lead.phone} · `}
                    <span className="capitalize">{lead.source.toLowerCase()}</span>
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[lead.status]}`}
                >
                  {STATUS_LABEL[lead.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
