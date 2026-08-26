import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageSummary } from './UsageSummary';
import { useSessionStore } from '@/stores/session.store';

const mockUsage = {
  plan: 'STARTER',
  maxEmployees: 5,
  employees: 2,
  installedSkills: 3,
  tasks: 10,
  tokens: 5000,
  estimatedCostUsd: 1.5,
  voiceMinutes: 0,
  overEmployeeLimit: false,
};

vi.mock('../api', () => ({
  getUsage: vi.fn(async () => mockUsage),
}));

vi.mock('../credits-api', () => ({
  getCreditBalance: vi.fn(async () => ({
    companyId: 'c1',
    balance: 80,
    reservedBalance: 0,
    lastReconciledAt: null,
    updatedAt: '2026-08-20T00:00:00.000Z',
    trailingMonthlyDebits: 1000, // 8% remaining -> critical
  })),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('UsageSummary', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: 'tok_123' } as never);
  });

  it('keeps the existing "illustrative" dollar-estimate line verbatim and adds a credits line', async () => {
    render(<UsageSummary />, { wrapper: makeWrapper() });

    expect(
      await screen.findByText(/\$1\.50 estimated — illustrative, not an exact bill/),
    ).not.toBeNull();
    expect(screen.getByText('Credits Consumed')).not.toBeNull();
  });

  it('shows the escalated Critical banner when the credit balance is critically low', async () => {
    render(<UsageSummary />, { wrapper: makeWrapper() });
    expect(await screen.findByText(/critically low/i)).not.toBeNull();
  });
});
