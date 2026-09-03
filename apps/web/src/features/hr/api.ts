import { apiClient } from '@/lib/apiClient';
import type {
  CreateLeaveRequestDto,
  CreateOnboardingTaskDto,
  CreateStaffMemberDto,
  LeaveRequestDto,
  OnboardingTaskDto,
  StaffMemberDto,
  UpdateStaffMemberDto,
} from '@vaep/types';

/**
 * The HR domain's client layer.
 *
 * ## Why this file did not exist until now
 *
 * `modules/hr` shipped in Wave P3-01 with six models, encrypted
 * special-category PII, a retention sweep and 20 routes — and
 * `apps/web/src/features/` had no `hr` folder at all. The 2026-09-02 audit
 * counted it as the single largest backend-only domain in the product: fully
 * built, migrated, tested, and reachable only by writing your own HTTP client.
 *
 * The dashboard already counted its rows ("Staff records", "Leave awaiting
 * decision", "Open onboarding tasks") and its own setup hint pointed at
 * `/scheduling`, because there was nowhere else to send anyone.
 *
 * ## Scope
 *
 * Roster, leave and onboarding tasks — the three the dashboard widget counts,
 * so every number on it now leads somewhere. Documents, reviews and attendance
 * have endpoints and remain unsurfaced; they are listed in the audit's
 * remaining work rather than half-built here.
 *
 * Every route below is OWNER/ADMIN-only server-side, reads included, because
 * this is special-category PII — stricter than the rest of the product, and
 * deliberately so.
 */

// --- Staff roster ----------------------------------------------------------

export async function listStaff(): Promise<StaffMemberDto[]> {
  const { data } = await apiClient.get<StaffMemberDto[]>('/hr/staff');
  return data;
}

export async function getStaff(id: string): Promise<StaffMemberDto> {
  const { data } = await apiClient.get<StaffMemberDto>(`/hr/staff/${id}`);
  return data;
}

export async function createStaff(
  body: CreateStaffMemberDto,
): Promise<StaffMemberDto> {
  const { data } = await apiClient.post<StaffMemberDto>('/hr/staff', body);
  return data;
}

export async function updateStaff(vars: {
  id: string;
  data: UpdateStaffMemberDto;
}): Promise<StaffMemberDto> {
  const { data } = await apiClient.patch<StaffMemberDto>(
    `/hr/staff/${vars.id}`,
    vars.data,
  );
  return data;
}

export async function deleteStaff(id: string): Promise<void> {
  await apiClient.delete(`/hr/staff/${id}`);
}

// --- Leave -----------------------------------------------------------------

export async function listLeave(staffId?: string): Promise<LeaveRequestDto[]> {
  const { data } = await apiClient.get<LeaveRequestDto[]>('/hr/leave', {
    params: staffId ? { staffId } : undefined,
  });
  return data;
}

export async function createLeave(
  body: CreateLeaveRequestDto,
): Promise<LeaveRequestDto> {
  const { data } = await apiClient.post<LeaveRequestDto>('/hr/leave', body);
  return data;
}

/** Approve or reject. `status` is the DECISION, not a filter. */
export async function decideLeave(vars: {
  id: string;
  status: 'APPROVED' | 'REJECTED';
}): Promise<LeaveRequestDto> {
  const { data } = await apiClient.post<LeaveRequestDto>(
    `/hr/leave/${vars.id}/decide`,
    { status: vars.status },
  );
  return data;
}

// --- Onboarding tasks ------------------------------------------------------

export async function listOnboardingTasks(
  staffId?: string,
): Promise<OnboardingTaskDto[]> {
  const { data } = await apiClient.get<OnboardingTaskDto[]>(
    '/hr/onboarding-tasks',
    { params: staffId ? { staffId } : undefined },
  );
  return data;
}

export async function createOnboardingTask(
  body: CreateOnboardingTaskDto,
): Promise<OnboardingTaskDto> {
  const { data } = await apiClient.post<OnboardingTaskDto>(
    '/hr/onboarding-tasks',
    body,
  );
  return data;
}

export async function completeOnboardingTask(
  id: string,
): Promise<OnboardingTaskDto> {
  const { data } = await apiClient.post<OnboardingTaskDto>(
    `/hr/onboarding-tasks/${id}/complete`,
    {},
  );
  return data;
}
