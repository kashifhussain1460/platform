'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  MessageSquareText,
  Plug,
  Plus,
  Rocket,
  WandSparkles,
} from 'lucide-react';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { useSessionStore } from '@/stores/session.store';
import { formatRelativeTime } from '@/lib/time';
import {
  useAssistSessions,
  useAssistSuggestions,
  useCreateAssistSession,
} from '@/features/assist/hooks';
import { useWorkflowTemplates } from '@/features/workflows/hooks';

/**
 * Orlixa AI Assist — Landing (doc 31, Screen 1).
 *
 * The single "ask" surface: describe a workflow in plain English, or start from
 * a suggestion, a template, or a recent prompt. Creating a session stores the
 * opening prompt and navigates with `?start=1` so the staged workspace opens the
 * stream there rather than making the user watch a spinner on a page they're
 * about to leave.
 */
const RECENT_PROMPTS_KEY = 'orlixa.assist.recentPrompts';

/**
 * What the assistant actually does, in the order you meet it. Each line maps to
 * a capability that exists today — the connection card really does appear
 * mid-chat, and publish really is the last step — so nothing here promises a
 * screen the user won't reach.
 */
const HOW_IT_WORKS = [
  {
    icon: MessageSquareText,
    title: 'Describe it in plain English',
    body: 'Say what the job is. Orlixa asks for anything it still needs before it plans a thing.',
  },
  {
    icon: CheckCircle2,
    title: 'Review before anything runs',
    body: 'Every step, the tools it touches, and who has to approve — all visible up front.',
  },
  {
    icon: Plug,
    title: 'Connect tools as you go',
    body: 'Missing a Gmail or Slack connection? Connect it right in the chat and carry on.',
  },
  {
    icon: Rocket,
    title: 'Publish when you say so',
    body: 'Turn it on, watch each run, and pause it any time. Nothing goes live on its own.',
  },
];

function loadRecentPrompts(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_PROMPTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as string[]).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function rememberPrompt(prompt: string): void {
  if (typeof window === 'undefined') return;
  try {
    const next = [prompt, ...loadRecentPrompts().filter((p) => p !== prompt)].slice(0, 5);
    window.localStorage.setItem(RECENT_PROMPTS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable (private mode) — recents are a convenience, skip. */
  }
}

export default function AssistPage() {
  const shellProps = useAppShellProps();
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const firstName = user?.name?.trim().split(/\s+/)[0];

  const [prompt, setPrompt] = useState('');
  const [recentPrompts, setRecentPrompts] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: suggestions, isLoading, isError } = useAssistSuggestions();
  const { data: sessions } = useAssistSessions();
  const { data: templates } = useWorkflowTemplates();
  const create = useCreateAssistSession();

  // Recents are client-only (a convenience, never server state).
  useEffect(() => setRecentPrompts(loadRecentPrompts()), []);

  const start = (text: string) => {
    const clean = text.trim();
    if (!clean || create.isPending) return;
    rememberPrompt(clean);
    create.mutate(
      { prompt: clean },
      { onSuccess: (s) => router.push(`/assist/${s.id}?start=1`) },
    );
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter or ⌘/Ctrl+Enter starts; Shift+Enter is a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      start(prompt);
      return;
    }
    // ↑ on an empty composer recalls the most recent prompt (Raycast-style).
    if (e.key === 'ArrowUp' && prompt.length === 0 && recentPrompts[0]) {
      e.preventDefault();
      setPrompt(recentPrompts[0]);
    }
  };

  const firstPartyTemplates = (templates ?? [])
    .filter((t) => t.companyId === null)
    .slice(0, 6);

  return (
    <AppShell {...shellProps}>
      <main className="mx-auto flex w-full max-w-5xl flex-col px-4 pb-16 pt-10">
        {/* Hero — the ask. Centred, because the composer below it is the only
            thing on this page anyone has to use. */}
        <div className="flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] text-white shadow-[0_16px_40px_-12px_rgba(94,60,232,0.55)]">
            <WandSparkles className="h-6 w-6" />
          </span>
          <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight text-app-ink sm:text-4xl">
            {firstName
              ? `What should your AI employees do, ${firstName}?`
              : 'What should your AI employees do?'}
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-app-ink-2">
            Describe it in plain English. Orlixa plans it with you before anything is built.
          </p>
        </div>

        {/* Composer. The gradient sits on a 1px padding wrapper so the border
            itself is the gradient — a `border-image` would lose the radius. */}
        <div className="mt-8 rounded-[1.15rem] bg-[linear-gradient(135deg,rgba(106,48,236,0.55),rgba(139,110,242,0.25)_45%,rgba(232,232,240,0.9))] p-px shadow-[0_24px_60px_-30px_rgba(94,60,232,0.45)]">
          <div className="rounded-2xl bg-app-surface p-4 sm:p-5">
            <textarea
              ref={textareaRef}
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="e.g. When HR uploads a new-hire spreadsheet, verify documents, send a welcome email, create accounts, notify Slack, and ask a manager to approve if mandatory documents are missing."
              aria-label="Describe the workflow you want to build"
              aria-describedby="assist-composer-hint"
              className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-app-ink placeholder:text-app-ink-4 focus:outline-none"
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-app-border pt-4">
              <p id="assist-composer-hint" className="text-xs text-app-ink-3">
                Nothing runs until you say so. Enter to start · Shift+Enter for a new line
              </p>
              <button
                type="button"
                onClick={() => start(prompt)}
                disabled={!prompt.trim() || create.isPending}
                className="inline-flex items-center gap-2 rounded-xl bg-violet px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-not-allowed disabled:bg-violet/30 disabled:text-white/60"
              >
                {create.isPending ? 'Starting…' : 'Generate plan'}
                {!create.isPending ? <ArrowRight className="h-4 w-4" aria-hidden /> : null}
              </button>
            </div>
          </div>
        </div>

        {create.isError ? (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {create.error?.message ?? "Couldn't start that. Try again."}
          </p>
        ) : null}

        {/* Suggested prompts — role-aware, from the hired roster */}
        <section className="mt-6" aria-labelledby="assist-ideas">
          <p id="assist-ideas" className="mb-3 text-center text-xs font-medium uppercase tracking-wide text-app-ink-3">
            Ideas for your team
          </p>
          {isLoading ? (
            <div className="flex flex-wrap justify-center gap-2" aria-busy="true" aria-label="Loading ideas">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="h-8 w-40 animate-pulse rounded-full bg-app-raised" />
              ))}
            </div>
          ) : isError ? (
            <p className="text-center text-sm text-app-ink-3">
              Couldn&apos;t load ideas right now — you can still describe your own.
            </p>
          ) : (
            <ul className="flex flex-wrap justify-center gap-2">
              {(suggestions ?? []).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => start(s.prompt)}
                    disabled={create.isPending}
                    title={s.prompt}
                    className="rounded-full border border-app-border bg-app-surface px-3.5 py-1.5 text-sm text-app-ink-2 transition-colors hover:border-violet/40 hover:bg-violet/[0.06] hover:text-app-ink disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* How it works — four beats, in the order you meet them */}
        <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="How AI Assist works">
          {HOW_IT_WORKS.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-2xl border border-app-border bg-app-surface p-5 transition-colors hover:border-app-border-strong"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet/10 text-violet">
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <h3 className="mt-4 text-sm font-semibold text-app-ink">{title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-app-ink-2">{body}</p>
            </div>
          ))}
        </section>

        {/* Templates — start from a proven workflow */}
        {firstPartyTemplates.length > 0 ? (
          <section className="mt-12" aria-labelledby="assist-templates">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 id="assist-templates" className="text-base font-semibold text-app-ink">
                Start from a template
              </h2>
              <Link
                href="/workflows/templates"
                className="text-sm font-medium text-violet transition-colors hover:text-violet-hover"
              >
                View all
              </Link>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {firstPartyTemplates.map((t) => (
                <li key={t.id}>
                  <Link
                    href="/workflows/templates"
                    className="flex h-full flex-col rounded-2xl border border-app-border bg-app-surface p-4 transition-colors hover:border-violet/40 hover:bg-violet/[0.04]"
                  >
                    <span className="self-start rounded-full bg-app-tint px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-violet">
                      {t.category}
                    </span>
                    <span className="mt-3 block text-sm font-semibold text-app-ink">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 block text-[13px] leading-relaxed text-app-ink-2">
                      {t.description ?? 'Ready to install and edit.'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Recent prompts (this browser) */}
        {recentPrompts.length > 0 ? (
          <section className="mt-12" aria-labelledby="assist-recent-prompts">
            <h2 id="assist-recent-prompts" className="mb-3 text-base font-semibold text-app-ink">
              Recent prompts
            </h2>
            <ul className="flex flex-wrap gap-2">
              {recentPrompts.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => setPrompt(p)}
                    title={p}
                    className="max-w-xs truncate rounded-full border border-app-border bg-app-surface px-3.5 py-1.5 text-sm text-app-ink-2 transition-colors hover:border-app-border-strong hover:text-app-ink"
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Resume prior sessions */}
        {sessions && sessions.length > 0 ? (
          <section className="mt-12" aria-labelledby="assist-sessions">
            <h2 id="assist-sessions" className="mb-3 text-base font-semibold text-app-ink">
              Carry on where you left off
            </h2>
            <ul className="space-y-2">
              {sessions.slice(0, 6).map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/assist/${s.id}`}
                    className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface px-4 py-3 transition-colors hover:border-app-border-strong"
                  >
                    <Clock className="h-4 w-4 shrink-0 text-app-ink-3" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm text-app-ink">{s.title}</span>
                    <span className="shrink-0 text-xs text-app-ink-3">
                      {s.draftNodeCount > 0 ? `${s.draftNodeCount} steps` : 'not started'}
                      {' · '}
                      {formatRelativeTime(s.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Power-user exit — skip the assistant */}
        <section className="mt-12 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-violet/20 bg-app-tint px-6 py-5">
          <div>
            <h2 className="text-base font-semibold text-app-ink">Prefer to build it yourself?</h2>
            <p className="mt-1 text-sm text-app-ink-2">
              Open the workflow builder and place every step by hand.
            </p>
          </div>
          <Link
            href="/workflows"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-violet/30 bg-app-surface px-4 py-2 text-sm font-semibold text-violet transition-colors hover:border-violet/50 hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Open workflow builder
          </Link>
        </section>
      </main>
    </AppShell>
  );
}
