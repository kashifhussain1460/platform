import { apiClient } from '@/lib/apiClient';
import type {
  CreditBalanceDto,
  CreditLedgerEntryDto,
  CreditPackDto,
} from '@vaep/types';

/** Current credit balance (self-heals to zero on the server if missing). */
export async function getCreditBalance(): Promise<CreditBalanceDto> {
  const { data } = await apiClient.get<CreditBalanceDto>('/billing/credits');
  return data;
}

/** The active credit-pack catalog (read-only, no credit effect). */
export async function getCreditPacks(): Promise<CreditPackDto[]> {
  const { data } = await apiClient.get<CreditPackDto[]>('/billing/credit-packs');
  return data;
}

export interface CreditLedgerFilters {
  employeeId?: string;
  source?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/** Row-level ledger for the Usage page (OWNER/ADMIN only — server 403s a MEMBER). */
export async function getCreditLedger(
  filters: CreditLedgerFilters = {},
): Promise<CreditLedgerEntryDto[]> {
  const { data } = await apiClient.get<CreditLedgerEntryDto[]>(
    '/billing/credits/usage',
    { params: filters },
  );
  return data;
}

/**
 * Creates ONLY a checkout session (mock: `checkoutUrl` is null and the
 * caller shows "isn't available in mock mode" — never grants credits from
 * the client; Phase 6's webhook is the only path allowed to do that, per
 * §17.1).
 */
export async function purchaseCredits(
  packId: string,
): Promise<{ checkoutUrl: string | null }> {
  const { data } = await apiClient.post<{ checkoutUrl: string | null }>(
    '/billing/credits/purchase',
    { packId },
  );
  return data;
}
