'use client';

import type { LeadStatus } from '@vaep/types';
import { MessageBubble } from '@/features/employees/components/MessageBubble';
import { useLead } from '../hooks';

const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  HOT: 'Hot',
  NURTURE: 'Nurture',
  DISQUALIFIED: 'Disqualified',
  CONVERTED: 'Converted',
};

/**
 * One lead: their details plus the full conversation thread that produced
 * them. Reuses `MessageBubble` from the employee chat view rather than
 * building a second message renderer — same messages, same shape, no reason
 * for two components to draw them differently.
 */
export function LeadDetail({ id }: { id: string }) {
  const { data: lead, isLoading, isError, error } = useLead(id);

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading…</p>;
  }
  if (isError) {
    return (
      <p className="text-sm text-red-600">{error?.message ?? 'Could not load this lead'}</p>
    );
  }
  if (!lead) {
    return null;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-app-border bg-app-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-app-ink">
              {lead.name ?? lead.phone}
            </h2>
            <p className="text-sm text-app-ink-3">{lead.phone}</p>
          </div>
          <span className="shrink-0 rounded-full bg-violet/15 px-2 py-0.5 text-[11px] font-medium text-violet-bright">
            {STATUS_LABEL[lead.status]}
          </span>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-app-ink-3">Source</dt>
            <dd className="text-sm capitalize text-app-ink">{lead.source.toLowerCase()}</dd>
          </div>
          <div>
            <dt className="text-xs text-app-ink-3">Email</dt>
            <dd className="text-sm text-app-ink">{lead.email ?? 'Not provided'}</dd>
          </div>
          <div>
            <dt className="text-xs text-app-ink-3">First contacted</dt>
            <dd className="text-sm text-app-ink">
              {new Date(lead.createdAt).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-app-ink-3">Last contacted</dt>
            <dd className="text-sm text-app-ink">
              {lead.lastContactedAt
                ? new Date(lead.lastContactedAt).toLocaleString()
                : 'Never'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-2xl border border-app-border bg-app-surface">
        <h3 className="border-b border-app-border p-4 text-sm font-semibold text-app-ink">
          Conversation
        </h3>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto p-4">
          {!lead.conversation ? (
            <p className="text-sm text-app-ink-3">No conversation on this lead yet.</p>
          ) : lead.conversation.messages.length === 0 ? (
            <p className="text-sm text-app-ink-3">No messages yet.</p>
          ) : (
            lead.conversation.messages.map((m) => (
              <MessageBubble key={m.id} message={m} employeeId={lead.conversation!.employeeId} />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
