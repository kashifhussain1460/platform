import { describe, expect, it } from 'vitest';
import { employeeSettingsSchema } from './schemas';

const base = { name: 'Bot' };

describe('employeeSettingsSchema — maxCreditsPerExecution/maxCreditsPerTask', () => {
  it('validate the same way budgetLimit does today: nullable, optional, non-negative integers', () => {
    expect(
      employeeSettingsSchema.safeParse({
        ...base,
        budgetLimit: null,
        maxCreditsPerExecution: null,
        maxCreditsPerTask: null,
      }).success,
    ).toBe(true);

    expect(
      employeeSettingsSchema.safeParse({
        ...base,
        maxCreditsPerExecution: 500,
        maxCreditsPerTask: 50,
      }).success,
    ).toBe(true);

    expect(
      employeeSettingsSchema.safeParse({ ...base, maxCreditsPerExecution: -1 }).success,
    ).toBe(false);
    expect(
      employeeSettingsSchema.safeParse({ ...base, maxCreditsPerTask: 1.5 }).success,
    ).toBe(false);
  });

  it('existing budgetLimit validation is completely unchanged', () => {
    expect(employeeSettingsSchema.safeParse({ ...base, budgetLimit: null }).success).toBe(true);
    expect(employeeSettingsSchema.safeParse({ ...base, budgetLimit: 100 }).success).toBe(true);
    expect(employeeSettingsSchema.safeParse({ ...base, budgetLimit: -5 }).success).toBe(false);
  });
});
