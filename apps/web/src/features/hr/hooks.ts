'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateLeaveRequestDto,
  CreateOnboardingTaskDto,
  CreateStaffMemberDto,
  LeaveRequestDto,
  OnboardingTaskDto,
  StaffMemberDto,
  UpdateStaffMemberDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import { useCurrentRole } from '@/features/users/hooks';
import {
  completeOnboardingTask,
  createLeave,
  createOnboardingTask,
  createStaff,
  decideLeave,
  deleteStaff,
  listLeave,
  listOnboardingTasks,
  listStaff,
  updateStaff,
} from './api';

export const hrKeys = {
  all: ['hr'] as const,
  staff: () => ['hr', 'staff'] as const,
  leave: (staffId?: string) => ['hr', 'leave', staffId ?? 'all'] as const,
  onboarding: (staffId?: string) => ['hr', 'onboarding', staffId ?? 'all'] as const,
};

/**
 * Whether this user may see the HR area at all.
 *
 * The whole domain is OWNER/ADMIN-only server-side — READS INCLUDED, which is
 * stricter than every other module, because staff records carry
 * special-category personal data. This mirrors that rule client-side so a
 * MEMBER is never shown a page that will only 403 at them; the server remains
 * the thing that enforces it (`02-security-journey.spec.ts` asserts a MEMBER
 * gets 403 from the API directly, not merely a hidden link).
 */
export function useCanManageHr(): boolean {
  const role = useCurrentRole();
  return role === 'OWNER' || role === 'ADMIN';
}

// --- Staff -----------------------------------------------------------------

export function useStaff() {
  const accessToken = useSessionStore((s) => s.accessToken);
  const allowed = useCanManageHr();
  return useQuery<StaffMemberDto[], NormalizedApiError>({
    queryKey: hrKeys.staff(),
    queryFn: listStaff,
    enabled: Boolean(accessToken) && allowed,
  });
}

export function useCreateStaff() {
  const qc = useQueryClient();
  return useMutation<StaffMemberDto, NormalizedApiError, CreateStaffMemberDto>({
    mutationFn: createStaff,
    // No optimistic insert: the server assigns the id and normalises the record,
    // and a roster row that flickers in with a fake id is worse than one that
    // appears half a second later.
    onSuccess: () => void qc.invalidateQueries({ queryKey: hrKeys.staff() }),
  });
}

export function useUpdateStaff() {
  const qc = useQueryClient();
  return useMutation<
    StaffMemberDto,
    NormalizedApiError,
    { id: string; data: UpdateStaffMemberDto }
  >({
    mutationFn: updateStaff,
    onSuccess: () => void qc.invalidateQueries({ queryKey: hrKeys.staff() }),
  });
}

export function useDeleteStaff() {
  const qc = useQueryClient();
  return useMutation<void, NormalizedApiError, string>({
    mutationFn: deleteStaff,
    onSuccess: () => void qc.invalidateQueries({ queryKey: hrKeys.all }),
  });
}

// --- Leave -----------------------------------------------------------------

export function useLeave(staffId?: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  const allowed = useCanManageHr();
  return useQuery<LeaveRequestDto[], NormalizedApiError>({
    queryKey: hrKeys.leave(staffId),
    queryFn: () => listLeave(staffId),
    enabled: Boolean(accessToken) && allowed,
  });
}

export function useCreateLeave() {
  const qc = useQueryClient();
  return useMutation<LeaveRequestDto, NormalizedApiError, CreateLeaveRequestDto>({
    mutationFn: createLeave,
    onSuccess: () => void qc.invalidateQueries({ queryKey: hrKeys.all }),
  });
}

export function useDecideLeave() {
  const qc = useQueryClient();
  return useMutation<
    LeaveRequestDto,
    NormalizedApiError,
    { id: string; status: 'APPROVED' | 'REJECTED' }
  >({
    mutationFn: decideLeave,
    /**
     * Invalidates the whole HR tree, not just the leave list: a leave decision
     * can route through the Approval Center, and the dashboard's HR widget
     * counts "leave awaiting decision". Refetching one list would leave two
     * other surfaces showing a number that is no longer true.
     */
    onSuccess: () => void qc.invalidateQueries({ queryKey: hrKeys.all }),
  });
}

// --- Onboarding tasks ------------------------------------------------------

export function useOnboardingTasks(staffId?: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  const allowed = useCanManageHr();
  return useQuery<OnboardingTaskDto[], NormalizedApiError>({
    queryKey: hrKeys.onboarding(staffId),
    queryFn: () => listOnboardingTasks(staffId),
    enabled: Boolean(accessToken) && allowed,
  });
}

export function useCreateOnboardingTask() {
  const qc = useQueryClient();
  return useMutation<
    OnboardingTaskDto,
    NormalizedApiError,
    CreateOnboardingTaskDto
  >({
    mutationFn: createOnboardingTask,
    onSuccess: () => void qc.invalidateQueries({ queryKey: hrKeys.all }),
  });
}

export function useCompleteOnboardingTask() {
  const qc = useQueryClient();
  return useMutation<OnboardingTaskDto, NormalizedApiError, string>({
    mutationFn: completeOnboardingTask,
    onSuccess: () => void qc.invalidateQueries({ queryKey: hrKeys.all }),
  });
}
