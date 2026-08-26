import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductContextDto } from '@vaep/types';
import { useEntitlements, useHasArea } from '../hooks';

/**
 * The failure mode these guard against is not "wrong answer" — it is "blank
 * app". Both hooks are consumed by navigation, so their behaviour while
 * LOADING and while FAILING matters as much as their happy path: a transient
 * 500 on `/product-context` must never empty someone's sidebar.
 */
let payload: ProductContextDto | null = null;
let shouldFail = false;

vi.mock('../api', () => ({
  getProductContext: vi.fn(async () => {
    if (shouldFail) throw new Error('network');
    return payload;
  }),
}));

vi.mock('@/stores/session.store', () => ({
  useSessionStore: (selector: (s: { accessToken: string }) => unknown) =>
    selector({ accessToken: 'token' }),
}));

function context(over: Partial<ProductContextDto> = {}): ProductContextDto {
  return {
    companyId: 'co-1',
    configuration: {
      industry: null,
      size: null,
      businessGoals: [],
      departments: [],
      hiredEmployeeRoles: [],
      isMinimallyConfigured: true,
    },
    entitlements: { plan: 'STARTER', features: [], maxEmployees: 2, lockedAreas: [] },
    productAreas: ['DASHBOARD', 'EMPLOYEES'],
    areaReasons: {},
    navigation: [],
    dashboardCapabilities: [],
    relevantSkills: [],
    recommendedSkills: [],
    skillStatuses: [],
    availableWorkflowTemplates: [],
    relevantEmployeeIds: [],
    ...over,
  };
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useHasArea', () => {
  beforeEach(() => {
    shouldFail = false;
    payload = context();
  });

  it('is true for a resolved area', async () => {
    const { result } = renderHook(() => useHasArea('EMPLOYEES'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is false for an area the server did not return', async () => {
    const { result } = renderHook(() => useHasArea('ASSIST'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('defaults to TRUE while loading — no flash of missing navigation', () => {
    const { result } = renderHook(() => useHasArea('ASSIST'), { wrapper: wrapper() });
    expect(result.current).toBe(true);
  });

  it('defaults to TRUE on error — a failed request must not blank the app', async () => {
    shouldFail = true;
    const { result } = renderHook(() => useHasArea('ASSIST'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe(true));
  });
});

describe('useEntitlements', () => {
  beforeEach(() => {
    shouldFail = false;
  });

  it('reports the plan', async () => {
    payload = context();
    const { result } = renderHook(() => useEntitlements(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.plan).toBe('STARTER'));
  });

  it('excludes a locked area and names the tier that unlocks it', async () => {
    payload = context({
      entitlements: {
        plan: 'STARTER',
        features: [],
        maxEmployees: 2,
        lockedAreas: [{ area: 'ASSIST', requiresPlan: 'BUSINESS' }],
      },
    });
    const { result } = renderHook(() => useEntitlements(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.includes('ASSIST')).toBe(false));
    expect(result.current.upgradeRequiredFor('ASSIST')).toBe('BUSINESS');
  });

  it('includes an area that is not locked', async () => {
    payload = context({
      entitlements: {
        plan: 'BUSINESS',
        features: [],
        maxEmployees: null,
        lockedAreas: [],
      },
    });
    const { result } = renderHook(() => useEntitlements(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.plan).toBe('BUSINESS'));
    expect(result.current.includes('ASSIST')).toBe(true);
    expect(result.current.upgradeRequiredFor('ASSIST')).toBeNull();
  });

  it('assumes included while loading, so a gated CTA is not briefly disabled', () => {
    payload = context();
    const { result } = renderHook(() => useEntitlements(), { wrapper: wrapper() });
    expect(result.current.includes('ASSIST')).toBe(true);
    expect(result.current.isLoading).toBe(true);
  });
});
