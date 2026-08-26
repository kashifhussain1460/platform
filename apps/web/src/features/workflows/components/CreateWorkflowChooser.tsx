'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, LayoutTemplate, PencilRuler, WandSparkles } from 'lucide-react';
import { useCreateAssistSession } from '@/features/assist/hooks';
import { useEntitlements } from '@/features/product-context/hooks';
import { useCreateWorkflow } from '../hooks';

/**
 * "How do you want to build it?" (UX plan §5).
 *
 * One entry point, two ways in — and both land in the SAME editor on the SAME
 * canonical workflow model (§33). Describing it is listed first because that is
 * the primary intent an AI Employee Platform is built around; drawing it is a
 * peer, not a fallback.
 *
 * Neither path publishes anything: both produce a DRAFT.
 */
export function CreateWorkflowChooser() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');

  const entitlements = useEntitlements();
  const createSession = useCreateAssistSession();
  const createWorkflow = useCreateWorkflow();

  // `POST /workflows/generate` and the assist agent are plan-gated server-side.
  // Showing the card locked, rather than hiding it, is deliberate: a customer
  // who can't find the feature can't ask for it.
  const canUseAi = entitlements.includes('ASSIST');

  const describeIt = () => {
    const text = prompt.trim();
    if (!text || !canUseAi) return;
    createSession.mutate(
      { prompt: text },
      { onSuccess: (session) => router.push(`/assist/${session.id}?start=1`) },
    );
  };

  const buildIt = () => {
    const workflowName = name.trim() || 'Untitled workflow';
    createWorkflow.mutate(
      { name: workflowName },
      { onSuccess: (workflow) => router.push(`/workflows/${workflow.id}`) },
    );
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        {/* ── Build with AI ──────────────────────────────────────────────── */}
        <section className="flex flex-col rounded-2xl border border-violet/25 bg-violet/[0.06] p-6">
          <div className="mb-1 flex items-center gap-2">
            <WandSparkles className="h-5 w-5 text-violet" aria-hidden />
            <h2 className="text-lg font-semibold text-app-ink">Build with AI</h2>
          </div>
          <p className="mb-4 text-sm text-app-ink-2">
            Describe what you want to happen. Orlixa builds the workflow and
            opens it so you can check it.
          </p>

          <label htmlFor="assist-prompt" className="sr-only">
            Describe what you want to automate
          </label>
          <textarea
            id="assist-prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!canUseAi}
            placeholder="Every Monday at 9am, check new leads, qualify them with SalesAI, and ask the sales manager to approve the outreach email."
            className="field-modern mb-3 resize-none disabled:cursor-not-allowed disabled:opacity-50"
          />

          {!canUseAi && (
            <p className="mb-3 text-sm text-amber-700">
              Building with AI is part of the Business and Enterprise plans.{' '}
              <Link href="/billing" className="underline hover:text-amber-700">
                See plans
              </Link>
            </p>
          )}

          {createSession.isError && (
            <p className="mb-3 text-sm text-sl-failed">
              {createSession.error?.message ?? 'Could not start the conversation.'}
            </p>
          )}

          <button
            type="button"
            onClick={describeIt}
            disabled={!canUseAi || !prompt.trim() || createSession.isPending}
            className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_14px_34px_-12px_rgba(91,33,230,0.85)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createSession.isPending ? 'Starting…' : 'Generate workflow'}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </section>

        {/* ── Start from scratch ─────────────────────────────────────────── */}
        <section className="flex flex-col rounded-2xl border border-app-border bg-app-surface p-6">
          <div className="mb-1 flex items-center gap-2">
            <PencilRuler className="h-5 w-5 text-app-ink-2" aria-hidden />
            <h2 className="text-lg font-semibold text-app-ink">Start from scratch</h2>
          </div>
          <p className="mb-4 text-sm text-app-ink-2">
            Draw the steps yourself in the builder. Same editor, same workflow —
            you just start with a blank canvas.
          </p>

          <label
            htmlFor="workflow-name"
            className="mb-1 block text-sm font-medium text-app-ink-2"
          >
            Name
          </label>
          <input
            id="workflow-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Candidate screening"
            className="field-modern mb-3"
            onKeyDown={(e) => {
              if (e.key === 'Enter') buildIt();
            }}
          />

          {createWorkflow.isError && (
            <p className="mb-3 text-sm text-sl-failed">
              {createWorkflow.error?.message ?? 'Could not create the workflow.'}
            </p>
          )}

          <button
            type="button"
            onClick={buildIt}
            disabled={createWorkflow.isPending}
            className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl border border-app-border-strong bg-app-raised px-5 py-2.5 text-sm font-semibold text-app-ink transition-colors hover:border-app-border hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            {createWorkflow.isPending ? 'Creating…' : 'Open builder'}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </section>
      </div>

      <Link
        href="/workflows/templates"
        className="flex items-center gap-3 rounded-2xl border border-app-border bg-app-surface px-5 py-4 transition-colors hover:border-app-border-strong hover:bg-app-raised"
      >
        <LayoutTemplate className="h-5 w-5 shrink-0 text-app-ink-2" aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-app-ink">
            Or start from a template
          </span>
          <span className="block text-sm text-app-ink-3">
            Ready-made HR and marketing workflows you can adjust.
          </span>
        </span>
        <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-app-ink-3" aria-hidden />
      </Link>
    </div>
  );
}
