'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CampaignDto,
  CreateCampaignDto,
  CreateScheduledPostDto,
  ImportSocialAccountsResultDto,
  ScheduledPostDto,
  ScheduledPostStatus,
  SocialAccountDto,
  UpdateScheduledPostDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { productContextKeys } from '@/features/product-context/hooks';
import { useSessionStore } from '@/stores/session.store';
import {
  cancelPost,
  createCampaign,
  createPost,
  deleteCampaign,
  disconnectAccount,
  importSocialAccounts,
  listCampaigns,
  listPosts,
  listSocialAccounts,
  startConnectAccount,
  updatePost,
} from './api';

export const marketingKeys = {
  all: ['marketing'] as const,
  accounts: ['marketing', 'accounts'] as const,
  posts: (status?: string) => ['marketing', 'posts', status ?? 'ALL'] as const,
  campaigns: ['marketing', 'campaigns'] as const,
};

export function useSocialAccounts() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<SocialAccountDto[], NormalizedApiError>({
    queryKey: marketingKeys.accounts,
    queryFn: listSocialAccounts,
    enabled: Boolean(accessToken),
  });
}

/**
 * The post list.
 *
 * Polled, because the rows move on their own: the reconciliation sweep flips
 * SCHEDULED → PUBLISHED/FAILED from outside this browser, and a page that only
 * updates on refresh would show a customer "scheduled" for a post that has
 * already gone out or already failed.
 */
export function usePosts(status?: ScheduledPostStatus) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<ScheduledPostDto[], NormalizedApiError>({
    queryKey: marketingKeys.posts(status),
    queryFn: () => listPosts({ status }),
    enabled: Boolean(accessToken),
    refetchInterval: 30_000,
  });
}

export function useCampaigns() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<CampaignDto[], NormalizedApiError>({
    queryKey: marketingKeys.campaigns,
    queryFn: listCampaigns,
    enabled: Boolean(accessToken),
  });
}

export function useImportAccounts() {
  const qc = useQueryClient();
  return useMutation<ImportSocialAccountsResultDto, NormalizedApiError, void>({
    mutationFn: importSocialAccounts,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: marketingKeys.accounts });
      void qc.invalidateQueries({ queryKey: productContextKeys.dashboard });
    },
  });
}

export function useStartConnect() {
  return useMutation<{ url: string }, NormalizedApiError, string>({
    mutationFn: startConnectAccount,
  });
}

export function useDisconnectAccount() {
  const qc = useQueryClient();
  return useMutation<SocialAccountDto, NormalizedApiError, string>({
    mutationFn: disconnectAccount,
    onSuccess: () => qc.invalidateQueries({ queryKey: marketingKeys.accounts }),
  });
}

/**
 * Create a post.
 *
 * NOT optimistic, deliberately — unlike the repo's usual write pattern. When
 * `schedule` is set this call really hands the post to a third party, and an
 * optimistic row would show "Scheduled" for a second before a Postiz failure
 * snatched it back. For an action with a public, irreversible side effect the
 * honest UI is to wait for the server to confirm it happened.
 */
export function useCreatePost() {
  const qc = useQueryClient();
  return useMutation<ScheduledPostDto, NormalizedApiError, CreateScheduledPostDto>({
    mutationFn: createPost,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: marketingKeys.all });
      void qc.invalidateQueries({ queryKey: productContextKeys.dashboard });
    },
  });
}

export function useUpdatePost() {
  const qc = useQueryClient();
  return useMutation<
    ScheduledPostDto,
    NormalizedApiError,
    { id: string; body: UpdateScheduledPostDto }
  >({
    mutationFn: updatePost,
    onSuccess: () => qc.invalidateQueries({ queryKey: marketingKeys.all }),
  });
}

export function useCancelPost() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, NormalizedApiError, string>({
    mutationFn: cancelPost,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: marketingKeys.all });
      void qc.invalidateQueries({ queryKey: productContextKeys.dashboard });
    },
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation<CampaignDto, NormalizedApiError, CreateCampaignDto>({
    mutationFn: createCampaign,
    onSuccess: () => qc.invalidateQueries({ queryKey: marketingKeys.campaigns }),
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation<{ id: string; detachedPosts: number }, NormalizedApiError, string>({
    mutationFn: deleteCampaign,
    onSuccess: () => qc.invalidateQueries({ queryKey: marketingKeys.all }),
  });
}
