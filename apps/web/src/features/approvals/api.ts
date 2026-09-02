import { apiClient } from '@/lib/apiClient';
import type {
  ApprovalRequestDto,
  ApprovalStatus,
  DecideApprovalDto,
  ModifyApprovalDto,
} from '@vaep/types';

/**
 * List approval requests, optionally filtered by status and to the caller.
 *
 * `assignedToMe` hits the server-side `canDecide` filter, NOT a client-side
 * guess: the routing rules (a named user, a department, a team, the AI
 * Employee's manager) are only resolvable where the rule and the user's own
 * department/team/role live. The backend has supported it since Wave P3-05 and
 * nothing called it, so a routed approval was impossible to find as its
 * assignee.
 */
export async function listApprovals(
  status?: ApprovalStatus,
  assignedToMe?: boolean,
): Promise<ApprovalRequestDto[]> {
  const { data } = await apiClient.get<ApprovalRequestDto[]>('/approvals', {
    params: {
      ...(status ? { status } : {}),
      ...(assignedToMe ? { assignedToMe: 'true' } : {}),
    },
  });
  return data;
}

export async function approveRequest(vars: {
  id: string;
  data?: DecideApprovalDto;
}): Promise<ApprovalRequestDto> {
  const { data } = await apiClient.post<ApprovalRequestDto>(
    `/approvals/${vars.id}/approve`,
    vars.data ?? {},
  );
  return data;
}

export async function rejectRequest(vars: {
  id: string;
  data?: DecideApprovalDto;
}): Promise<ApprovalRequestDto> {
  const { data } = await apiClient.post<ApprovalRequestDto>(
    `/approvals/${vars.id}/reject`,
    vars.data ?? {},
  );
  return data;
}

export async function modifyRequest(vars: {
  id: string;
  data: ModifyApprovalDto;
}): Promise<ApprovalRequestDto> {
  const { data } = await apiClient.post<ApprovalRequestDto>(
    `/approvals/${vars.id}/modify`,
    vars.data,
  );
  return data;
}
