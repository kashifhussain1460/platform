'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreditBalanceDto, CreditLedgerEntryDto, CreditPackDto } from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import {
  getCreditBalance,
  getCreditLedger,
  getCreditPacks,
  purchaseCredits,
  type CreditLedgerFilters,
} from './credits-api';
import { billingKeys } from './hooks';

export const creditsKeys = {
  balance: [...billingKeys.all, 'credits'] as const,
  packs: [...billingKeys.all, 'credits', 'packs'] as const,
  ledger: (filters: CreditLedgerFilters) =>
    [...billingKeys.all, 'credits', 'ledger', filters] as const,
};

/** Current credit balance. Polled while a Stripe checkout redirect is pending. */
export function useCreditBalance(options: { pollWhilePending?: boolean } = {}) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<CreditBalanceDto, NormalizedApiError>({
    queryKey: creditsKeys.balance,
    queryFn: getCreditBalance,
    enabled: Boolean(accessToken),
    // Bounded — never polls forever if a webhook never lands.
    refetchInterval: options.pollWhilePending ? 3_000 : false,
  });
}

/** The active credit-pack catalog. */
export function useCreditPacks() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<CreditPackDto[], NormalizedApiError>({
    queryKey: creditsKeys.packs,
    queryFn: getCreditPacks,
    enabled: Boolean(accessToken),
    staleTime: 5 * 60 * 1000,
  });
}

/** Row-level ledger for the Usage page (OWNER/ADMIN — server 403s a MEMBER). */
export function useCreditLedger(filters: CreditLedgerFilters = {}) {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<CreditLedgerEntryDto[], NormalizedApiError>({
    queryKey: creditsKeys.ledger(filters),
    queryFn: () => getCreditLedger(filters),
    enabled: Boolean(accessToken),
  });
}

/** Starts a credit-pack purchase (mock: `checkoutUrl` is null; Stripe: redirects). */
export function usePurchaseCredits() {
  const qc = useQueryClient();
  return useMutation<{ checkoutUrl: string | null }, NormalizedApiError, string>({
    mutationFn: purchaseCredits,
    onSuccess: (data) => {
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: creditsKeys.balance });
    },
  });
}
