import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardCompositionDto, DashboardWidgetDto } from '@vaep/types';
import { DashboardWidgets } from '../DashboardWidgets';

/**
 * The dashboard renders whatever the server composed — it holds no rule about
 * which company sees what. These tests pin that: the component must show a
 * widget it has never heard of before, and must show the SETUP HINT rather
 * than a row of zeroes when an area is on but empty.
 */
let payload: DashboardCompositionDto;
let shouldFail = false;

vi.mock('../api', () => ({
  getProductContext: vi.fn(),
  getDashboardComposition: vi.fn(async () => {
    if (shouldFail) throw new Error('network');
    return payload;
  }),
}));

vi.mock('@/stores/session.store', () => ({
  useSessionStore: (selector: (s: { accessToken: string }) => unknown) =>
    selector({ accessToken: 'token' }),
}));

const widget = (over: Partial<DashboardWidgetDto> = {}): DashboardWidgetDto => ({
  kind: 'HR_ACTIVITY',
  title: 'HR',
  metrics: [
    { label: 'Staff records', value: 12, href: null },
    { label: 'Leave awaiting decision', value: 3, href: '/approvals', attention: true },
  ],
  setupHint: null,
  ...over,
});

function renderWidgets(widgets: DashboardWidgetDto[]) {
  payload = { companyId: 'co-1', widgets };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<DashboardWidgets />, { wrapper: Wrapper });
}

describe('DashboardWidgets', () => {
  beforeEach(() => {
    shouldFail = false;
  });

  it('renders the widgets the server sent, in order', async () => {
    renderWidgets([
      widget(),
      widget({ kind: 'MARKETING_ACTIVITY', title: 'Marketing', metrics: [] }),
    ]);
    expect(await screen.findByText('HR')).not.toBeNull();
    expect(screen.getByText('Marketing')).not.toBeNull();
  });

  it('renders no widget the server did not send', async () => {
    renderWidgets([widget()]);
    await screen.findByText('HR');
    // A Marketing company's sections must never appear for an HR company —
    // the whole point of composing server-side.
    expect(screen.queryByText('Marketing')).toBeNull();
    expect(screen.queryByText('Support')).toBeNull();
  });

  it('shows metric values and labels', async () => {
    renderWidgets([widget()]);
    expect(await screen.findByText('12')).not.toBeNull();
    expect(screen.getByText('Staff records')).not.toBeNull();
  });

  it('links a metric to the screen it came from', async () => {
    renderWidgets([widget()]);
    const link = await screen.findByRole('link', { name: /Leave awaiting decision/ });
    expect(link.getAttribute('href')).toBe('/approvals');
  });

  it('does not link a metric with no route, rather than inventing one', async () => {
    renderWidgets([widget()]);
    await screen.findByText('Staff records');
    expect(screen.queryByRole('link', { name: /Staff records/ })).toBeNull();
  });

  it('shows the SETUP HINT instead of zeroes when an area is empty', async () => {
    // §5 — the difference between a next step and a dead end.
    renderWidgets([
      widget({
        kind: 'MARKETING_ACTIVITY',
        title: 'Marketing',
        metrics: [{ label: 'Campaigns', value: 0, href: null }],
        setupHint: {
          message:
            'Your Marketing AI Employee is ready. Connect a social account to start publishing.',
          ctaLabel: 'Connect a social account',
          ctaHref: '/skills',
        },
      }),
    ]);
    expect(
      await screen.findByText(/Connect a social account to start publishing/i),
    ).not.toBeNull();
    // The zero is NOT shown — the next step replaces it.
    expect(screen.queryByText('Campaigns')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Connect a social account' }).getAttribute('href'),
    ).toBe('/skills');
  });

  it('surfaces an error rather than rendering an empty page', async () => {
    shouldFail = true;
    renderWidgets([]);
    expect(await screen.findByText(/Could not load your dashboard|network/i)).not.toBeNull();
  });
});
