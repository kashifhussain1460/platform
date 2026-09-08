import { apiClient } from '@/lib/apiClient';
import type { LeadDetailDto, LeadDto, LeadSource, LeadStatus } from '@vaep/types';

export async function listLeads(params: {
  status?: LeadStatus;
  source?: LeadSource;
}): Promise<LeadDto[]> {
  const { data } = await apiClient.get<LeadDto[]>('/leads', {
    params: {
      ...(params.status ? { status: params.status } : {}),
      ...(params.source ? { source: params.source } : {}),
    },
  });
  return data;
}

export async function getLead(id: string): Promise<LeadDetailDto> {
  const { data } = await apiClient.get<LeadDetailDto>(`/leads/${id}`);
  return data;
}
