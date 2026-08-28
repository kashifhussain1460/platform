'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HandoffRequestDto, ResolveHandoffRequestDto } from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { productContextKeys } from '@/features/product-context/hooks';
import { useSessionStore } from '@/stores/session.store';
import { listHandoffs, resolveHandoff } from './api';

export const handoffKeys = {
  all: ['handoffs'] as const,
  list: (status: string, mine: boolean) =>
    ['handoffs', 'list', status, mine] as const,
};

/**
 * The handoff queue.
 *
 * Polled, because this is an inbox someone sits on: an escalation that only
 * appears after a manual refresh is an escalation that waits.
 */
export function useHandoffs(status: string, assignedToMe: boolean) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<HandoffRequestDto[], NormalizedApiError>({
    queryKey: handoffKeys.list(status, assignedToMe),
    queryFn: () => listHandoffs({ status, assignedToMe }),
    enabled: Boolean(accessToken),
    refetchInterval: 15_000,
  });
}

/**
 * Resolve one handoff.
 *
 * NOT optimistic: the server can legitimately refuse with 403 when routing did
 * not name this user, and optimistically removing the row would make a refused
 * resolve look like it worked until the refetch put it back. The dashboard's
 * Support widget counts pending handoffs, so it is invalidated too.
 */
export function useResolveHandoff() {
  const qc = useQueryClient();
  return useMutation<
    HandoffRequestDto,
    NormalizedApiError,
    { id: string; body: ResolveHandoffRequestDto }
  >({
    mutationFn: resolveHandoff,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: handoffKeys.all });
      void qc.invalidateQueries({ queryKey: productContextKeys.dashboard });
    },
  });
}
