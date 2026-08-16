'use client';

import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';

/** After this long, silence starts to read as "it broke" rather than "it's working". */
const REASSURE_AFTER_S = 6;

/**
 * The assistant-side placeholder shown while a turn is running.
 *
 * ## Why it says so little
 *
 * A turn really does plan, search knowledge, call tools and then write — but
 * the API is a single POST that returns only when all of it is finished, so the
 * browser has NO way to know which stage is running. Animating through
 * "Searching knowledge… / Using tools…" on a timer would look far better and be
 * fiction: it would claim a knowledge search on an employee with no documents,
 * and show "Writing" while the model was still retrying. What we can honestly
 * show is that work is in progress and how long it has been going.
 *
 * Real per-stage progress needs the turn to stream (server-sent events, as the
 * AI Assist builder already does). That is a backend change, not a spinner.
 */
export function ThinkingBubble({ name }: { name: string }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-start justify-start gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet/20 text-violet-secondary">
        <Bot className="h-4 w-4" />
      </span>
      <div className="max-w-[85%]">
        <div
          className="flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.04] px-3.5 py-3"
          role="status"
          aria-live="polite"
        >
          <span className="flex items-center gap-1" aria-hidden>
            <Dot delay="0ms" />
            <Dot delay="150ms" />
            <Dot delay="300ms" />
          </span>
          <span className="text-sm text-zinc-400">
            {name} is thinking
            {seconds >= 1 ? ` · ${seconds}s` : ''}
          </span>
        </div>
        {seconds >= REASSURE_AFTER_S ? (
          <p className="mt-1.5 text-xs text-zinc-500">
            Still working. A turn that reads documents or uses a skill takes
            longer than a plain reply.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-secondary"
      style={{ animationDelay: delay }}
    />
  );
}
