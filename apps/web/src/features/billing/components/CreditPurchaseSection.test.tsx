import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditPurchaseSection } from './CreditPurchaseSection';
import { useSessionStore } from '@/stores/session.store';

vi.mock('../credits-api', () => ({
  getCreditBalance: vi.fn(async () => ({
    companyId: 'c1',
    balance: 500,
    reservedBalance: 0,
    lastReconciledAt: null,
    updatedAt: '2026-08-20T00:00:00.000Z',
    trailingMonthlyDebits: 0,
  })),
  getCreditPacks: vi.fn(async () => [
    { id: 'p1', packKey: 'SMALL', displayName: 'Small', creditAmount: 1000, bonusPercent: 0, priceUsd: 10 },
  ]),
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

describe('CreditPurchaseSection', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: 'tok_123' } as never);
  });

  it('clicking Buy under mock billing shows the "isn\'t available in mock mode" messaging, not a broken redirect', async () => {
    render(<CreditPurchaseSection />, { wrapper: makeWrapper() });

    const buyButton = await screen.findByRole('button', { name: /buy/i });
    fireEvent.click(buyButton);

    await waitFor(() =>
      expect(screen.getByText(/isn.t available in mock mode/i)).not.toBeNull(),
    );
  });
});
