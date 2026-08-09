import { SkillCapabilities } from './capabilities';
import { SkillCatalog } from './catalog';

describe('SkillCapabilities', () => {
  it('maps only real catalog (skill, tool) pairs — guards against drift', () => {
    for (const { skillKey, tool } of SkillCapabilities.allToolRefs()) {
      expect(SkillCatalog.getTool(skillKey, tool)).toBeDefined();
    }
  });

  it('resolves the same capability across compatible providers', () => {
    expect(SkillCapabilities.forTool('gmail', 'send_email')).toBe('EMAIL_SEND');
    expect(SkillCapabilities.forTool('email', 'send_email')).toBe('EMAIL_SEND');
  });

  it('returns undefined for a tool with no capability mapping', () => {
    expect(SkillCapabilities.forTool('gmail', 'not_a_tool')).toBeUndefined();
  });

  it('lists every compatible provider for a capability', () => {
    const email = SkillCapabilities.skillsFor('EMAIL_SEND');
    expect(email).toEqual(expect.arrayContaining(['gmail', 'email']));
  });

  it('offers alternatives that share a capability', () => {
    expect(SkillCapabilities.alternativesFor('gmail')).toContain('email');
  });

  it('reports connection requirement from the catalog', () => {
    expect(SkillCapabilities.requiresConnection('gmail')).toBe(true); // oauth
    expect(SkillCapabilities.requiresConnection('stripe')).toBe(true); // api_key
    expect(SkillCapabilities.requiresConnection('http')).toBe(false); // none
    expect(SkillCapabilities.requiresConnection('scheduling')).toBe(false); // none
  });

  it('exposes provider + display name', () => {
    expect(SkillCapabilities.displayName('gmail')).toBe('Gmail');
    expect(SkillCapabilities.provider('gmail')).toBe('google');
    expect(SkillCapabilities.provider('http')).toBeNull();
  });
});
