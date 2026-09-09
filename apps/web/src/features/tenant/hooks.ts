'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompanyDto, MeDto, UpdateCompanyDto } from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { authKeys } from '@/features/auth/hooks';
import { productContextKeys } from '@/features/product-context/hooks';
import { useSessionStore } from '@/stores/session.store';
import { currentCompanyRequest, updateCompanyRequest } from './api';

export const tenantKeys = {
  current: ['tenant', 'current'] as const,
};

/** Mirrors the auth feature: current company for the authenticated tenant. */
export function useCurrentCompany() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<CompanyDto, NormalizedApiError>({
    queryKey: tenantKeys.current,
    queryFn: currentCompanyRequest,
    enabled: Boolean(accessToken),
  });
}

interface CompanyContext {
  previous?: CompanyDto;
}

/**
 * Update company profile (optimistic): patch the cached company immediately,
 * roll back on error, settle-invalidate. Also patches the /auth/me company.
 */
export function useUpdateCompany() {
  const qc = useQueryClient();
  return useMutation<
    CompanyDto,
    NormalizedApiError,
    UpdateCompanyDto,
    CompanyContext
  >({
    mutationFn: updateCompanyRequest,
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: tenantKeys.current });
      const previous = qc.getQueryData<CompanyDto>(tenantKeys.current);
      if (previous) {
        qc.setQueryData<CompanyDto>(tenantKeys.current, {
          ...previous,
          ...payload,
        });
      }
      qc.setQueryData<MeDto>(authKeys.me, (old) =>
        old ? { ...old, company: { ...old.company, ...payload } } : old,
      );
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) {
        qc.setQueryData(tenantKeys.current, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: tenantKeys.current });
      void qc.invalidateQueries({ queryKey: authKeys.me });
      // industry / size / businessGoals all feed the capability resolver.
      void qc.invalidateQueries({ queryKey: productContextKeys.all });
    },
  });
}
