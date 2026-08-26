'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiEmployeeDto,
  InstallEmployeeDto,
  MarketplaceCatalogDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { employeeKeys } from '@/features/employees/hooks';
import { useSessionStore } from '@/stores/session.store';
import {
  getMarketplace,
  installEmployeeTemplate,
} from './api';

// The skills section reuses the existing skills install hook (useInstallSkill)
// and catalog — the marketplace does not duplicate that flow.

export const marketplaceKeys = {
  all: ['marketplace'] as const,
  catalog: ['marketplace', 'catalog'] as const,
};

/** The unified catalog is code-defined (static per deploy) → never stale. */
export function useMarketplace() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<MarketplaceCatalogDto, NormalizedApiError>({
    queryKey: marketplaceKeys.catalog,
    queryFn: getMarketplace,
    enabled: Boolean(accessToken),
    staleTime: Infinity,
  });
}

interface EmployeesContext {
  previous?: AiEmployeeDto[];
}

/**
 * Install an employee template (optimistic): prepend a temp employee to the
 * employees list, roll back on error, and invalidate the list on settle so the
 * hired employee (with its real id) appears.
 */
export function useInstallEmployeeTemplate() {
  const qc = useQueryClient();
  return useMutation<
    AiEmployeeDto,
    NormalizedApiError,
    { key: string; data: InstallEmployeeDto; name: string },
    EmployeesContext
  >({
    mutationFn: ({ key, data }) => installEmployeeTemplate({ key, data }),
    onMutate: async ({ data, name }) => {
      await qc.cancelQueries({ queryKey: employeeKeys.list });
      const previous = qc.getQueryData<AiEmployeeDto[]>(employeeKeys.list);
      const optimistic: AiEmployeeDto = {
        id: `temp_${Date.now()}`,
        companyId: '',
        name: data.name?.trim() || name,
        role: 'CUSTOM',
        status: 'ACTIVE',
        persona: null,
        model: null,
        department: null,
        managerName: null,
        workingHoursStart: null,
        workingHoursEnd: null,
        timezone: null,
        language: null,
        knowledgeAccess: 'ALL',
        budgetLimit: null,
        monthToDateCostUsd: null,
        maxCreditsPerExecution: null,
        maxCreditsPerTask: null,
        permissions: null,
        approvalRules: null,
        goals: null,
        kpiTargets: null,
        // A brand-new employee is never archived.
        archivedAt: null,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<AiEmployeeDto[]>(employeeKeys.list, (old) => [
        optimistic,
        ...(old ?? []),
      ]);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(employeeKeys.list, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: employeeKeys.list });
    },
  });
}


