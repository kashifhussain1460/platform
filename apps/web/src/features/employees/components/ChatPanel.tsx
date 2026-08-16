'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { AlertTriangle, RotateCcw, Send } from 'lucide-react';
import type { AiEmployeeDto } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useMessages, useSendMessage } from '../hooks';
import { sendMessageSchema, type SendMessageDto } from '../schemas';
import { MessageBubble } from './MessageBubble';
import { ThinkingBubble } from './ThinkingBubble';

/** Message list + composer for one conversation with an employee. */
export function ChatPanel({
  conversationId,
  employee,
}: {
  conversationId: string;
  employee: AiEmployeeDto;
}) {
  const { data: messages } = useMessages(conversationId);
  const send = useSendMessage(conversationId);
  const [failedText, setFailedText] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<SendMessageDto>({
    resolver: zodResolver(sendMessageSchema),
    defaultValues: { content: '' },
  });

  // Chat autoscroll anchor.
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // A SECOND allowed ref: the in-flight guard. `send.isPending` cannot do this
  // job — React applies it on the next render, so two submits in the same tick
  // (a fast double Enter or double click) both read `false` and fire two POSTs.
  // Each POST persists its own user turn, which is how the same question ended
  // up in the thread twice.
  const inFlight = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, send.isPending]);

  const disabled = employee.status !== 'ACTIVE';

  const submit = (content: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailedText(null);
    send.mutate(
      { content },
      {
        onSuccess: () => reset(),
        // Keep what they typed so a failure costs a click, not a retype.
        onError: () => setFailedText(content),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  const onSubmit = handleSubmit((values) => submit(values.content));

  return (
    <section className="flex h-[70vh] flex-col rounded-2xl border border-white/[0.07] bg-white/[0.02]">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {(messages ?? []).length === 0 && !send.isPending ? (
          <p className="text-sm text-zinc-500">
            No messages yet. Say hello to get started.
          </p>
        ) : (
          (messages ?? []).map((m) => (
            <MessageBubble key={m.id} message={m} employeeId={employee.id} />
          ))
        )}
        {send.isPending && <ThinkingBubble name={employee.name} />}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t border-white/[0.07] p-3"
        noValidate
      >
        {disabled && (
          <p className="mb-2 text-sm text-amber-400">
            This employee is {employee.status.toLowerCase()}. Resume it to chat.
          </p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Ask your employee…"
            className="field-modern flex-1"
            disabled={disabled || send.isPending}
            {...register('content')}
          />
          <Button variant="violet" type="submit" disabled={disabled || send.isPending}>
            <Send className="h-4 w-4" />
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </div>
        {errors.content && (
          <p className="mt-1 text-sm text-red-400">{errors.content.message}</p>
        )}
        {failedText && !send.isPending && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-red-400">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span>{send.error?.message ?? 'Message failed'}</span>
            <button
              type="button"
              onClick={() => submit(failedText)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.12] px-2 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/[0.06]"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Try again
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
