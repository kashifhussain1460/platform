'use client';

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AssistStreamEvent,
  AssistTestResult,
  AssistToolTraceDto,
  AssistUnresolvedNodeDto,
  WorkflowDefinition,
  WorkflowSkillRequirementDto,
} from '@vaep/types';
import { useSessionStore } from '@/stores/session.store';
import { assistKeys } from './hooks';

const baseURL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Live state of the turn currently in flight. */
export interface AssistStreamState {
  status: 'idle' | 'streaming' | 'error';
  /** The reply as it arrives. Held HERE, not in the query cache — see below. */
  text: string;
  /** What the agent says it's doing right now. */
  thinking: string | null;
  /** Tool calls so far this turn, for the collapsible trace. */
  trace: AssistToolTraceDto[];
  /** Latest draft graph pushed by the server. */
  graph: {
    definition: WorkflowDefinition;
    version: number;
    unresolved: AssistUnresolvedNodeDto[];
  } | null;
  /** Results of the agent's own dry-run tests, newest last. */
  tests: AssistTestResult[];
  /** Skills the draft needs connected (doc 30 §12); null until the agent reports. */
  connection: { requirements: WorkflowSkillRequirementDto[]; reason: string } | null;
  error: { message: string; retryable: boolean } | null;
}

const IDLE: AssistStreamState = {
  status: 'idle',
  text: '',
  thinking: null,
  trace: [],
  graph: null,
  tests: [],
  connection: null,
  error: null,
};

/**
 * Drive one assist turn over SSE.
 *
 * ── Why `fetch` + ReadableStream and NOT `EventSource` ──────────────────────
 * `EventSource` cannot set request headers, so the access token would have to go
 * into the query string — where it lands in server logs, proxy logs and browser
 * history. It is also GET-only, and a turn needs a body. `fetch` gives us the
 * `Authorization` header, a POST body, and `AbortController` for cancellation.
 *
 * ── Why token text lives in local state ─────────────────────────────────────
 * Tokens arrive dozens of times a second. Writing each one into the TanStack
 * cache would re-render every consumer of that key on every token. So the
 * in-flight text is component state, and only the FINISHED turn is written to
 * the cache (by invalidating the session) — which is also what makes a reload
 * show exactly what the stream showed.
 *
 * ── No mid-stream resume ────────────────────────────────────────────────────
 * If the connection drops, we refetch the session and replay from persisted
 * messages. A turn is short and the assistant message is only persisted once
 * complete, so a drop means "ask again", never "corrupt half-state".
 */
export function useAssistStream(sessionId: string | undefined) {
  const qc = useQueryClient();
  const [state, setState] = useState<AssistStreamState>(IDLE);
  // Abort handle for the in-flight turn. A ref because it must survive renders
  // without causing them, and only one turn can be live at a time.
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => ({ ...s, status: 'idle', thinking: null }));
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ ...IDLE, status: 'streaming' });

      try {
        const res = await fetch(
          `${baseURL}/assist/sessions/${sessionId}/turns/stream`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // The whole reason for fetch over EventSource.
              Authorization: `Bearer ${useSessionStore.getState().accessToken ?? ''}`,
            },
            // The refresh cookie is httpOnly; keep it flowing like apiClient does.
            credentials: 'include',
            body: JSON.stringify({ text }),
            signal: controller.signal,
          },
        );

        if (!res.ok || !res.body) {
          setState((s) => ({
            ...s,
            status: 'error',
            error: {
              message:
                res.status === 403
                  ? 'This conversation can’t continue — start a new one.'
                  : 'Couldn’t reach Orlixa. Try again in a moment.',
              retryable: res.status >= 500,
            },
          }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Frames are separated by a blank line. A chunk can split one, so keep
          // the trailing partial in the buffer.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const event = parseFrame(frame);
            if (event) setState((s) => reduce(s, event));
          }
        }
      } catch (err) {
        // An abort is a user action, not a failure.
        if ((err as { name?: string })?.name === 'AbortError') return;
        setState((s) => ({
          ...s,
          status: 'error',
          error: { message: 'The connection dropped. Try again.', retryable: true },
        }));
      } finally {
        abortRef.current = null;
        // The turn is persisted server-side; refetching is what makes the UI and
        // a page reload agree.
        //
        // AWAITED, then the local copy is cleared — order matters. The streamed
        // turn renders separately from the persisted list, so if we cleared
        // first there'd be a blank gap while the refetch flew, and if we never
        // cleared, the finished turn would render TWICE (once from the stream,
        // once from the refetched transcript). Both were seen in the browser.
        await qc.invalidateQueries({ queryKey: assistKeys.session(sessionId) });
        void qc.invalidateQueries({ queryKey: assistKeys.sessions });
        setState((s) =>
          // An error is the exception: it never became a persisted message, so
          // clearing it would silently swallow the failure. Keep `graph` and
          // `connection` so the preview + Skill card don't blink out during the
          // refetch handover.
          s.status === 'error'
            ? s
            : { ...IDLE, graph: s.graph, connection: s.connection },
        );
      }
    },
    [sessionId, qc],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, send, stop, reset };
}

/**
 * `event: <name>\ndata: <json>` → the event. Comment frames (`: ping`) and
 * anything unparseable are ignored rather than throwing — a heartbeat must not
 * be able to break a turn.
 */
function parseFrame(frame: string): AssistStreamEvent | null {
  const dataLine = frame
    .split('\n')
    .find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice('data:'.length).trim()) as AssistStreamEvent;
  } catch {
    return null;
  }
}

/** Pure reducer — makes the event handling unit-testable without a network. */
export function reduce(
  state: AssistStreamState,
  event: AssistStreamEvent,
): AssistStreamState {
  switch (event.type) {
    case 'thinking':
      return { ...state, thinking: event.label };
    case 'token':
      return { ...state, text: state.text + event.text };
    case 'tool':
      return { ...state, trace: [...state.trace, event.tool] };
    case 'graph':
      return {
        ...state,
        graph: {
          definition: event.definition,
          version: event.version,
          unresolved: event.unresolved,
        },
      };
    case 'test':
      return { ...state, tests: [...state.tests, event.result] };
    case 'connection':
      return {
        ...state,
        connection: { requirements: event.requirements, reason: event.reason },
      };
    case 'error':
      return {
        ...state,
        status: 'error',
        error: { message: event.message, retryable: event.retryable },
      };
    case 'done':
      // Preserve an error status: `done` always follows `error`, and flipping to
      // idle here would hide the failure the user needs to see.
      return {
        ...state,
        status: state.status === 'error' ? 'error' : 'idle',
        thinking: null,
      };
    default:
      return state;
  }
}
