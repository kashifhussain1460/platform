'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * "Orlixa is working" — shown over the workflow preview for the whole turn,
 * from the moment a turn starts until the stream's `done` signal.
 *
 * Why an overlay and not just a spinner in the chat: a real build turn can run
 * for a minute or more while the agent reads the knowledge base, drafts, and
 * dry-runs. During that time the preview panel either sits empty or shows the
 * PREVIOUS version of the graph, and both read as "nothing is happening" —
 * people re-send the prompt, which starts a second turn and produces a
 * different workflow. Covering the panel makes the wait legible, and makes the
 * half-built graph underneath unmistakably not-final.
 *
 * It reports the agent's own live `label` rather than a generic "Loading…", so
 * a long wait is explainable ("Reading your HR policy") instead of suspicious,
 * and it counts elapsed seconds so a slow turn never looks like a hung one.
 */
export function AssistBusyOverlay({
  active,
  label,
  /** Steps built so far this turn — proof of progress during a long wait. */
  nodeCount = 0,
}: {
  active: boolean;
  label: string | null;
  nodeCount?: number;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1_000);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  return (
    <div
      // `aria-live` polite, not assertive: it should be announced, but it must
      // not interrupt a screen reader mid-sentence every time the label changes.
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-app-bg/80 backdrop-blur-[2px]"
    >
      <div className="mx-6 max-w-xs text-center">
        <Loader2
          className="mx-auto mb-3 h-7 w-7 animate-spin text-violet"
          aria-hidden
        />
        <p className="text-sm font-medium text-app-ink">
          {label ?? 'Orlixa is working on this…'}
        </p>
        <p className="mt-1.5 text-xs text-app-ink-2">
          {nodeCount > 0
            ? `${nodeCount} ${nodeCount === 1 ? 'step' : 'steps'} so far · ${formatElapsed(elapsed)}`
            : `This can take a minute · ${formatElapsed(elapsed)}`}
        </p>
        <p className="mt-3 text-xs text-app-ink-3">
          You don&apos;t need to send anything else — it will carry on by itself.
        </p>
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${mins}m ${String(rest).padStart(2, '0')}s`;
}
