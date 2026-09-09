import { EMPLOYEE_ROLES, type EmployeeRole } from '@vaep/types';
import {
  PLAN_CATALOG,
  PLAN_LIST,
  checkSeatFor,
  creditsPerEmployeeFor,
  maxEmployeesFor,
  maxPerRoleFor,
  maxRolesFor,
  planMeetsMinimum,
} from './billing.plans';

/**
 * Role-based hiring plans (docs/product/2026-09-04-role-based-hiring-plans.md).
 *
 * The catalog is data, and data drifts: `maxEmployees` is DERIVED from
 * `maxRoles × maxPerRole` but stored alongside them so every existing consumer
 * keeps working. The first test here is the one that stops those two ever
 * disagreeing — the exact failure mode the old catalog had, where a "soft
 * limit" was enforced in one place and informational in another.
 */
describe('PLAN_CATALOG — role-based seats', () => {
  it('derives maxEmployees from maxRoles × maxPerRole on every plan', () => {
    for (const plan of PLAN_LIST) {
      if (plan.maxRoles === null || plan.maxPerRole === null) {
        expect(plan.maxEmployees).toBeNull();
      } else {
        expect(plan.maxEmployees).toBe(plan.maxRoles * plan.maxPerRole);
      }
    }
  });

  it('matches the founder-approved matrix', () => {
    expect(PLAN_CATALOG.STARTER).toMatchObject({
      name: 'Free', priceMonthlyUsd: 0, maxRoles: 2, maxPerRole: 1, maxEmployees: 2,
      creditsPerEmployeePerMonth: 500, includedCreditsPerMonth: null,
    });
    expect(PLAN_CATALOG.PRO).toMatchObject({
      name: 'Starter', priceMonthlyUsd: 20, maxRoles: 2, maxPerRole: 1, maxEmployees: 2,
      creditsPerEmployeePerMonth: 500, includedCreditsPerMonth: 1_000,
    });
    expect(PLAN_CATALOG.BUSINESS).toMatchObject({
      name: 'Growth', priceMonthlyUsd: 40, maxRoles: 2, maxPerRole: 2, maxEmployees: 4,
      creditsPerEmployeePerMonth: 500, includedCreditsPerMonth: 2_000,
    });
    expect(PLAN_CATALOG.ENTERPRISE).toMatchObject({
      maxRoles: null, maxPerRole: null, maxEmployees: null, creditsPerEmployeePerMonth: null,
    });
  });

  /**
   * Margin guard. 1 credit = $0.01 of price covering provider cost + 10 %.
   * Included credits must never reach the plan's face value, or a fully-used
   * plan is served at ~0 % gross margin. 55 % is the plan doc's number.
   */
  it('keeps included credits at or under 50 % of price value on paid tiers', () => {
    for (const plan of [PLAN_CATALOG.PRO, PLAN_CATALOG.BUSINESS]) {
      const priceInCredits = plan.priceMonthlyUsd! * 100;
      expect(plan.includedCreditsPerMonth!).toBeLessThanOrEqual(priceInCredits * 0.5);
    }
  });

  it('exposes each rule through one helper', () => {
    expect(maxEmployeesFor('BUSINESS')).toBe(4);
    expect(maxRolesFor('BUSINESS')).toBe(2);
    expect(maxPerRoleFor('BUSINESS')).toBe(2);
    expect(creditsPerEmployeeFor('BUSINESS')).toBe(500);
    expect(maxEmployeesFor('ENTERPRISE')).toBeNull();
  });

  it('keeps the tier order stable (PLAN_RANK consumers depend on it)', () => {
    expect(planMeetsMinimum('BUSINESS', 'PRO')).toBe(true);
    expect(planMeetsMinimum('PRO', 'BUSINESS')).toBe(false);
    expect(planMeetsMinimum('STARTER', 'STARTER')).toBe(true);
  });
});

describe('checkSeatFor — the one seat rule', () => {
  const emp = (role: EmployeeRole, status = 'ACTIVE') => ({ role, status });

  it('allows the first hire of a new role on an empty roster', () => {
    expect(checkSeatFor('PRO', [], 'HR').reason).toBeNull();
  });

  it('refuses a second of the same role on a 1-per-role plan (PER_ROLE)', () => {
    const r = checkSeatFor('PRO', [emp('HR')], 'HR');
    expect(r.reason).toBe('PER_ROLE');
    expect(r.inRole).toBe(1);
  });

  it('refuses a third distinct role on a 2-role plan (NEW_ROLE), even with seats free', () => {
    // Growth: 2 roles × 2 = 4 seats. HR 1 + Marketing 1 leaves 2 seats free —
    // but Sales would be a THIRD role, and roles are what the plan sells.
    const r = checkSeatFor('BUSINESS', [emp('HR'), emp('MARKETING')], 'SALES');
    expect(r.reason).toBe('NEW_ROLE');
    expect(r.rolesUsed).toBe(2);
    expect(r.total).toBe(2);
  });

  it('allows a second employee in an existing role when the plan has 2 per role', () => {
    expect(checkSeatFor('BUSINESS', [emp('HR'), emp('MARKETING')], 'HR').reason).toBeNull();
  });

  it('refuses when every seat is taken (TOTAL) before looking at roles', () => {
    const r = checkSeatFor('BUSINESS', [emp('HR'), emp('HR'), emp('MARKETING'), emp('MARKETING')], 'HR');
    expect(r.reason).toBe('TOTAL');
  });

  /**
   * The way OUT of a full plan. A retired (DISABLED) or archived employee must
   * free both its seat and its role slot, or "retire one to hire another" is a
   * lie the error message tells.
   */
  it('does not count DISABLED employees as occupying a seat or a role', () => {
    const roster = [emp('HR', 'DISABLED'), emp('MARKETING', 'DISABLED')];
    expect(checkSeatFor('PRO', roster, 'SALES').reason).toBeNull();
    expect(checkSeatFor('PRO', roster, 'SALES').rolesUsed).toBe(0);
  });

  it('counts PAUSED employees as occupying (paused is not retired)', () => {
    expect(checkSeatFor('PRO', [emp('HR', 'PAUSED')], 'HR').reason).toBe('PER_ROLE');
  });

  it('never refuses on an unlimited plan', () => {
    const roster = EMPLOYEE_ROLES.flatMap((role) => [emp(role), emp(role), emp(role)]);
    expect(checkSeatFor('ENTERPRISE', roster, 'HR').reason).toBeNull();
  });
});
