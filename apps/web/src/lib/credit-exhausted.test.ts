import { describe, expect, it } from 'vitest';
import { isCreditExhaustedError } from './credit-exhausted';

describe('isCreditExhaustedError', () => {
  it('matches the exact Layer 1 company-balance 409', () => {
    expect(
      isCreditExhaustedError({
        status: 409,
        message:
          'This company has run out of credits. An owner or admin needs to add more credits before this can continue.',
      }),
    ).toBe(true);
  });

  it('does not match a different 409 (e.g. Layer 2 employee budget)', () => {
    expect(
      isCreditExhaustedError({
        status: 409,
        message: 'Bot has reached its monthly budget limit — raise the limit or wait for next month.',
      }),
    ).toBe(false);
  });

  it('does not match a non-409 error', () => {
    expect(isCreditExhaustedError({ status: 500, message: 'run out of credits' })).toBe(false);
  });

  it('handles null/undefined', () => {
    expect(isCreditExhaustedError(null)).toBe(false);
    expect(isCreditExhaustedError(undefined)).toBe(false);
  });
});
