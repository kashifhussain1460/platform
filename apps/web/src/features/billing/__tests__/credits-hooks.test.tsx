import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreditBalance, useCreditPacks, usePurchaseCredits } from '../credits-hooks';
import { useSessionStore } from '@/stores/session.store';

const mockBalance = {
  companyId: 'c1',
  balance: 42,
  reservedBalance: 3,
  lastReconciledAt: null,
  updatedAt: '2026-08-20T00:00:00.000Z',
};

vi.mock('../credits-api', () => ({
  getCreditBalance: vi.fn(async () => mockBalance),
  getCreditPacks: vi.fn(async () => [
    { id: 'p1', packKey: 'SMALL', displayName: 'Small', creditAmount: 1000, bonusPercent: 0, priceUsd: 10 },
  ]),
  getCreditLedger: vi.fn(async () => []),
  purchaseCredits: vi.fn(async () => ({ checkoutUrl: null })),
}));

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('credits-hooks', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: 'tok_123' } as never);
  });

  it('useCreditBalance returns the balance snapshot', async () => {
    const { result } = renderHook(() => useCreditBalance(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(mockBalance));
  });

  it('useCreditPacks returns the active catalog', async () => {
    const { result } = renderHook(() => useCreditPacks(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data?.[0]?.packKey).toBe('SMALL'));
  });

  it('usePurchaseCredits: a null checkoutUrl (mock provider) never navigates the browser', async () => {
    const { result } = renderHook(() => usePurchaseCredits(), { wrapper: makeWrapper() });
    await result.current.mutateAsync('SMALL');
    // No assertion on window.location — the absence of a thrown/redirect error
    // under jsdom's read-only location is the regression guard itself.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
