import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssistSessionDto,
  AssistSessionSummaryDto,
  AssistSuggestionDto,
  WorkflowDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { workflowKeys } from '@/features/workflows/hooks';
import {
  acceptAssistSession,
  createAssistSession,
  deleteAssistSession,
  getAssistSession,
  getAssistSuggestions,
  listAssistSessions,
} from './api';

/** Query-key factory, matching the pattern used by every other feature. */
export const assistKeys = {
  all: ['assist'] as const,
  sessions: ['assist', 'sessions'] as const,
  session: (id: string) => ['assist', 'session', id] as const,
  suggestions: ['assist', 'suggestions'] as const,
};

export function useAssistSuggestions() {
  return useQuery<AssistSuggestionDto[], NormalizedApiError>({
    queryKey: assistKeys.suggestions,
    queryFn: getAssistSuggestions,
    // Derived from the employee roster, which changes rarely.
    staleTime: 5 * 60_000,
  });
}

export function useAssistSessions() {
  return useQuery<AssistSessionSummaryDto[], NormalizedApiError>({
    queryKey: assistKeys.sessions,
    queryFn: listAssistSessions,
  });
}

export function useAssistSession(id: string | undefined) {
  return useQuery<AssistSessionDto, NormalizedApiError>({
    queryKey: assistKeys.session(id ?? ''),
    queryFn: () => getAssistSession(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateAssistSession() {
  const qc = useQueryClient();
  return useMutation<
    AssistSessionDto,
    NormalizedApiError,
    { prompt?: string; targetWorkflowId?: string; originRunId?: string }
  >({
    mutationFn: createAssistSession,
    onSuccess: (session) => {
      // Prime the detail cache so opening the session doesn't refetch what we
      // already hold, then refresh the list.
      qc.setQueryData(assistKeys.session(session.id), session);
      void qc.invalidateQueries({ queryKey: assistKeys.sessions });
    },
  });
}

export function useAcceptAssistSession(id: string) {
  const qc = useQueryClient();
  return useMutation<
    WorkflowDto,
    NormalizedApiError,
    { name: string; description?: string }
  >({
    mutationFn: (body) => acceptAssistSession(id, body),
    onSuccess: () => {
      // A real workflow now exists, and the session moved to COMPLETED.
      void qc.invalidateQueries({ queryKey: workflowKeys.list });
      void qc.invalidateQueries({ queryKey: assistKeys.session(id) });
      void qc.invalidateQueries({ queryKey: assistKeys.sessions });
    },
  });
}

export function useDeleteAssistSession() {
  const qc = useQueryClient();
  return useMutation<void, NormalizedApiError, string>({
    mutationFn: deleteAssistSession,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: assistKeys.sessions });
      const previous = qc.getQueryData<AssistSessionSummaryDto[]>(assistKeys.sessions);
      qc.setQueryData<AssistSessionSummaryDto[]>(assistKeys.sessions, (old) =>
        (old ?? []).filter((s) => s.id !== id),
      );
      return { previous } as never;
    },
    onError: (_e, _id, context) => {
      const previous = (context as { previous?: AssistSessionSummaryDto[] } | undefined)
        ?.previous;
      if (previous) qc.setQueryData(assistKeys.sessions, previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: assistKeys.sessions });
    },
  });
}
