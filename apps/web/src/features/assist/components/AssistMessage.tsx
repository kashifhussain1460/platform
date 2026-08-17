'use client';

import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Check, ChevronRight, Wrench, X } from 'lucide-react';
import type {
  AssistMessageDto,
  AssistTestResult,
  AssistToolTraceDto,
  WorkflowSkillRequirementDto,
} from '@vaep/types';
import { TestResultPanel } from './TestResultPanel';
import { SkillRequirementCard } from './SkillRequirementCard';

/**
 * Assistant text is rendered as markdown — bold, lists, inline code and links
 * all appear in real explanations, and showing the raw characters looks broken.
 *
 * ⚠️ `rehype-raw` is deliberately NOT used. react-markdown v10 renders no raw
 * HTML by default, and that default is doing real security work here: this text
 * comes from a language model that has read tenant-controlled content. Never
 * enable raw HTML on a surface that renders model output.
 */
const MARKDOWN_PLUGINS = [remarkGfm];

const PROSE =
  'space-y-2 text-sm leading-relaxed text-app-ink [&_a]:text-violet [&_a]:underline [&_code]:rounded [&_code]:bg-app-raised [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_li]:ml-4 [&_li]:list-disc [&_strong]:font-semibold [&_strong]:text-app-ink';

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      {/* Solid violet, not `violet/25`. At 25% over the light canvas the bubble
          is pale lavender, and the white text on it measured 1.06 — the user's
          own message was very nearly invisible. Full strength keeps the "this
          one is mine" cue and carries white at 6.39. */}
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-violet px-3.5 py-2.5 text-sm text-white">
        {text}
      </p>
    </div>
  );
}

export function AssistantBubble({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className={PROSE}>
      <Markdown remarkPlugins={MARKDOWN_PLUGINS}>{text}</Markdown>
      {streaming ? (
        // A caret while tokens arrive, so a pause reads as "still writing"
        // rather than "finished and oddly short".
        <span
          className="inline-block h-4 w-[2px] animate-pulse bg-violet-secondary align-text-bottom"
          aria-hidden
        />
      ) : null}
    </div>
  );
}

/**
 * Collapsed by default. Trust needs the work to be *visible*, not *unavoidable*
 * — an always-open trace buries the answer under machinery.
 */
export function ThinkingBlock({
  label,
  trace,
  live = false,
}: {
  label?: string | null;
  trace: AssistToolTraceDto[];
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!live && trace.length === 0) return null;

  const headline = live
    ? (label ?? 'Working…')
    : `Did ${trace.length} thing${trace.length === 1 ? '' : 's'}`;

  return (
    <div className="rounded-xl border border-app-border bg-app-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-app-ink-2 hover:text-app-ink"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden
        />
        {live ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-secondary" />
        ) : (
          <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span className="flex-1 truncate">{headline}</span>
      </button>
      {open && trace.length > 0 ? (
        <ul className="space-y-1 border-t border-app-border px-3 py-2">
          {trace.map((t, i) => (
            <li key={`${t.name}-${i}`} className="flex items-start gap-2 text-xs">
              {t.ok ? (
                <Check className="mt-0.5 h-3 w-3 shrink-0 text-sl-succeeded" aria-hidden />
              ) : (
                <X className="mt-0.5 h-3 w-3 shrink-0 text-sl-failed" aria-hidden />
              )}
              <span className="text-app-ink-2">{t.summary}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** "Needs your input" items, stated plainly rather than implied by a badge. */
export function UnresolvedList({
  items,
}: {
  items: { nodeId: string; reason: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-status-warning/30 bg-status-warning/10 p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-sl-warning">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        Needs you before this can run
      </p>
      <ul className="space-y-1">
        {items.map((u) => (
          <li key={u.nodeId} className="text-xs text-app-ink-2">
            {u.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One persisted turn from the transcript. */
export function PersistedMessage({
  message,
  onResume,
  resuming = false,
  autoResume = false,
}: {
  message: AssistMessageDto;
  /** Re-run the turn after a skill is connected (CONNECTION cards only). */
  onResume?: () => void;
  resuming?: boolean;
  /** True only for the LAST message — see SkillRequirementCard.autoResume. */
  autoResume?: boolean;
}) {
  if (message.role === 'USER') return <UserBubble text={message.content} />;

  // A CONNECTION message is the in-chat Skill card, rebuilt from its snapshot;
  // the card refreshes live status itself so a reload after connecting is correct.
  if (message.role === 'CONNECTION') {
    const reqs =
      ((message.metadata ?? {}) as { requirements?: WorkflowSkillRequirementDto[] })
        .requirements ?? [];
    if (reqs.length === 0) return null;
    return (
      <SkillRequirementCard
        requirements={reqs}
        sessionId={message.sessionId}
        onResume={onResume}
        resuming={resuming}
        autoResume={autoResume}
      />
    );
  }

  const meta = (message.metadata ?? {}) as {
    toolTrace?: AssistToolTraceDto[];
    unresolved?: { nodeId: string; reason: string }[];
    tests?: AssistTestResult[];
  };

  return (
    <div className="space-y-2">
      <ThinkingBlock trace={meta.toolTrace ?? []} />
      {(meta.tests ?? []).map((t) => (
        <TestResultPanel key={t.runId} result={t} />
      ))}
      <AssistantBubble text={message.content} />
      <UnresolvedList items={meta.unresolved ?? []} />
    </div>
  );
}
