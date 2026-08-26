import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreditBadge, creditBadgeState } from './CreditBadge';

describe('creditBadgeState', () => {
  it('zero: balance <= 0 regardless of trailing usage', () => {
    expect(creditBadgeState(0, 1000)).toBe('zero');
    expect(creditBadgeState(-5, 1000)).toBe('zero');
  });

  it('normal: no trailing spend yet, even at a small balance', () => {
    expect(creditBadgeState(5, 0)).toBe('normal');
  });

  it('critical: <=10% of trailing monthly spend remaining', () => {
    expect(creditBadgeState(80, 1000)).toBe('critical');
  });

  it('low: <=25% but >10% of trailing monthly spend remaining', () => {
    expect(creditBadgeState(200, 1000)).toBe('low');
  });

  it('normal: comfortably above the low threshold', () => {
    expect(creditBadgeState(900, 1000)).toBe('normal');
  });
});

const mockUseCreditBalance = vi.fn();
vi.mock('@/features/billing/credits-hooks', () => ({
  useCreditBalance: () => mockUseCreditBalance(),
}));

describe('CreditBadge', () => {
  it('renders nothing at Normal (matches the Runs-badge visual restraint)', () => {
    mockUseCreditBalance.mockReturnValue({
      data: { balance: 900, trailingMonthlyDebits: 1000 },
    });
    const { container } = render(<CreditBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('renders a colored "Zero" pill at zero balance', () => {
    mockUseCreditBalance.mockReturnValue({
      data: { balance: 0, trailingMonthlyDebits: 1000 },
    });
    render(<CreditBadge />);
    expect(screen.getByText('Zero')).not.toBeNull();
  });
});
