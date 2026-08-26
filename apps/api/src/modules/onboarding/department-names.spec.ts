import { normalizeDepartmentNames } from './onboarding.service';

/**
 * Phase 2 — the wizard now lets a company type its own department names, so the
 * normaliser is the thing standing between a text box and the
 * `@@unique([companyId, name])` index.
 *
 * Every case here is a real way the old code would have misbehaved: it mapped
 * the whole list through an enum formatter that lower-cased custom names, and
 * de-duplicated with a plain `Set`, which does not catch "Sales" vs "sales".
 */
describe('normalizeDepartmentNames', () => {
  describe('code-defined presets', () => {
    it('formats the enum values into readable names', () => {
      expect(normalizeDepartmentNames(['CUSTOMER_SUPPORT'])).toEqual([
        'Customer Support',
      ]);
      expect(normalizeDepartmentNames(['SALES'])).toEqual(['Sales']);
    });

    it('keeps HR upper-case rather than "Hr"', () => {
      expect(normalizeDepartmentNames(['HR'])).toEqual(['HR']);
    });

    it('is deterministic, so re-running the wizard maps to the SAME name', () => {
      // This is what makes `skipDuplicates` on the unique index actually dedupe.
      const once = normalizeDepartmentNames(['CUSTOMER_SUPPORT']);
      expect(normalizeDepartmentNames(once)).toEqual(once);
    });
  });

  describe('custom, user-typed names', () => {
    it('preserves the caller’s casing instead of mangling it', () => {
      // The old enum formatter would have produced "Customer success &
      // renewals" — not the department anyone asked for.
      expect(normalizeDepartmentNames(['Customer Success & Renewals'])).toEqual([
        'Customer Success & Renewals',
      ]);
      expect(normalizeDepartmentNames(['R&D'])).toEqual(['R&D']);
    });

    it('trims and collapses whitespace', () => {
      expect(normalizeDepartmentNames(['  People   Ops  '])).toEqual(['People Ops']);
    });
  });

  describe('never creates empty placeholder departments', () => {
    it('drops blank and whitespace-only entries', () => {
      expect(normalizeDepartmentNames(['', '   ', '\t'])).toEqual([]);
    });

    it('drops blanks while keeping the real ones', () => {
      expect(normalizeDepartmentNames(['Sales', '', 'Finance'])).toEqual([
        'Sales',
        'Finance',
      ]);
    });

    it('returns an empty list for an empty input', () => {
      expect(normalizeDepartmentNames([])).toEqual([]);
    });
  });

  describe('de-duplication', () => {
    it('is case-insensitive — the unique index is not', () => {
      expect(normalizeDepartmentNames(['Sales', 'sales', 'SALES'])).toEqual(['Sales']);
    });

    it('collapses a preset and its formatted form to one department', () => {
      expect(normalizeDepartmentNames(['HR', 'hr'])).toEqual(['HR']);
    });

    it('keeps the FIRST spelling the company chose', () => {
      expect(normalizeDepartmentNames(['Marketing', 'MARKETING'])).toEqual([
        'Marketing',
      ]);
    });
  });

  describe('bounds', () => {
    it('caps a name at the column limit rather than letting the insert fail', () => {
      const long = 'x'.repeat(500);
      const [name] = normalizeDepartmentNames([long]);
      expect(name).toHaveLength(120);
    });

    it('ignores non-string entries defensively', () => {
      expect(
        normalizeDepartmentNames([null as never, 42 as never, 'Sales']),
      ).toEqual(['Sales']);
    });
  });
});
