'use client';

import { useState } from 'react';
import type { HandoffRequestDto } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useHandoffs, useResolveHandoff } from '../hooks';

/**
 * The human handoff inbox — conversations an AI Employee stepped back from.
 *
 * ## Why this screen exists
 *
 * `POST /support/conversations/:id/escalate` and `POST /handoffs/:id/resolve`
 * both shipped, and nothing listed the queue between them. An AI could hand a
 * customer conversation to a human, and that human had no screen showing it.
 * An escalation nobody can see is the same defect as an approval nobody can
 * see — the control exists and does not reach anyone.
 *
 * The queue shows EVERY pending handoff, not just this user's. A support
 * queue that hides work from a colleague who could pick it up is a queue that
 * stalls. Rows this person cannot action say so, and the server enforces it.
 */
function HandoffCard({ handoff }: { handoff: HandoffRequestDto }) {
  const resolve = useResolveHandoff();
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const messages = handoff.conversation?.recentMessages ?? [];

  const act = (resume: boolean) =>
    resolve.mutate({ id: handoff.id, body: { resume, note: note.trim() || undefined } });

  return (
    <li className="rounded-2xl border border-app-border bg-app-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-app-ink">
            {handoff.conversation?.contactEmail ?? 'Customer conversation'}
          </p>
          {/* The reason the AI gave. This is the whole point of the row. */}
          <p className="mt-0.5 text-sm text-app-ink-2">{handoff.reason}</p>
          <p className="mt-1 text-xs text-app-ink-3">
            Escalated {new Date(handoff.createdAt).toLocaleString()}
            {handoff.conversation &&
              ` · last message ${new Date(handoff.conversation.lastMessageAt).toLocaleString()}`}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            handoff.status === 'PENDING'
              ? 'bg-status-warning/15 text-sl-warning'
              : 'bg-app-raised text-app-ink-3'
          }`}
        >
          {handoff.status === 'PENDING' ? 'Waiting for a human' : handoff.status}
        </span>
      </div>

      {messages.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            className="text-xs font-medium text-app-ink-3 hover:text-app-ink"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide conversation' : `Show last ${messages.length} messages`}
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1.5">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={`rounded-lg px-3 py-2 text-sm ${
                    m.direction === 'IN'
                      ? 'bg-app-raised text-app-ink-2'
                      : 'bg-violet/10 text-app-ink'
                  }`}
                >
                  <span className="mr-2 text-[11px] uppercase tracking-wide text-app-ink-3">
                    {m.direction === 'IN' ? 'Customer' : 'AI'}
                  </span>
                  {m.body}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {handoff.status === 'PENDING' &&
        (handoff.canResolve ? (
          <div className="mt-4 space-y-2">
            <input
              className="field-modern"
              placeholder="Note (optional) — what did you do?"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
            {resolve.isError && (
              <p className="text-sm text-red-600">
                {resolve.error?.message ?? 'Could not resolve this handoff'}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {/* Two genuinely different outcomes, named for what they do to
                  the conversation rather than to the handoff record. */}
              <Button
                type="button"
                variant="violet"
                disabled={resolve.isPending}
                onClick={() => act(true)}
              >
                {resolve.isPending ? 'Saving…' : 'Hand back to the AI'}
              </Button>
              <button
                type="button"
                className="rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 transition-colors hover:bg-app-raised disabled:opacity-50"
                disabled={resolve.isPending}
                onClick={() => act(false)}
              >
                Close the conversation
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-xs text-app-ink-3">
            This one was routed to someone else. You can see it, but they need to
            action it.
          </p>
        ))}

      {handoff.status !== 'PENDING' && handoff.note && (
        <p className="mt-3 text-xs text-app-ink-3">Note: {handoff.note}</p>
      )}
    </li>
  );
}

export function HandoffInbox() {
  const [mine, setMine] = useState(false);
  const [status, setStatus] = useState<'PENDING' | 'RESOLVED'>('PENDING');
  const { data, isLoading, isError, error } = useHandoffs(status, mine);
  const rows = data ?? [];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['PENDING', 'RESOLVED'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              status === s
                ? 'bg-violet text-white'
                : 'border border-app-border text-app-ink-2 hover:text-app-ink'
            }`}
          >
            {s === 'PENDING' ? 'Waiting' : 'Done'}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-2 text-xs text-app-ink-2">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-app-border bg-app-raised accent-[#6a30ec]"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
          />
          Only ones I can action
        </label>
      </div>

      {isLoading ? (
        <p className="text-sm text-app-ink-3">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          {error?.message ?? 'Could not load the handoff queue'}
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-6 text-center">
          <p className="text-sm text-app-ink-2">
            {status === 'PENDING'
              ? 'Nothing waiting for a human right now.'
              : 'Nothing resolved yet.'}
          </p>
          <p className="mt-1 text-xs text-app-ink-3">
            Your Support AI Employee escalates here when it decides a person should
            take over.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((h) => (
            <HandoffCard key={h.id} handoff={h} />
          ))}
        </ul>
      )}
    </section>
  );
}
