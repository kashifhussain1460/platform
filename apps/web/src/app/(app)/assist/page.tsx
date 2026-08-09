'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Clock, LayoutTemplate, Plus, WandSparkles } from 'lucide-react';
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
    .slice(0, 5);

  return (
    <AppShell {...shellProps}>
      <main className="mx-auto flex w-full max-w-3xl flex-col px-4 py-14">
        {/* Hero — the ask */}
        <div className="mb-7 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet/20 text-violet-secondary shadow-[0_0_24px_rgba(124,92,255,0.25)]">
            <WandSparkles className="h-5 w-5" />
          </span>
          <div>
            <h1 className="font-display text-2xl font-semibold text-white">
              {firstName
                ? `What should your AI employees do, ${firstName}?`
                : 'What should your AI employees do?'}
            </h1>
            <p className="text-sm text-zinc-400">
              Describe it in plain English. Orlixa plans it with you before anything is built.
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 transition-colors focus-within:border-violet/40 focus-within:shadow-[0_0_32px_rgba(124,92,255,0.12)]">
          <textarea
            ref={textareaRef}
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="e.g. When HR uploads a new-hire spreadsheet, verify documents, send a welcome email, create accounts, notify Slack, and ask a manager to approve if mandatory documents are missing."
            aria-label="Describe the workflow you want to build"
            aria-describedby="assist-composer-hint"
            className="w-full resize-none bg-transparent text-sm leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
          <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-3">
            <p id="assist-composer-hint" className="text-xs text-zinc-500">
              Nothing runs until you say so.{' '}
              <span className="text-zinc-600">Enter to start · Shift+Enter for a new line</span>
            </p>
            <button
              type="button"
              onClick={() => start(prompt)}
              disabled={!prompt.trim() || create.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet/90 disabled:cursor-not-allowed disabled:bg-violet/30 disabled:text-white/50"
            >
              {create.isPending ? 'Starting…' : 'Generate'}
              {!create.isPending ? <ArrowRight className="h-3.5 w-3.5" aria-hidden /> : null}
            </button>
          </div>
        </div>

        {create.isError ? (
          <p className="mt-3 text-sm text-status-failed" role="alert">
            {create.error?.message ?? "Couldn't start that. Try again."}
          </p>
        ) : null}

        {/* Suggested prompts — role-aware, from the hired roster */}
        <section className="mt-7" aria-labelledby="assist-ideas">
          <p id="assist-ideas" className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Ideas for your team
          </p>
          {isLoading ? (
            <div className="flex flex-wrap gap-2" aria-busy="true" aria-label="Loading ideas">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="h-8 w-40 animate-pulse rounded-full bg-white/[0.05]" />
              ))}
            </div>
          ) : isError ? (
            <p className="text-sm text-zinc-500">
              Couldn&apos;t load ideas right now — you can still describe your own.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {(suggestions ?? []).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => start(s.prompt)}
                    disabled={create.isPending}
                    title={s.prompt}
                    className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-violet/40 hover:bg-violet/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Templates — start from a proven workflow */}
        {firstPartyTemplates.length > 0 ? (
          <section className="mt-8" aria-labelledby="assist-templates">
            <div className="mb-3 flex items-center justify-between">
              <p id="assist-templates" className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Start from a template
              </p>
              <Link
                href="/workflows/templates"
                className="text-xs text-violet-secondary transition-colors hover:text-violet"
              >
                View all
              </Link>
            </div>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {firstPartyTemplates.map((t) => (
                <li key={t.id}>
                  <Link
                    href="/workflows/templates"
                    className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-3 transition-colors hover:border-violet/30 hover:bg-violet/[0.06]"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-violet-secondary">
                      <LayoutTemplate className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-zinc-200">
                        {t.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500">
                        {t.description ?? t.category}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Recent prompts (this browser) */}
        {recentPrompts.length > 0 ? (
          <section className="mt-8" aria-labelledby="assist-recent-prompts">
            <p id="assist-recent-prompts" className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Recent prompts
            </p>
            <ul className="flex flex-wrap gap-2">
              {recentPrompts.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => setPrompt(p)}
                    title={p}
                    className="max-w-xs truncate rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:border-white/[0.14] hover:text-zinc-200"
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
          <section className="mt-10" aria-labelledby="assist-sessions">
            <p id="assist-sessions" className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Carry on where you left off
            </p>
            <ul className="space-y-1.5">
              {sessions.slice(0, 6).map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/assist/${s.id}`}
                    className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 transition-colors hover:border-white/[0.12]"
                  >
                    <Clock className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{s.title}</span>
                    <span className="shrink-0 text-xs text-zinc-600">
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
        <Link
          href="/workflows"
          className="mt-10 inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Prefer to build it yourself? Open the workflow builder
        </Link>
      </main>
    </AppShell>
  );
}
