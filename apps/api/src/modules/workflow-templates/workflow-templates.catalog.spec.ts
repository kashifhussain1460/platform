import { SkillCatalog } from '../skills/catalog';
import { HR_WORKFLOW_TEMPLATES } from './hr-workflow-templates.catalog';
import { MARKETING_WORKFLOW_TEMPLATES } from './marketing-workflow-templates.catalog';
import { FIRST_PARTY_WORKFLOW_TEMPLATES } from './workflow-templates.catalog';
import { validateManifest } from './workflow-templates.util';

/**
 * Guards the first-party catalog (P3-03 HR + P3-04 Marketing). This is the SAME
 * validation the boot seeder runs, so a broken template is caught here (fast, no
 * infra) instead of crashing the app on startup.
 */
describe('first-party workflow template catalog', () => {
  const validSkills = new Set(SkillCatalog.list().map((s) => s.key));

  it('has 11 HR + 11 Marketing = 22 templates', () => {
    expect(HR_WORKFLOW_TEMPLATES).toHaveLength(11);
    expect(MARKETING_WORKFLOW_TEMPLATES).toHaveLength(11);
    expect(FIRST_PARTY_WORKFLOW_TEMPLATES).toHaveLength(22);
  });

  it('every (key,version) is unique', () => {
    const seen = new Set<string>();
    for (const t of FIRST_PARTY_WORKFLOW_TEMPLATES) {
      const id = `${t.key}@${t.version}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('every manifest passes validateManifest (the boot-seed gate)', () => {
    for (const manifest of FIRST_PARTY_WORKFLOW_TEMPLATES) {
      expect(() => validateManifest(manifest, validSkills)).not.toThrow();
    }
  });

  it('HR templates are category HR + require the HR role; Marketing are MARKETING', () => {
    for (const t of HR_WORKFLOW_TEMPLATES) {
      expect(t.category).toBe('HR');
      expect(t.requires.employeeRoles).toContain('HR');
      expect(t.key.startsWith('hr.')).toBe(true);
    }
    for (const t of MARKETING_WORKFLOW_TEMPLATES) {
      expect(t.category).toBe('MARKETING');
      expect(t.requires.employeeRoles).toContain('MARKETING');
      expect(t.key.startsWith('mkt.')).toBe(true);
    }
  });

  it('every requires.skill is a real catalog skill', () => {
    for (const t of FIRST_PARTY_WORKFLOW_TEMPLATES) {
      for (const skill of t.requires.skills) {
        expect(validSkills.has(skill)).toBe(true);
      }
    }
  });

  it('most templates carry a human APPROVAL gate (the spec mandates it for the majority)', () => {
    const withApproval = FIRST_PARTY_WORKFLOW_TEMPLATES.filter((t) =>
      t.definition.nodes.some((n) => n.type === 'APPROVAL'),
    );
    // 8 HR + 7 Marketing per docs 27/28 (social scheduling/publishing rely on the
    // highRisk auto-gate instead of an explicit APPROVAL node).
    expect(withApproval.length).toBeGreaterThanOrEqual(14);
  });
});
