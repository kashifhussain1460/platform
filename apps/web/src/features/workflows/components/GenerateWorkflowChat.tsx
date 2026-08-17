'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GenerateWorkflowMessageDto } from '@vaep/types';
import { useCreateWorkflow, useGenerateWorkflowDraft } from '../hooks';

const primaryBtnClass =
  'inline-flex items-center justify-center rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_14px_34px_-12px_rgba(91,33,230,0.85)] transition-all duration-200 hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60';
const secondaryBtnClass =
  'rounded-xl border border-app-border-strong bg-app-surface px-4 py-2 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50';

/**
 * "Generate with AI" chat: a short back-and-forth (AI may ask up to a few
 * questions), then a ready draft gets created as a normal DRAFT-status
 * workflow (via the existing create endpoint) and the caller navigates to its
 * builder page. Nothing here is persisted except that final, accepted create.
 */
export function GenerateWorkflowChat({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [messages, setMessages] = useState<GenerateWorkflowMessageDto[]>([]);
  const [input, setInput] = useState('');
  const generate = useGenerateWorkflowDraft();
  const create = useCreateWorkflow();

  const busy = generate.isPending || create.isPending;

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    generate.mutate(next, {
      onSuccess: (result) => {
        if (result.type === 'question') {
          setMessages((prev) => [...prev, { role: 'assistant', content: result.message }]);
          return;
        }
        create.mutate(
          { name: 'AI-drafted workflow', definition: result.definition },
          {
            onSuccess: (workflow) => {
              const unresolved = result.unresolvedNodes.map((n) => n.nodeId);
              const suffix = unresolved.length
                ? `?unresolved=${encodeURIComponent(unresolved.join(','))}`
                : '';
              router.push(`/workflows/${workflow.id}${suffix}`);
            },
          },
        );
      },
    });
  };

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-app-ink-2">Generate with AI</h2>
        <button type="button" onClick={onClose} className="text-sm text-app-ink-3 hover:text-app-ink-2">
          Close
        </button>
      </div>

      {messages.length > 0 && (
        <ul className="mb-4 space-y-2">
          {messages.map((m, i) => (
            <li
              key={i}
              className={`max-w-[85%] rounded-xl px-3.5 py-2 text-sm ${
                m.role === 'user'
                  ? 'ml-auto bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] text-white'
                  : 'bg-app-raised text-app-ink-2'
              }`}
            >
              {m.content}
            </li>
          ))}
        </ul>
      )}

      {generate.isError && (
        <p className="mb-3 text-sm text-red-600">
          {generate.error?.message ?? 'Could not generate a draft'}
        </p>
      )}
      {create.isError && (
        <p className="mb-3 text-sm text-red-600">
          {create.error?.message ?? 'Could not save the draft'}
        </p>
      )}

      <div className="flex gap-2">
        <input
          className="field-modern flex-1"
          placeholder="Describe what this workflow should do…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          disabled={busy}
        />
        <button type="button" className={primaryBtnClass} onClick={send} disabled={busy || !input.trim()}>
          {busy ? 'Working…' : 'Send'}
        </button>
        {messages.length > 0 && (
          <button
            type="button"
            className={secondaryBtnClass}
            onClick={() => setMessages([])}
            disabled={busy}
          >
            Start over
          </button>
        )}
      </div>
    </section>
  );
}
