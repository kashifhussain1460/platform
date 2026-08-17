'use client';

import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { MessageDto } from '@vaep/types';
import { ToolCallsPanel } from '@/features/skills/components/ToolCallsPanel';
import { useSubmitFeedback } from '../hooks';
import { SourcesPanel } from './SourcesPanel';

/**
 * A single chat turn. User turns align right; assistant turns show runtime
 * metadata plus subtle 👍/👎 feedback + a "Teach…" action (Step 15). A 👎 or a
 * taught correction becomes durable employee memory the runtime later recalls.
 */
export function MessageBubble({
  message,
  employeeId,
}: {
  message: MessageDto;
  employeeId: string;
}) {
  const isUser = message.role === 'USER';
  const toolCalls = message.metadata?.toolCalls ?? [];
  const feedback = useSubmitFeedback(employeeId);
  const [rated, setRated] = useState<'UP' | 'DOWN' | null>(null);
  const [teaching, setTeaching] = useState(false);
  const [correction, setCorrection] = useState('');

  // A temp (optimistic) assistant message has no server id yet — don't rate it.
  const canRate = !isUser && !message.id.startsWith('temp_');

  const rate = (rating: 'UP' | 'DOWN') => {
    setRated(rating);
    feedback.mutate({
      conversationId: message.conversationId,
      messageId: message.id,
      rating,
    });
  };

  const submitTeach = () => {
    const text = correction.trim();
    if (!text) return;
    feedback.mutate({
      conversationId: message.conversationId,
      messageId: message.id,
      rating: 'DOWN',
      correction: text,
      teach: true,
    });
    setRated('DOWN');
    setTeaching(false);
    setCorrection('');
  };

  return (
    <div className={`flex items-start gap-2.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet/20 text-violet">
          <Bot className="h-4 w-4" />
        </span>
      )}
      <div className="max-w-[85%]">
        <div
          className={`whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm ${
            isUser
              ? 'bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] text-white'
              : 'border border-app-border bg-app-raised text-app-ink'
          }`}
        >
          {message.content}
        </div>
        {!isUser && toolCalls.length > 0 && (
          <ToolCallsPanel toolCalls={toolCalls} />
        )}
        {!isUser && message.metadata && (
          <SourcesPanel metadata={message.metadata} />
        )}

        {canRate && (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-app-ink-3">
            <button
              type="button"
              aria-label="Good answer"
              className={`rounded px-1 hover:text-green-700 ${
                rated === 'UP' ? 'text-green-700' : ''
              }`}
              disabled={feedback.isPending}
              onClick={() => rate('UP')}
            >
              👍
            </button>
            <button
              type="button"
              aria-label="Bad answer"
              className={`rounded px-1 hover:text-red-600 ${
                rated === 'DOWN' ? 'text-red-600' : ''
              }`}
              disabled={feedback.isPending}
              onClick={() => rate('DOWN')}
            >
              👎
            </button>
            <button
              type="button"
              className="rounded px-1 hover:text-violet"
              onClick={() => setTeaching((t) => !t)}
            >
              Teach…
            </button>
            {rated && !teaching && (
              <span className="text-app-ink-3">Thanks — noted.</span>
            )}
          </div>
        )}

        {canRate && teaching && (
          <div className="mt-1.5 flex gap-2">
            <input
              type="text"
              value={correction}
              onChange={(e) => setCorrection(e.target.value)}
              placeholder="Teach a correction the employee should remember…"
              className="field-modern"
            />
            <button
              type="button"
              className="shrink-0 rounded-lg bg-violet px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={feedback.isPending || !correction.trim()}
              onClick={submitTeach}
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
