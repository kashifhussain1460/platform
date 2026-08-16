'use client';

import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Send, Square } from 'lucide-react';
import type { AssistSessionDto } from '@vaep/types';
import {
  AssistantBubble,
  PersistedMessage,
  ThinkingBlock,
  UnresolvedList,
  UserBubble,
} from './AssistMessage';
import { SkillRequirementCard } from './SkillRequirementCard';
import { TestResultPanel } from './TestResultPanel';
import type { AssistStreamState } from '../useAssistStream';

/**
 * The conversation. Renders persisted turns from the session, plus the in-flight
 * turn straight from the stream state.
 *
 * The in-flight turn is rendered SEPARATELY from the persisted list rather than
 * being optimistically spliced into it — once the turn finishes the session
 * refetches and the real message takes its place. Splicing would risk showing
 * the same turn twice during that handover.
 */
export function AssistChat({
  session,
  stream,
  onSend,
  onStop,
  onStartOver,
}: {
  session: AssistSessionDto;
  stream: AssistStreamState;
  onSend: (text: string) => void;
  onStop: () => void;
  onStartOver: () => void;
}) {
  const [input, setInput] = useState('');
  const streaming = stream.status === 'streaming';

  // While a turn is streaming the persisted list does NOT yet contain the user's
  // words, so show them from the last USER message only after it lands. Until
  // then the optimistic echo lives here.
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);
  useEffect(() => {
    if (!streaming) setPendingUserText(null);
  }, [streaming]);

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setPendingUserText(text);
    onSend(text);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageList
        session={session}
        stream={stream}
        pendingUserText={pendingUserText}
        // Resume = re-run the turn with no new text; the agent picks up the draft
        // and continues now that a skill is connected (no re-typing the prompt).
        onResume={() => onSend('')}
      />

      <div className="mt-3 shrink-0 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline — the convention every chat
            // uses, so doing anything else is a papercut.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={streaming}
          placeholder={streaming ? 'Orlixa is working…' : 'Tell me what to change…'}
          aria-label="Message Orlixa"
          className="w-full resize-none bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="mt-2 flex items-center justify-between border-t border-white/[0.06] pt-2">
          <button
            type="button"
            onClick={onStartOver}
            disabled={streaming}
            className="flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" aria-hidden />
            Start over
          </button>
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              className="flex items-center gap-1.5 rounded-lg border border-white/[0.12] px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.06]"
            >
              <Square className="h-3 w-3" aria-hidden />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!input.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-violet px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet/90 disabled:cursor-not-allowed disabled:bg-violet/30 disabled:text-white/50"
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageList({
  session,
  stream,
  pendingUserText,
  onResume,
}: {
  session: AssistSessionDto;
  stream: AssistStreamState;
  pendingUserText: string | null;
  onResume: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stick to the bottom UNLESS the user has scrolled up to read — yanking them
  // back down mid-read is the most common chat annoyance.
  const pinnedRef = useRef(true);

  const streaming = stream.status === 'streaming';

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (pinnedRef.current) {
      endRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [session.messages.length, stream.text, stream.thinking]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      {session.messages.map((m, i) => (
        <PersistedMessage
          key={m.id}
          message={m}
          onResume={onResume}
          resuming={streaming}
          // Only the LAST message may carry on by itself: that is the one the
          // conversation is waiting on. An older skill card is history, and
          // auto-resuming from it would start a turn nobody asked for every
          // time the conversation was reopened.
          autoResume={i === session.messages.length - 1}
        />
      ))}

      {pendingUserText ? <UserBubble text={pendingUserText} /> : null}

      {streaming || stream.text ? (
        <div className="space-y-2">
          <ThinkingBlock
            label={stream.thinking}
            trace={stream.trace}
            live={streaming}
          />
          {/* Test results BEFORE the reply: the agent's summary refers to them,
              so reading them in that order is what makes the summary make sense. */}
          {stream.tests.map((t) => (
            <TestResultPanel key={t.runId} result={t} />
          ))}
          {stream.text ? (
            <AssistantBubble text={stream.text} streaming={streaming} />
          ) : null}
          {!streaming && stream.graph ? (
            <UnresolvedList items={stream.graph.unresolved} />
          ) : null}
          {/* The in-chat Skill card for the turn in flight. Once the turn lands
              and the session refetches, the persisted CONNECTION message renders
              it instead — this block vanishes with the streamed text. */}
          {stream.connection ? (
            <SkillRequirementCard
              requirements={stream.connection.requirements}
              sessionId={session.id}
              onResume={onResume}
              resuming={streaming}
              // The turn in flight is by definition what we're waiting on.
              autoResume
            />
          ) : null}
        </div>
      ) : null}

      {stream.error ? (
        <div className="rounded-xl border border-status-failed/30 bg-status-failed/10 p-3">
          <p className="text-sm text-status-failed">{stream.error.message}</p>
        </div>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
