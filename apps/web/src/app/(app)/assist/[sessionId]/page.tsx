'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, WandSparkles } from 'lucide-react';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { WorkflowCanvas } from '@/features/workflows/components/builder/canvas/WorkflowCanvas';
import { simplifiedWorkflowUX } from '@/lib/featureFlags';
import { useSessionStore } from '@/stores/session.store';
import { AssistChat } from '@/features/assist/components/AssistChat';
import { AssistStageRail } from '@/features/assist/components/AssistStageRail';
import {
  useAcceptAssistSession,
  useAssistSession,
  useCreateAssistSession,
} from '@/features/assist/hooks';
import { useAssistStream } from '@/features/assist/useAssistStream';
import type { WorkflowDto } from '@vaep/types';

/**
 * The assist workspace: conversation on the left, the workflow taking shape on
 * the right.
 *
 * The preview is the SAME `WorkflowCanvas` the manual builder uses, in the same
 * editable mode — doc 30 AD-30-10 ("one canvas, one node system"). It is not a
 * read-only preview variant, because that is exactly what makes AI-built
 * workflows feel second-class.
 */
export default function AssistSessionPage() {
  const shellProps = useAppShellProps();
  const params = useParams<{ sessionId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const sessionId = params.sessionId;

  // Returning from an in-chat OAuth connect (doc 30 §12): the callback bounced
  // back here with ?connected=<skill> or ?skillError=<msg>. Surface it, refresh
  // the Skill card's live status, and strip the params so a reload is clean.
  const [connResult, setConnResult] = useState<{ connected?: string; error?: string } | null>(null);
  useEffect(() => {
    const connected = search.get('connected');
    const skillError = search.get('skillError');
    if (!connected && !skillError) return;
    setConnResult({ connected: connected ?? undefined, error: skillError ?? undefined });
    void qc.invalidateQueries({ queryKey: ['skill-requirements'] });
    router.replace(`/assist/${sessionId}`);
  }, [search, sessionId, router, qc]);

  const { data: session, isLoading } = useAssistSession(sessionId);
  const stream = useAssistStream(sessionId);
  const accept = useAcceptAssistSession(sessionId);
  const createSession = useCreateAssistSession();
  const role = useSessionStore((s) => s.user?.role);
  const canAccept = role === 'OWNER' || role === 'ADMIN';

  // A session created with an opening prompt arrives with `?start=1`. The prompt
  // is already stored, so we open the stream with EMPTY text to have it answered
  // rather than sending the same words twice. Guarded by a ref so React's double
  // effect invocation in dev can't fire two turns.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    if (search.get('start') !== '1' || !sessionId) return;
    startedRef.current = true;
    void stream.send('');
    router.replace(`/assist/${sessionId}`);
  }, [search, sessionId, stream, router]);

  /**
   * HAND THE DRAFT STRAIGHT TO THE EDITOR (UX plan §7).
   *
   * "Accept AI draft" is not a decision the customer needs to make — they
   * already asked for the workflow. So when Orlixa finishes building a complete
   * graph, the Workflow row is created and the editor opens. Creating the row is
   * an implementation detail; reviewing the workflow happens in the builder,
   * where it can actually be edited.
   *
   * Deliberately conservative about WHEN it fires. It requires a stream that
   * actually ran in this page view (`streamedRef`), so reopening an old
   * conversation never silently creates something; it requires the graph to be
   * complete (no unresolved steps), so a half-built draft still gets the human
   * checkpoint; and `accept` is NOT idempotent server-side, so `autoCreateRef`
   * plus the `createdWorkflowId` check must hold even through React's double
   * effect invocation in dev. On any failure it falls through to the manual bar
   * rather than swallowing the error.
   */
  const streamedRef = useRef(false);
  const autoCreateRef = useRef(false);
  // Read inside the effect below, but must not re-trigger it when the agent
  // renames the session mid-stream.
  const sessionTitleRef = useRef('Untitled workflow');
  if (stream.status === 'streaming') streamedRef.current = true;
  if (session?.title) sessionTitleRef.current = session.title;

  const streamGraph = stream.graph;
  const createdWorkflowId = session?.createdWorkflowId ?? null;
  useEffect(() => {
    if (!simplifiedWorkflowUX) return;
    if (autoCreateRef.current || !streamedRef.current) return;
    if (stream.status !== 'idle') return;
    if (!canAccept || createdWorkflowId) return;
    const graphNodes = streamGraph?.definition?.nodes ?? [];
    if (graphNodes.length < 2) return; // trigger only — nothing built yet
    if ((streamGraph?.unresolved.length ?? 0) > 0) return;

    autoCreateRef.current = true;
    accept.mutate(
      { name: sessionTitleRef.current },
      {
        onSuccess: (workflow: WorkflowDto) => router.push(`/workflows/${workflow.id}`),
        // Let the manual bar take over — the error is already rendered there.
        onError: () => {
          autoCreateRef.current = false;
        },
      },
    );
  }, [stream.status, streamGraph, canAccept, createdWorkflowId, accept, router]);

  if (isLoading || !session) {
    return (
      <AppShell {...shellProps}>
        <div className="p-6 text-sm text-zinc-500">Loading the conversation…</div>
      </AppShell>
    );
  }

  // Prefer the freshly-streamed graph; fall back to what's persisted.
  const definition = stream.graph?.definition ?? session.draftDefinition;
  const nodeCount = definition?.nodes.length ?? 0;
  // The validate stage reads the live unresolved list. A reloaded session that
  // isn't streaming hasn't re-run validation, so it reports 0 (not a false alarm).
  const unresolvedCount = stream.graph?.unresolved.length ?? 0;

  return (
    <AppShell {...shellProps}>
      <div className="flex h-[calc(100vh-6rem)] flex-col px-4 py-4">
        <header className="mb-3 flex shrink-0 items-center gap-3">
          <Link
            href="/assist"
            className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            AI Assist
          </Link>
          <span className="text-zinc-700">/</span>
          <h1 className="truncate font-display text-lg font-semibold text-white">
            {session.title}
          </h1>
          {session.createdWorkflowId ? (
            <Link
              href={`/workflows/${session.createdWorkflowId}`}
              className="ml-auto rounded-lg border border-white/[0.12] px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.06]"
            >
              Open the workflow
            </Link>
          ) : null}
        </header>

        {connResult ? (
          <div
            className={`mb-3 shrink-0 rounded-xl border px-3 py-2 text-sm ${
              connResult.error
                ? 'border-status-failed/30 bg-status-failed/10 text-status-failed'
                : 'border-status-succeeded/25 bg-status-succeeded/10 text-status-succeeded'
            }`}
            role="status"
          >
            {connResult.error
              ? `Couldn’t connect that skill: ${connResult.error}`
              : `${connResult.connected ?? 'Skill'} connected — continue below and Orlixa will carry on.`}
          </div>
        ) : null}

        <div className="mb-3 shrink-0">
          <AssistStageRail
            streaming={stream.status === 'streaming'}
            hasMessages={session.messages.length > 0}
            nodeCount={nodeCount}
            unresolvedCount={unresolvedCount}
            testCount={stream.tests.length}
            created={Boolean(session.createdWorkflowId)}
          />
        </div>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="min-h-0" aria-label="Conversation">
            <AssistChat
              session={session}
              stream={stream}
              onSend={(text) => void stream.send(text)}
              onStop={stream.stop}
              onStartOver={() => {
                createSession.mutate(
                  {},
                  { onSuccess: (s) => router.push(`/assist/${s.id}`) },
                );
              }}
            />
          </section>

          <section
            className="flex min-h-0 flex-col"
            aria-label="The workflow being built"
          >
            {nodeCount === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.02] p-8 text-center">
                <div>
                  <WandSparkles
                    className="mx-auto mb-3 h-6 w-6 text-zinc-600"
                    aria-hidden
                  />
                  <p className="text-sm text-zinc-400">
                    Your workflow will appear here as Orlixa builds it.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <AssistPreview
                    definition={definition}
                    locked={stream.status === 'streaming'}
                  />
                </div>
                {/* The one case the automatic hand-off deliberately skips: the
                    agent couldn't fill a step in, so a human decides before a
                    workflow row exists. */}
                {unresolvedCount > 0 ? (
                  <p className="mt-3 shrink-0 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
                    Orlixa couldn&apos;t finish{' '}
                    {unresolvedCount === 1 ? '1 step' : `${unresolvedCount} steps`}.
                    Create it anyway and finish those in the builder, or tell
                    Orlixa what to use.
                  </p>
                ) : null}
                <AcceptBar
                  defaultName={session.title}
                  nodeCount={nodeCount}
                  disabled={stream.status === 'streaming' || !canAccept}
                  disabledReason={
                    !canAccept
                      ? 'Only owners and admins can create workflows'
                      : 'Wait for Orlixa to finish'
                  }
                  alreadyCreated={session.createdWorkflowId}
                  pending={accept.isPending}
                  error={accept.error?.message ?? null}
                  onAccept={(name) =>
                    accept.mutate(
                      { name },
                      {
                        onSuccess: (w: WorkflowDto) =>
                          router.push(`/workflows/${w.id}`),
                      },
                    )
                  }
                />
              </>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The canvas needs a `WorkflowDto` shell, but an assist draft has no Workflow row
 * yet — that is the whole point of AD-30-05. So we hand it a minimal stand-in and
 * the real graph via `definitionOverride`.
 */
function AssistPreview({
  definition,
  locked,
}: {
  definition: NonNullable<ReturnType<typeof Object>> | null;
  locked: boolean;
}) {
  const shell = {
    id: 'assist-draft',
    name: 'Draft',
    status: 'DRAFT',
    definition: { nodes: [], edges: [] },
    updatedAt: new Date(0).toISOString(),
  } as unknown as WorkflowDto;

  return (
    <WorkflowCanvas
      workflow={shell}
      mode="preview"
      definitionOverride={definition as never}
      locked={locked}
      lockedReason="Orlixa is building this — have a look, but hold off on changes."
    />
  );
}

function AcceptBar({
  defaultName,
  nodeCount,
  disabled,
  disabledReason,
  alreadyCreated,
  pending,
  error,
  onAccept,
}: {
  defaultName: string;
  nodeCount: number;
  disabled: boolean;
  disabledReason: string;
  alreadyCreated: string | null;
  pending: boolean;
  error: string | null;
  onAccept: (name: string) => void;
}) {
  const [name, setName] = useState(defaultName.slice(0, 60));

  if (alreadyCreated) {
    return (
      <p className="mt-3 shrink-0 rounded-xl border border-status-succeeded/25 bg-status-succeeded/10 px-3 py-2.5 text-sm text-status-succeeded">
        Created. It&apos;s in your workflows now.
      </p>
    );
  }

  return (
    <div className="mt-3 shrink-0 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Workflow name"
          className="min-w-0 flex-1 rounded-lg border border-white/[0.1] bg-void px-2.5 py-1.5 text-sm text-zinc-200 focus:border-wf-focus focus:outline-none"
        />
        <button
          type="button"
          onClick={() => onAccept(name.trim())}
          disabled={disabled || pending || !name.trim()}
          // Never a dead control: the reason is always available on hover.
          title={disabled ? disabledReason : undefined}
          className="shrink-0 rounded-lg bg-violet px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet/90 disabled:cursor-not-allowed disabled:bg-violet/30 disabled:text-white/50"
        >
          {pending ? 'Creating…' : `Create workflow (${nodeCount} steps)`}
        </button>
      </div>
      {disabled ? (
        <p className="mt-1.5 text-xs text-zinc-500">{disabledReason}</p>
      ) : null}
      {error ? (
        <p className="mt-1.5 text-xs text-status-failed">{error}</p>
      ) : null}
    </div>
  );
}
