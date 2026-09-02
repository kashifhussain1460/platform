'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  ApprovalRequestDto,
  ApprovalStatus,
  DecideApprovalDto,
  ModifyApprovalDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import {
  approveRequest,
  listApprovals,
  modifyRequest,
  rejectRequest,
} from './api';

/** `status` is the FILTER a cached list was fetched with ('ALL' = no filter). */
type ListFilter = ApprovalStatus | 'ALL';

export const approvalKeys = {
  all: ['approvals'] as const,
  // `assignedToMe` is part of the key: the same status filter returns a
  // DIFFERENT list depending on it, so sharing one cache entry would show one
  // view's data under the other's heading.
  list: (filter: ListFilter, assignedToMe = false) =>
    ['approvals', filter, assignedToMe ? 'mine' : 'all'] as const,
};

/** Approval requests for a filter (default PENDING queue). */
export function useApprovals(status?: ApprovalStatus, assignedToMe = false) {
  const accessToken = useSessionStore((s) => s.accessToken);
  const filter: ListFilter = status ?? 'ALL';
  return useQuery<ApprovalRequestDto[], NormalizedApiError>({
    queryKey: approvalKeys.list(filter, assignedToMe),
    queryFn: () => listApprovals(status, assignedToMe),
    enabled: Boolean(accessToken),
  });
}

/** Snapshot of every cached approval list (for optimistic rollback). */
type Snapshot = Array<[readonly unknown[], ApprovalRequestDto[] | undefined]>;

interface DecisionContext {
  snapshot: Snapshot;
}

/**
 * Optimistically reflect a decision across every cached approval list: patch the
 * decided request's status, and drop it from any list whose filter no longer
 * matches (e.g. the Pending queue). Returns a snapshot for rollback on error.
 */
async function applyDecision(
  qc: QueryClient,
  id: string,
  next: ApprovalStatus,
): Promise<DecisionContext> {
  await qc.cancelQueries({ queryKey: approvalKeys.all });
  const snapshot = qc.getQueriesData<ApprovalRequestDto[]>({
    queryKey: approvalKeys.all,
  });
  for (const [key, data] of snapshot) {
    if (!data) continue;
    const filter = (key as [string, ListFilter])[1];
    const updated = data
      .map((r) => (r.id === id ? { ...r, status: next } : r))
      .filter((r) => filter === 'ALL' || r.status === filter);
    qc.setQueryData(key, updated);
  }
  return { snapshot };
}

function rollback(qc: QueryClient, context?: DecisionContext) {
  if (!context) return;
  for (const [key, data] of context.snapshot) {
    qc.setQueryData(key, data);
  }
}

/** Approve (optimistic): execute + move out of the pending queue. */
export function useApproveRequest() {
  const qc = useQueryClient();
  return useMutation<
    ApprovalRequestDto,
    NormalizedApiError,
    { id: string; data?: DecideApprovalDto },
    DecisionContext
  >({
    mutationFn: approveRequest,
    onMutate: ({ id }) => applyDecision(qc, id, 'APPROVED'),
    onError: (_err, _vars, context) => rollback(qc, context),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}

/** Reject (optimistic): mark rejected + move out of the pending queue. */
export function useRejectRequest() {
  const qc = useQueryClient();
  return useMutation<
    ApprovalRequestDto,
    NormalizedApiError,
    { id: string; data?: DecideApprovalDto },
    DecisionContext
  >({
    mutationFn: rejectRequest,
    onMutate: ({ id }) => applyDecision(qc, id, 'REJECTED'),
    onError: (_err, _vars, context) => rollback(qc, context),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}

/** Modify (optimistic): execute with edited args → APPROVED. */
export function useModifyRequest() {
  const qc = useQueryClient();
  return useMutation<
    ApprovalRequestDto,
    NormalizedApiError,
    { id: string; data: ModifyApprovalDto },
    DecisionContext
  >({
    mutationFn: modifyRequest,
    onMutate: ({ id }) => applyDecision(qc, id, 'APPROVED'),
    onError: (_err, _vars, context) => rollback(qc, context),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}
