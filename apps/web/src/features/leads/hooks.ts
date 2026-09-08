'use client';

import { useQuery } from '@tanstack/react-query';
import type { LeadDetailDto, LeadDto, LeadSource, LeadStatus } from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import { getLead, listLeads } from './api';

export const leadKeys = {
  all: ['leads'] as const,
  list: (status?: LeadStatus, source?: LeadSource) =>
    ['leads', status ?? 'ALL', source ?? 'ALL'] as const,
  detail: (id: string) => ['leads', 'detail', id] as const,
};

export function useLeads(status?: LeadStatus, source?: LeadSource) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<LeadDto[], NormalizedApiError>({
    queryKey: leadKeys.list(status, source),
    queryFn: () => listLeads({ status, source }),
    enabled: Boolean(accessToken),
  });
}

export function useLead(id: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<LeadDetailDto, NormalizedApiError>({
    queryKey: leadKeys.detail(id),
    queryFn: () => getLead(id),
    enabled: Boolean(accessToken && id),
  });
}
