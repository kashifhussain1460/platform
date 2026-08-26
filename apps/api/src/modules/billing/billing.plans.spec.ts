import { planMeetsMinimum } from './billing.plans';

describe('planMeetsMinimum', () => {
  it('a plan meets its own tier', () => {
    expect(planMeetsMinimum('BUSINESS', 'BUSINESS')).toBe(true);
  });

  it('a higher plan meets a lower minimum', () => {
    expect(planMeetsMinimum('ENTERPRISE', 'PRO')).toBe(true);
  });

  it('a lower plan does not meet a higher minimum', () => {
    expect(planMeetsMinimum('STARTER', 'BUSINESS')).toBe(false);
  });
});
