import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BillingUsagePage from './page';
import { useSessionStore } from '@/stores/session.store';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const mockShellProps = vi.fn();
vi.mock('@/components/app-shell/useAppShellProps', () => ({
  useAppShellProps: () => mockShellProps(),
}));
vi.mock('@/components/app-shell/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/billing/components/UsageLedgerTable', () => ({
  UsageLedgerTable: () => <div>THE LEDGER TABLE</div>,
}));

describe('BillingUsagePage', () => {
  it('an ADMIN sees the ledger table', () => {
    useSessionStore.setState({ accessToken: 'tok_123' } as never);
    mockShellProps.mockReturnValue({ user: { role: 'ADMIN' } });
    render(<BillingUsagePage />);
    expect(screen.getByText('THE LEDGER TABLE')).not.toBeNull();
  });

  it('a MEMBER sees an access-denied state, not the table', () => {
    useSessionStore.setState({ accessToken: 'tok_123' } as never);
    mockShellProps.mockReturnValue({ user: { role: 'MEMBER' } });
    render(<BillingUsagePage />);
    expect(screen.queryByText('THE LEDGER TABLE')).toBeNull();
    expect(screen.getByText(/only an owner or admin/i)).not.toBeNull();
  });
});
