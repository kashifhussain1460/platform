'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CompanyDto,
  CompleteOnboardingDto,
  CompleteOnboardingResultDto,
  DepartmentDto,
  EmployeeRoleTemplate,
  MeDto,
  OnboardingStatusDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { authKeys } from '@/features/auth/hooks';
import { employeeKeys } from '@/features/employees/hooks';
import { orgKeys } from '@/features/organization/hooks';
import { tenantKeys } from '@/features/tenant/hooks';
import { useSessionStore } from '@/stores/session.store';
import {
  completeOnboardingRequest,
  onboardingCatalogRequest,
  onboardingStatusRequest,
  saveOnboardingAiEmployeesRequest,
  saveOnboardingCompanyRequest,
  saveOnboardingDepartmentsRequest,
  saveOnboardingGoalsRequest,
} from './api';

export const onboardingKeys = {
  status: ['onboarding', 'status'] as const,
  catalog: ['onboarding', 'catalog'] as const,
};

/** Whether the current tenant has completed the onboarding wizard. */
export function useOnboardingStatus() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<OnboardingStatusDto, NormalizedApiError>({
    queryKey: onboardingKeys.status,
    queryFn: onboardingStatusRequest,
    enabled: Boolean(accessToken),
  });
}

/** Per-step savers — each returns the fresh server status (which we cache). */
export function useSaveOnboardingCompany() {
  const qc = useQueryClient();
  return useMutation<
    OnboardingStatusDto,
    NormalizedApiError,
    { name: string; industry: string; size: string; website?: string }
  >({
    mutationFn: saveOnboardingCompanyRequest,
    onSuccess: (s) => qc.setQueryData(onboardingKeys.status, s),
  });
}

export function useSaveOnboardingAiEmployees() {
  const qc = useQueryClient();
  return useMutation<OnboardingStatusDto, NormalizedApiError, string[]>({
    mutationFn: saveOnboardingAiEmployeesRequest,
    onSuccess: (s) => qc.setQueryData(onboardingKeys.status, s),
  });
}

/**
 * Step 4 — departments. Persists REAL `Department` rows, so the org screen's
 * cache is invalidated too: the wizard is not a draft, it is the first write to
 * the organization structure.
 */
export function useSaveOnboardingDepartments() {
  const qc = useQueryClient();
  return useMutation<OnboardingStatusDto, NormalizedApiError, string[]>({
    mutationFn: saveOnboardingDepartmentsRequest,
    onSuccess: (s) => {
      qc.setQueryData(onboardingKeys.status, s);
      void qc.invalidateQueries({ queryKey: orgKeys.departments });
    },
  });
}

export function useSaveOnboardingGoals() {
  const qc = useQueryClient();
  return useMutation<OnboardingStatusDto, NormalizedApiError, string[]>({
    mutationFn: saveOnboardingGoalsRequest,
    onSuccess: (s) => qc.setQueryData(onboardingKeys.status, s),
  });
}

/** The (static) code-defined hire catalog. */
export function useOnboardingCatalog() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<EmployeeRoleTemplate[], NormalizedApiError>({
    queryKey: onboardingKeys.catalog,
    queryFn: onboardingCatalogRequest,
    enabled: Boolean(accessToken),
    staleTime: Infinity,
  });
}

interface CompleteContext {
  previousStatus?: OnboardingStatusDto;
}

/**
 * Complete onboarding (optimistic): flip the status to completed immediately,
 * roll back on error; on success sync the returned company + refresh employees.
 */
export function useCompleteOnboarding() {
  const qc = useQueryClient();
  const setCompany = useSessionStore((s) => s.setCompany);
  return useMutation<
    CompleteOnboardingResultDto,
    NormalizedApiError,
    CompleteOnboardingDto,
    CompleteContext
  >({
    mutationFn: completeOnboardingRequest,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: onboardingKeys.status });
      const previousStatus = qc.getQueryData<OnboardingStatusDto>(
        onboardingKeys.status,
      );
      qc.setQueryData<OnboardingStatusDto>(onboardingKeys.status, (old) =>
        old
          ? { ...old, completed: true, step: 'COMPLETED' }
          : {
              completed: true,
              step: 'COMPLETED',
              company: { name: '', industry: null, size: null, website: null },
              selectedRoles: [],
              goals: [],
              departments: [],
            },
      );
      return { previousStatus };
    },
    onSuccess: (result) => {
      qc.setQueryData<CompanyDto>(tenantKeys.current, result.company);
      qc.setQueryData<MeDto>(authKeys.me, (old) =>
        old ? { ...old, company: result.company } : old,
      );
      // The departments the wizard just created are returned by the API, so the
      // org screen is correct on first paint instead of showing "no departments"
      // until something happens to refetch.
      qc.setQueryData<DepartmentDto[]>(orgKeys.departments, result.departments);
      // AppLayout's redirect guard reads `company` from the Zustand session
      // store, not React Query — without this, onboardedAt stays stale there
      // and the guard fights OnboardingPage's own redirect, looping forever.
      setCompany(result.company);
    },
    onError: (_err, _vars, context) => {
      if (context?.previousStatus) {
        qc.setQueryData(onboardingKeys.status, context.previousStatus);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: onboardingKeys.status });
      void qc.invalidateQueries({ queryKey: tenantKeys.current });
      void qc.invalidateQueries({ queryKey: authKeys.me });
      void qc.invalidateQueries({ queryKey: employeeKeys.list });
      void qc.invalidateQueries({ queryKey: orgKeys.departments });
    },
  });
}
