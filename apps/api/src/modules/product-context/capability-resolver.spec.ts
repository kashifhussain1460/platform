import type { EmployeeRole, ProductArea, SkillCapability } from '@vaep/types';
import { PRODUCT_AREAS } from '@vaep/types';
import { SkillCapabilities } from '../skills/capabilities';
import { SkillCatalog } from '../skills/catalog';
import {
  isMinimallyConfigured,
  resolveProductContext,
  resolveRelevantCapabilities,
  type CapabilityLookup,
  type CompanyContext,
} from './capability-resolver';

/**
 * Phase 3 — the A–H scenario matrix.
 *
 * Run against the PURE resolver, so every case is exhaustive, instant and free
 * of Postgres. This mirrors `authorization.policy.spec.ts`, which exists for
 * the same reason: a decision layer that can only be tested through HTTP is a
 * decision layer nobody tests thoroughly.
 */

/** The REAL capability registry — a stub here would test the stub. */
const lookup: CapabilityLookup = {
  skillsFor: (c: SkillCapability) => SkillCapabilities.skillsFor(c),
  capabilitiesFor: (k: string) => SkillCapabilities.capabilitiesFor(k),
  displayName: (k: string) => SkillCapabilities.displayName(k),
  executionSupport: (k: string) => SkillCatalog.get(k)?.executionSupport ?? 'SIMULATED',
  allSkillKeys: () => SkillCatalog.list().map((s) => s.key),
};

function ctx(over: Partial<CompanyContext> = {}): CompanyContext {
  return {
    companyId: 'co-1',
    company: { industry: null, size: null, businessGoals: [] },
    subscription: { plan: 'BUSINESS', maxEmployees: null, features: [] },
    departments: [],
    hiredEmployees: [],
    installedSkills: [],
    user: { userId: 'u-1', role: 'OWNER' },
    // Default to fully authorized so a case that is ABOUT relevance is not
    // silently passing because authorization removed the area instead.
    authorizedAreas: new Set(PRODUCT_AREAS),
    visibleEmployeeIds: [],
    templates: [],
    ...over,
  };
}

const employee = (role: EmployeeRole, id = `e-${role}`) => ({
  id,
  role,
  status: 'ACTIVE',
});

const resolve = (over: Partial<CompanyContext> = {}) =>
  resolveProductContext(ctx(over), lookup);

const recommends = (result: ReturnType<typeof resolve>, skillKey: string) =>
  result.recommendedSkills.some((r) => r.skillKey === skillKey);

describe('capability resolver', () => {
  // ── A ────────────────────────────────────────────────────────────────────
  describe('A. HR-focused company', () => {
    const hr = () =>
      resolve({
        company: {
          industry: 'Professional Services',
          size: '11-50',
          businessGoals: ['Recruitment', 'Interview Scheduling'],
        },
        departments: ['HR', 'Recruitment'],
        hiredEmployees: [employee('HR'), employee('RECRUITER')],
      });

    it('unlocks interview scheduling', () => {
      expect(hr().productAreas).toContain('INTERVIEW_SCHEDULING');
      expect(hr().areaReasons.INTERVIEW_SCHEDULING).toBe('HIRED_EMPLOYEE');
    });

    it('recommends calendar and email, the capabilities HR actually needs', () => {
      const result = hr();
      expect(recommends(result, 'calendar')).toBe(true);
      expect(
        result.recommendedSkills.some((r) => r.capability === 'EMAIL_SEND'),
      ).toBe(true);
    });

    it('explains WHY, naming the configuration that caused it', () => {
      const calendar = hr().recommendedSkills.find((r) => r.skillKey === 'calendar');
      expect(calendar?.because).toMatch(/AI Employee needs this|goal|department/i);
    });

    it('surfaces HR dashboard sections', () => {
      expect(hr().dashboardCapabilities).toEqual(
        expect.arrayContaining(['EMPLOYEE_HR', 'EMPLOYEE_RECRUITER', 'COMPANY_SUMMARY']),
      );
    });

    it('does NOT recommend social publishing', () => {
      expect(recommends(hr(), 'postiz')).toBe(false);
    });
  });

  // ── B ────────────────────────────────────────────────────────────────────
  describe('B. Marketing-focused company', () => {
    const marketing = () =>
      resolve({
        company: {
          industry: 'Retail / Ecommerce',
          size: '11-50',
          businessGoals: ['Social Media', 'Email Marketing'],
        },
        departments: ['Marketing'],
        hiredEmployees: [employee('MARKETING')],
      });

    it('recommends social publishing', () => {
      expect(recommends(marketing(), 'postiz')).toBe(true);
    });

    it('does NOT unlock interview scheduling', () => {
      expect(marketing().productAreas).not.toContain('INTERVIEW_SCHEDULING');
    });

    it('reads the free-text industry through normalisation', () => {
      // 'Retail / Ecommerce' → RETAIL_ECOMMERCE. The column is free text, so a
      // literal key lookup would silently match nothing.
      const caps = resolveRelevantCapabilities(
        ctx({
          company: {
            industry: 'Retail / Ecommerce',
            size: null,
            businessGoals: [],
          },
        }),
      );
      expect(caps.has('SUPPORT_REPLY')).toBe(true);
      expect(caps.get('SUPPORT_REPLY')).toBe('INDUSTRY');
    });

    it('reads business goals — the column nothing consumed before', () => {
      const caps = resolveRelevantCapabilities(
        ctx({
          company: { industry: null, size: null, businessGoals: ['Social Media'] },
        }),
      );
      expect(caps.get('SOCIAL_PUBLISH')).toBe('BUSINESS_GOAL');
    });
  });

  // ── C ────────────────────────────────────────────────────────────────────
  describe('C. Support-focused company', () => {
    const support = () =>
      resolve({
        company: { industry: 'Technology', size: '51-200', businessGoals: [] },
        departments: ['Customer Support'],
        hiredEmployees: [employee('SUPPORT')],
      });

    it('recommends a support-reply provider', () => {
      expect(
        support().recommendedSkills.some((r) => r.capability === 'SUPPORT_REPLY'),
      ).toBe(true);
    });

    it('resolves the "Customer Support" preset name to the SUPPORT role', () => {
      const caps = resolveRelevantCapabilities(
        ctx({ departments: ['Customer Support'] }),
      );
      expect(caps.get('SUPPORT_REPLY')).toBe('DEPARTMENT');
    });

    it('does not unlock interview scheduling', () => {
      expect(support().productAreas).not.toContain('INTERVIEW_SCHEDULING');
    });
  });

  // ── D ────────────────────────────────────────────────────────────────────
  describe('D. Multi-department company', () => {
    const multi = () =>
      resolve({
        company: {
          industry: 'Technology',
          size: '201-500',
          businessGoals: ['Recruitment', 'Social Media'],
        },
        departments: ['HR', 'Marketing', 'Engineering'],
        hiredEmployees: [
          employee('HR'),
          employee('MARKETING'),
          employee('PROJECT_MANAGER'),
        ],
      });

    it('unions the areas of every hired role', () => {
      expect(multi().productAreas).toContain('INTERVIEW_SCHEDULING');
    });

    it('unions capabilities across roles, goals, industry and departments', () => {
      const caps = resolveRelevantCapabilities(
        ctx({
          company: {
            industry: 'Technology',
            size: null,
            businessGoals: ['Recruitment', 'Social Media'],
          },
          departments: ['HR', 'Marketing', 'Engineering'],
          hiredEmployees: [employee('HR'), employee('MARKETING')],
        }),
      );
      expect(caps.has('CALENDAR_EVENT_CREATE')).toBe(true); // HR employee
      expect(caps.has('SOCIAL_PUBLISH')).toBe(true); // Marketing employee + goal
      expect(caps.has('ISSUE_TRACKING_WRITE')).toBe(true); // Technology + Engineering
    });

    it('prefers the strongest reason when several apply', () => {
      // A hire is a fact; an industry is a guess. The explanation should say so.
      const caps = resolveRelevantCapabilities(
        ctx({
          company: { industry: 'Retail / Ecommerce', size: null, businessGoals: [] },
          hiredEmployees: [employee('SUPPORT')],
        }),
      );
      expect(caps.get('SUPPORT_REPLY')).toBe('HIRED_EMPLOYEE');
    });

    it('lists each dashboard section once', () => {
      const sections = multi().dashboardCapabilities;
      expect(new Set(sections).size).toBe(sections.length);
    });
  });

  // ── E ────────────────────────────────────────────────────────────────────
  describe('E. Company with minimal configuration', () => {
    const bare = () => resolve();

    it('is detected as unconfigured', () => {
      expect(isMinimallyConfigured(ctx())).toBe(true);
      expect(bare().configuration.isMinimallyConfigured).toBe(true);
    });

    it('gets the WHOLE product, not a guess', () => {
      // The critical back-compat case: every tenant onboarded before Phase 2
      // looks exactly like this, and none of them may wake up to a smaller app.
      for (const area of PRODUCT_AREAS) {
        expect(bare().productAreas).toContain(area);
      }
    });

    it('labels the reason honestly', () => {
      expect(bare().areaReasons.INTERVIEW_SCHEDULING).toBe('NO_CONFIGURATION');
    });

    it('treats every installed skill as relevant', () => {
      const result = resolve({
        installedSkills: [{ skillKey: 'stripe', connectionStatus: 'CONNECTED' }],
      });
      // Never tell someone the skill they deliberately connected is irrelevant.
      expect(result.relevantSkills).toContain('stripe');
    });

    it('recommends nothing it cannot justify', () => {
      expect(bare().recommendedSkills).toEqual([]);
    });

    it('survives a company that is unconfigured AND has one employee', () => {
      // One hire is enough signal to stop being "unconfigured".
      const result = resolve({ hiredEmployees: [employee('MARKETING')] });
      expect(result.configuration.isMinimallyConfigured).toBe(false);
      expect(result.productAreas).not.toContain('INTERVIEW_SCHEDULING');
    });
  });

  // ── F ────────────────────────────────────────────────────────────────────
  describe('F. Subscription plans', () => {
    const onPlan = (plan: 'STARTER' | 'PRO' | 'BUSINESS' | 'ENTERPRISE') =>
      resolve({
        subscription: { plan, maxEmployees: null, features: [] },
        hiredEmployees: [employee('HR')],
      });

    it('STARTER does not get AI Assist', () => {
      // The exact bug the audit found: the sidebar offered `/assist` to every
      // STARTER user and the controller answered 403.
      expect(onPlan('STARTER').productAreas).not.toContain('ASSIST');
    });

    it('PRO does not get AI Assist either', () => {
      expect(onPlan('PRO').productAreas).not.toContain('ASSIST');
    });

    it('BUSINESS and ENTERPRISE do', () => {
      expect(onPlan('BUSINESS').productAreas).toContain('ASSIST');
      expect(onPlan('ENTERPRISE').productAreas).toContain('ASSIST');
    });

    it('reports WHAT is locked and the tier that unlocks it', () => {
      // Locked, not hidden — the UI can offer an upgrade instead of pretending
      // the feature does not exist.
      expect(onPlan('STARTER').entitlements.lockedAreas).toEqual([
        { area: 'ASSIST', requiresPlan: 'BUSINESS' },
      ]);
      expect(onPlan('BUSINESS').entitlements.lockedAreas).toEqual([]);
    });

    it('marks a template the plan cannot install', () => {
      const result = resolve({
        subscription: { plan: 'STARTER', maxEmployees: 2, features: [] },
        hiredEmployees: [employee('HR')],
        templates: [
          {
            id: 't1',
            key: 'hr.enterprise-thing',
            name: 'Enterprise thing',
            category: 'HR',
            requires: { skills: [], employeeRoles: [], minPlan: 'ENTERPRISE' },
          },
        ],
      });
      expect(result.availableWorkflowTemplates[0]).toMatchObject({
        ready: false,
        requiresPlan: 'ENTERPRISE',
      });
    });
  });

  // ── G ────────────────────────────────────────────────────────────────────
  describe('G. Department-scoped user', () => {
    it('cannot see areas the authorization layer denied', () => {
      // Relevance NEVER widens. Even a perfectly relevant area disappears when
      // the policy says no.
      const result = resolve({
        hiredEmployees: [employee('HR')],
        authorizedAreas: new Set<ProductArea>(['DASHBOARD', 'EMPLOYEES']),
      });
      expect(result.productAreas).toEqual(['DASHBOARD', 'EMPLOYEES']);
      expect(result.productAreas).not.toContain('INTERVIEW_SCHEDULING');
    });

    it('carries through only the employees the policy already filtered', () => {
      const result = resolve({
        hiredEmployees: [employee('HR', 'e-hr'), employee('MARKETING', 'e-mkt')],
        visibleEmployeeIds: ['e-hr'],
      });
      expect(result.relevantEmployeeIds).toEqual(['e-hr']);
    });

    it('an unconfigured company still cannot see unauthorized areas', () => {
      // The NO_CONFIGURATION widening applies to RELEVANCE only — it must not
      // punch through the authorization intersection.
      const result = resolve({
        authorizedAreas: new Set<ProductArea>(['DASHBOARD']),
      });
      expect(result.productAreas).toEqual(['DASHBOARD']);
    });

    it('a MEMBER is not offered Organization or System health', () => {
      const result = resolve({ user: { userId: 'u-2', role: 'MEMBER' } });
      expect(result.productAreas).not.toContain('ORGANIZATION');
      expect(result.productAreas).not.toContain('ADMIN_HEALTH');
    });
  });

  // ── H ────────────────────────────────────────────────────────────────────
  describe('H. Owner / admin', () => {
    it('an OWNER is offered the admin areas', () => {
      const result = resolve({ user: { userId: 'u-1', role: 'OWNER' } });
      expect(result.productAreas).toContain('ORGANIZATION');
      expect(result.productAreas).toContain('ADMIN_HEALTH');
    });

    it('an ADMIN is too', () => {
      const result = resolve({ user: { userId: 'u-3', role: 'ADMIN' } });
      expect(result.productAreas).toContain('ORGANIZATION');
    });

    it('being OWNER does not bypass the PLAN gate', () => {
      // Entitlement and authorization are different questions. An owner on
      // STARTER still has not paid for Assist.
      const result = resolve({
        user: { userId: 'u-1', role: 'OWNER' },
        subscription: { plan: 'STARTER', maxEmployees: 2, features: [] },
        hiredEmployees: [employee('HR')],
      });
      expect(result.productAreas).not.toContain('ASSIST');
    });
  });

  // ── Cross-cutting ────────────────────────────────────────────────────────
  describe('determinism', () => {
    const rich = (): Partial<CompanyContext> => ({
      company: {
        industry: 'Technology',
        size: '51-200',
        businessGoals: ['Recruitment', 'Social Media', 'Lead Generation'],
      },
      departments: ['HR', 'Marketing', 'Sales'],
      hiredEmployees: [employee('HR'), employee('MARKETING'), employee('SALES')],
      installedSkills: [{ skillKey: 'gmail', connectionStatus: 'CONNECTED' }],
    });

    it('produces byte-identical output for identical input', () => {
      expect(JSON.stringify(resolve(rich()))).toBe(JSON.stringify(resolve(rich())));
    });

    it('is order-independent in its inputs', () => {
      const a = resolve(rich());
      const base = rich();
      const b = resolve({
        ...base,
        departments: [...(base.departments ?? [])].reverse(),
        hiredEmployees: [...(base.hiredEmployees ?? [])].reverse(),
      });
      // Reversing the input lists must not reorder the answer, or the UI
      // reshuffles itself on every unrelated write.
      expect(b.productAreas).toEqual(a.productAreas);
      expect(b.relevantSkills).toEqual(a.relevantSkills);
      expect(b.recommendedSkills.map((r) => r.skillKey)).toEqual(
        a.recommendedSkills.map((r) => r.skillKey),
      );
    });
  });

  describe('never recommends a fake integration', () => {
    it('skips SIMULATED skills entirely', () => {
      // hubspot/jira/github/stripe have OAuth and no real executor (Phase 1).
      // Recommending one is the CONNECTED-and-does-nothing lie in a new costume.
      const result = resolve({
        company: {
          industry: 'Professional Services',
          size: null,
          businessGoals: ['Lead Generation'],
        },
        hiredEmployees: [employee('SALES'), employee('PROJECT_MANAGER')],
      });
      for (const rec of result.recommendedSkills) {
        expect(rec.executionSupport).not.toBe('SIMULATED');
      }
      expect(recommends(result, 'hubspot')).toBe(false);
      expect(recommends(result, 'jira')).toBe(false);
    });
  });

  describe('template readiness', () => {
    it('is ready when every prerequisite is already satisfied', () => {
      const result = resolve({
        hiredEmployees: [employee('HR')],
        installedSkills: [{ skillKey: 'gmail', connectionStatus: 'CONNECTED' }],
        templates: [
          {
            id: 't1',
            key: 'hr.onboard',
            name: 'Onboard',
            category: 'HR',
            requires: { skills: ['gmail'], employeeRoles: ['HR'] },
          },
        ],
      });
      expect(result.availableWorkflowTemplates[0].ready).toBe(true);
    });

    it('names exactly what is missing instead of just refusing', () => {
      const result = resolve({
        templates: [
          {
            id: 't1',
            key: 'hr.onboard',
            name: 'Onboard',
            category: 'HR',
            requires: { skills: ['gmail'], employeeRoles: ['HR'] },
          },
        ],
      });
      expect(result.availableWorkflowTemplates[0]).toMatchObject({
        ready: false,
        missingSkills: ['gmail'],
        missingEmployeeRoles: ['HR'],
      });
    });

    it('tolerates a template with no requires block', () => {
      const result = resolve({
        templates: [
          {
            id: 't1',
            key: 'x',
            name: 'X',
            category: 'CUSTOM',
            requires: { skills: [], employeeRoles: [] },
          },
        ],
      });
      expect(result.availableWorkflowTemplates[0].ready).toBe(true);
    });
  });

  describe('graceful degradation', () => {
    it('ignores an unknown industry rather than failing', () => {
      const result = resolve({
        company: { industry: 'Underwater Basket Weaving', size: null, businessGoals: [] },
        hiredEmployees: [employee('HR')],
      });
      expect(result.configuration.industry).toBe('Underwater Basket Weaving');
      expect(result.productAreas).toContain('INTERVIEW_SCHEDULING');
    });

    it('ignores an unknown goal and an unknown department', () => {
      const caps = resolveRelevantCapabilities(
        ctx({
          company: { industry: null, size: null, businessGoals: ['Time Travel'] },
          departments: ['Ministry of Silly Walks'],
        }),
      );
      expect(caps.size).toBe(0);
    });

    it('echoes the configuration so a caller can explain the answer', () => {
      const result = resolve({
        company: { industry: 'Finance', size: '5000+', businessGoals: ['SEO'] },
        departments: ['Finance'],
        hiredEmployees: [employee('ACCOUNTANT')],
      });
      expect(result.configuration).toMatchObject({
        industry: 'Finance',
        size: '5000+',
        businessGoals: ['SEO'],
        departments: ['Finance'],
        hiredEmployeeRoles: ['ACCOUNTANT'],
      });
    });
  });

  describe('navigation', () => {
    it('emits one entry per resolved area, and nothing else', () => {
      const result = resolve({ hiredEmployees: [employee('MARKETING')] });
      expect(result.navigation.map((n) => n.area)).toEqual(result.productAreas);
    });

    it('gives every entry a route and a group', () => {
      for (const item of resolve().navigation) {
        expect(item.href.startsWith('/')).toBe(true);
        expect(['PRIMARY', 'AUTOMATION', 'SECONDARY', 'ADMIN']).toContain(item.group);
      }
    });
  });
});

/**
 * Phase 4 §3 — skill categorisation.
 *
 * The rule that matters most here is the negative one: relevance must never
 * remove access to a skill a company is legitimately allowed to use. These
 * tests assert the catalog stays whole.
 */
describe('skill statuses (Phase 4 §3)', () => {
  const allKeys = () => SkillCatalog.list().map((s) => s.key);

  it('categorises EVERY catalog skill, with no duplicates', () => {
    const result = resolve();
    expect(result.skillStatuses).toHaveLength(allKeys().length);
    expect(new Set(result.skillStatuses.map((s) => s.skillKey)).size).toBe(
      allKeys().length,
    );
  });

  it('never drops a skill just because it is not recommended', () => {
    // A tightly-configured HR company must still be able to find and install
    // Slack. Relevance sorts the catalog; it does not shorten it.
    const result = resolve({
      company: {
        industry: 'Professional Services',
        size: '1-10',
        businessGoals: ['Recruitment'],
      },
      hiredEmployees: [employee('HR')],
    });
    expect(result.skillStatuses.map((s) => s.skillKey).sort()).toEqual(allKeys().sort());
  });

  it('marks an installed + CONNECTED skill as CONNECTED', () => {
    const result = resolve({
      installedSkills: [{ skillKey: 'slack', connectionStatus: 'CONNECTED' }],
    });
    expect(result.skillStatuses.find((s) => s.skillKey === 'slack')?.status).toBe(
      'CONNECTED',
    );
  });

  it.each(['NOT_CONNECTED', 'DEGRADED', 'DISCONNECTED'])(
    'marks an installed skill in %s as NEEDS_CONFIGURATION',
    (connectionStatus) => {
      // The state that used to be invisible: `connectionStatus` was loaded by
      // the resolver and read by nothing, so a revoked connector looked fine.
      const result = resolve({
        installedSkills: [{ skillKey: 'slack', connectionStatus }],
      });
      const slack = result.skillStatuses.find((s) => s.skillKey === 'slack');
      expect(slack?.status).toBe('NEEDS_CONFIGURATION');
      expect(slack?.connectionStatus).toBe(connectionStatus);
    },
  );

  it('marks a configuration-matched, uninstalled skill as RECOMMENDED with a reason', () => {
    const result = resolve({ hiredEmployees: [employee('MARKETING')] });
    const postiz = result.skillStatuses.find((s) => s.skillKey === 'postiz');
    expect(postiz?.status).toBe('RECOMMENDED');
    expect(postiz?.because).toBeTruthy();
  });

  it('marks an unmatched, uninstalled skill as AVAILABLE, not hidden', () => {
    const result = resolve({ hiredEmployees: [employee('MARKETING')] });
    const scheduling = result.skillStatuses.find((s) => s.skillKey === 'scheduling');
    expect(scheduling?.status).toBe('AVAILABLE');
    expect(scheduling?.because).toBeNull();
  });

  it('marks executor-less skills as SIMULATED_ONLY and never RECOMMENDED', () => {
    const result = resolve({
      hiredEmployees: [employee('SALES'), employee('PROJECT_MANAGER')],
    });
    for (const key of ['hubspot', 'jira', 'github', 'stripe']) {
      expect(result.skillStatuses.find((s) => s.skillKey === key)?.status).toBe(
        'SIMULATED_ONLY',
      );
    }
  });

  it('an INSTALLED simulated skill still reports its connection state', () => {
    // Installed wins over SIMULATED_ONLY: the customer needs to know the
    // connector is broken even when the executor is a sandbox.
    const result = resolve({
      installedSkills: [{ skillKey: 'hubspot', connectionStatus: 'CONNECTED' }],
    });
    expect(result.skillStatuses.find((s) => s.skillKey === 'hubspot')?.status).toBe(
      'CONNECTED',
    );
  });

  it('orders by actionability, then alphabetically — deterministically', () => {
    const result = resolve({
      hiredEmployees: [employee('MARKETING')],
      installedSkills: [{ skillKey: 'slack', connectionStatus: 'DEGRADED' }],
    });
    expect(result.skillStatuses[0].status).toBe('NEEDS_CONFIGURATION');
    const order = ['NEEDS_CONFIGURATION', 'RECOMMENDED', 'CONNECTED', 'AVAILABLE', 'SIMULATED_ONLY'];
    const ranks = result.skillStatuses.map((s) => order.indexOf(s.status));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
