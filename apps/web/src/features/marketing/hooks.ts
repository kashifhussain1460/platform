'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiCampaignDetailDto,
  CampaignDto,
  ContentItemDto,
  CreateAiCampaignDto,
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
  createAiCampaign,
  createCampaign,
  getCampaignContent,
  getCampaignDetail,
  getContentItem,
  selectVariant,
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

// --- AI campaigns ----------------------------------------------------------

export const campaignKeys = {
  detail: (id: string) => ['marketing', 'campaign', id] as const,
  content: (id: string) => ['marketing', 'campaign', id, 'content'] as const,
  item: (id: string) => ['marketing', 'content', id] as const,
};

/**
 * Campaign detail, polled WHILE generation is running and not after.
 *
 * §75 wants a live progress view, but a campaign sitting in READY_FOR_REVIEW is
 * finished — polling it forever would be a request every few seconds, per open
 * tab, for a number that will never change again.
 */
export function useCampaignDetail(id: string) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<AiCampaignDetailDto, NormalizedApiError>({
    queryKey: campaignKeys.detail(id),
    queryFn: () => getCampaignDetail(id),
    enabled: Boolean(accessToken && id),
    refetchInterval: (query) =>
      query.state.data?.generation.inProgress ? 3_000 : false,
  });
}

/** The calendar, refreshed alongside generation so posts appear as they land. */
export function useCampaignContent(id: string, inProgress: boolean) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<ContentItemDto[], NormalizedApiError>({
    queryKey: campaignKeys.content(id),
    queryFn: () => getCampaignContent(id),
    enabled: Boolean(accessToken && id),
    refetchInterval: inProgress ? 3_000 : false,
  });
}

/** One post's options — fetched only when the post is actually opened (§62). */
export function useContentItem(id: string | null) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<ContentItemDto, NormalizedApiError>({
    queryKey: campaignKeys.item(id ?? ''),
    queryFn: () => getContentItem(id as string),
    enabled: Boolean(accessToken && id),
  });
}

export function useCreateAiCampaign() {
  const qc = useQueryClient();
  return useMutation<AiCampaignDetailDto, NormalizedApiError, CreateAiCampaignDto>({
    mutationFn: createAiCampaign,
    onSuccess: () => qc.invalidateQueries({ queryKey: marketingKeys.campaigns }),
  });
}

/**
 * Select an option.
 *
 * NOT optimistic. Selection is a deliberate human decision on a screen the
 * person is reading carefully; showing it as done and then reverting would be
 * worse than a short wait. It also invalidates the calendar, because the row's
 * selected state is shown there.
 */
export function useSelectVariant(campaignId: string) {
  const qc = useQueryClient();
  return useMutation<
    ContentItemDto,
    NormalizedApiError,
    { contentItemId: string; variantId: string }
  >({
    mutationFn: selectVariant,
    onSuccess: (item) => {
      qc.setQueryData(campaignKeys.item(item.id), item);
      void qc.invalidateQueries({ queryKey: campaignKeys.content(campaignId) });
    },
  });
}
