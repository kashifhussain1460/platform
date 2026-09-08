'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectWhatsAppAccountDto, WhatsAppAccountDto } from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import { connectWhatsAppAccount, getWhatsAppAccount } from './api';

export const whatsappAccountKeys = {
  account: ['whatsapp', 'account'] as const,
};

export function useWhatsAppAccount() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<WhatsAppAccountDto | null, NormalizedApiError>({
    queryKey: whatsappAccountKeys.account,
    queryFn: getWhatsAppAccount,
    enabled: Boolean(accessToken),
  });
}

export function useConnectWhatsAppAccount() {
  const qc = useQueryClient();
  return useMutation<WhatsAppAccountDto, NormalizedApiError, ConnectWhatsAppAccountDto>({
    mutationFn: connectWhatsAppAccount,
    onSuccess: (account) => {
      qc.setQueryData(whatsappAccountKeys.account, account);
    },
  });
}
