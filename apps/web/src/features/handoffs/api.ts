import { apiClient } from '@/lib/apiClient';
import type { HandoffRequestDto, ResolveHandoffRequestDto } from '@vaep/types';

/**
 * The human handoff queue — conversations an AI Employee stepped back from.
 *
 * `GET /handoffs` returns the whole tenant queue with a per-row `canResolve`,
 * so a colleague can see work they cannot personally action.
 */
export async function listHandoffs(params: {
  status?: string;
  assignedToMe?: boolean;
}): Promise<HandoffRequestDto[]> {
  const { data } = await apiClient.get<HandoffRequestDto[]>('/handoffs', {
    params: {
      ...(params.status ? { status: params.status } : {}),
      ...(params.assignedToMe ? { assignedToMe: 'true' } : {}),
    },
  });
  return data;
}

/** Hand the conversation back to the AI (`resume`) or close it. */
export async function resolveHandoff(vars: {
  id: string;
  body: ResolveHandoffRequestDto;
}): Promise<HandoffRequestDto> {
  const { data } = await apiClient.post<HandoffRequestDto>(
    `/handoffs/${vars.id}/resolve`,
    vars.body,
  );
  return data;
}
