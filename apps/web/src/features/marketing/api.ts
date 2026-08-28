import { apiClient } from '@/lib/apiClient';
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

export async function listSocialAccounts(): Promise<SocialAccountDto[]> {
  const { data } = await apiClient.get<SocialAccountDto[]>('/marketing/accounts');
  return data;
}

export async function importSocialAccounts(): Promise<ImportSocialAccountsResultDto> {
  const { data } = await apiClient.post<ImportSocialAccountsResultDto>(
    '/marketing/accounts/import',
  );
  return data;
}

export async function startConnectAccount(platform: string): Promise<{ url: string }> {
  const { data } = await apiClient.post<{ url: string }>('/marketing/accounts/connect', {
    platform,
  });
  return data;
}

export async function disconnectAccount(id: string): Promise<SocialAccountDto> {
  const { data } = await apiClient.post<SocialAccountDto>(
    `/marketing/accounts/${id}/disconnect`,
  );
  return data;
}

export async function listPosts(params: {
  status?: ScheduledPostStatus;
}): Promise<ScheduledPostDto[]> {
  const { data } = await apiClient.get<ScheduledPostDto[]>('/marketing/posts', {
    params: params.status ? { status: params.status } : undefined,
  });
  return data;
}

export async function createPost(body: CreateScheduledPostDto): Promise<ScheduledPostDto> {
  const { data } = await apiClient.post<ScheduledPostDto>('/marketing/posts', body);
  return data;
}

export async function updatePost(vars: {
  id: string;
  body: UpdateScheduledPostDto;
}): Promise<ScheduledPostDto> {
  const { data } = await apiClient.patch<ScheduledPostDto>(
    `/marketing/posts/${vars.id}`,
    vars.body,
  );
  return data;
}

export async function cancelPost(id: string): Promise<{ id: string }> {
  const { data } = await apiClient.delete<{ id: string }>(`/marketing/posts/${id}`);
  return data;
}

export async function listCampaigns(): Promise<CampaignDto[]> {
  const { data } = await apiClient.get<CampaignDto[]>('/marketing/campaigns');
  return data;
}

export async function createCampaign(body: CreateCampaignDto): Promise<CampaignDto> {
  const { data } = await apiClient.post<CampaignDto>('/marketing/campaigns', body);
  return data;
}

export async function deleteCampaign(
  id: string,
): Promise<{ id: string; detachedPosts: number }> {
  const { data } = await apiClient.delete<{ id: string; detachedPosts: number }>(
    `/marketing/campaigns/${id}`,
  );
  return data;
}
