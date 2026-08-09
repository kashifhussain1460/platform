import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompleteOnboarding } from '../hooks';
import { useSessionStore } from '@/stores/session.store';

// Mock the network layer so the hook test is deterministic (no real API).
vi.mock('../api', () => ({
  completeOnboardingRequest: vi.fn(async () => ({
    company: {
      id: 'c1',
      name: 'Acme',
      slug: 'acme',
      industry: 'SaaS',
      size: '1-10',
      country: null,
      timezone: null,
      website: null,
      logoUrl: null,
      description: null,
      onboardedAt: '2026-07-28T00:00:00.000Z',
      createdAt: new Date().toISOString(),
    },
    employees: [],
  })),
  onboardingStatusRequest: vi.fn(),
  onboardingCatalogRequest: vi.fn(),
}));

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useCompleteOnboarding', () => {
  beforeEach(() => {
    useSessionStore.getState().clear();
    useSessionStore.setState({
      user: {
        id: 'u1',
        companyId: 'c1',
        email: 'owner@acme.test',
        name: 'Owner',
        role: 'OWNER',
        emailVerified: true,
        phone: null,
        status: 'ACTIVE',
        departmentId: null,
        teamId: null,
        managerUserId: null,
        createdAt: new Date().toISOString(),
      },
      company: {
        id: 'c1',
        name: 'Acme',
        slug: 'acme',
        industry: null,
        size: null,
        country: null,
        timezone: null,
        website: null,
        logoUrl: null,
        description: null,
        onboardedAt: null,
        createdAt: new Date().toISOString(),
      },
      accessToken: 'tok_123',
      status: 'authenticated',
    });
  });

  it('syncs the Zustand session store so the (app) layout guard stops seeing a stale onboardedAt', async () => {
    const { result } = renderHook(() => useCompleteOnboarding(), {
      wrapper: makeWrapper(),
    });

    await result.current.mutateAsync({
      business: {},
      departments: ['HR'],
      employees: [],
    });

    // Regression: AppLayout reads `company` from the Zustand store (not React
    // Query) to decide whether to redirect /dashboard <-> /onboarding. If this
    // stays null after the mutation, the guard bounces the user back to
    // /onboarding forever, fighting OnboardingPage's own redirect to
    // /dashboard — an infinite loop that hangs the browser.
    await waitFor(() => {
      expect(useSessionStore.getState().company?.onboardedAt).toBe(
        '2026-07-28T00:00:00.000Z',
      );
    });
  });
});
