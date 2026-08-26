import { apiClient } from '@/lib/apiClient';
import type {
  CompleteOnboardingDto,
  CompleteOnboardingResultDto,
  EmployeeRoleTemplate,
  OnboardingStatusDto,
} from '@vaep/types';

export async function onboardingStatusRequest(): Promise<OnboardingStatusDto> {
  const { data } = await apiClient.get<OnboardingStatusDto>(
    '/onboarding/status',
  );
  return data;
}

export async function onboardingCatalogRequest(): Promise<
  EmployeeRoleTemplate[]
> {
  const { data } = await apiClient.get<EmployeeRoleTemplate[]>(
    '/onboarding/catalog',
  );
  return data;
}

export async function saveOnboardingCompanyRequest(body: {
  name: string;
  industry: string;
  size: string;
  website?: string;
}): Promise<OnboardingStatusDto> {
  const { data } = await apiClient.patch<OnboardingStatusDto>('/onboarding/company', body);
  return data;
}

export async function saveOnboardingAiEmployeesRequest(
  roles: string[],
): Promise<OnboardingStatusDto> {
  const { data } = await apiClient.patch<OnboardingStatusDto>('/onboarding/ai-employees', {
    roles,
  });
  return data;
}

export async function saveOnboardingDepartmentsRequest(
  departments: string[],
): Promise<OnboardingStatusDto> {
  const { data } = await apiClient.patch<OnboardingStatusDto>(
    '/onboarding/departments',
    { departments },
  );
  return data;
}

export async function saveOnboardingGoalsRequest(
  goals: string[],
): Promise<OnboardingStatusDto> {
  const { data } = await apiClient.patch<OnboardingStatusDto>('/onboarding/goals', { goals });
  return data;
}

export async function completeOnboardingRequest(
  payload: CompleteOnboardingDto,
): Promise<CompleteOnboardingResultDto> {
  const { data } = await apiClient.post<CompleteOnboardingResultDto>(
    '/onboarding/complete',
    payload,
  );
  return data;
}
