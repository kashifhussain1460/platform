import type {
  AssistSessionDto,
  AssistSessionSummaryDto,
  AssistSuggestionDto,
  WorkflowDto,
} from '@vaep/types';
import { apiClient } from '@/lib/apiClient';

/**
 * Orlixa AI Assist HTTP client (doc 30 §8). Mirrors `modules/assist` one-to-one,
 * per the repo's features/*↔modules/* convention.
 *
 * The streaming turn endpoint is deliberately absent here: it cannot go through
 * `apiClient` (axios cannot stream in the browser) and lands in wave A3 as a
 * dedicated `fetch` + ReadableStream hook.
 */

export async function listAssistSessions(): Promise<AssistSessionSummaryDto[]> {
  const { data } = await apiClient.get<AssistSessionSummaryDto[]>('/assist/sessions');
  return data;
}

export async function getAssistSession(id: string): Promise<AssistSessionDto> {
  const { data } = await apiClient.get<AssistSessionDto>(`/assist/sessions/${id}`);
  return data;
}

export async function createAssistSession(body: {
  prompt?: string;
  targetWorkflowId?: string;
  originRunId?: string;
}): Promise<AssistSessionDto> {
  const { data } = await apiClient.post<AssistSessionDto>('/assist/sessions', body);
  return data;
}

export async function acceptAssistSession(
  id: string,
  body: { name: string; description?: string },
): Promise<WorkflowDto> {
  const { data } = await apiClient.post<WorkflowDto>(
    `/assist/sessions/${id}/accept`,
    body,
  );
  return data;
}

export async function deleteAssistSession(id: string): Promise<void> {
  await apiClient.delete(`/assist/sessions/${id}`);
}

export async function getAssistSuggestions(): Promise<AssistSuggestionDto[]> {
  const { data } = await apiClient.get<AssistSuggestionDto[]>('/assist/suggestions');
  return data;
}
