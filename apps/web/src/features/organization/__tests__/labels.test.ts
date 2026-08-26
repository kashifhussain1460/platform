import { describe, expect, it } from 'vitest';
import { formatScope } from '../labels';

/**
 * Department scopes are NOT employee roles, even though the two lists overlap.
 * They are scope names drawn from three enums (`EmployeeRole`,
 * `WorkflowCategory`, `KnowledgeDocument.category`) that the authorization
 * policy compares as normalised strings.
 *
 * This formatter exists so the UI does not cast a scope to `EmployeeRole` to
 * borrow `features/employees/labels.formatRole` — a cast that would claim a
 * type the value does not have and would break on the first workflow category
 * with no role equivalent.
 */
describe('formatScope', () => {
  it('title-cases an underscored scope', () => {
    expect(formatScope('PROJECT_MANAGER')).toBe('Project Manager');
    expect(formatScope('CUSTOMER_SUPPORT')).toBe('Customer Support');
  });

  it('keeps HR upper-case rather than "Hr"', () => {
    expect(formatScope('HR')).toBe('HR');
    expect(formatScope('hr')).toBe('HR');
  });

  it('handles a single word', () => {
    expect(formatScope('MARKETING')).toBe('Marketing');
  });

  it('normalises the separators the policy already treats as equal', () => {
    // `normalizeScope` on the API side folds spaces and hyphens into
    // underscores, so all three of these are ONE scope and must display alike.
    expect(formatScope('project-manager')).toBe('Project Manager');
    expect(formatScope('project manager')).toBe('Project Manager');
    expect(formatScope('PROJECT_MANAGER')).toBe('Project Manager');
  });

  it('does not crash on an empty or odd value', () => {
    expect(formatScope('')).toBe('');
    expect(formatScope('___')).toBe('');
  });
});
