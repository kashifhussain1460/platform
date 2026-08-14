import { decide, normalizeScope, roleSatisfies } from './authorization.policy';
import type { AuthzActor, AuthzResource } from './authorization.types';

const actor = (over: Partial<AuthzActor> = {}): AuthzActor => ({
  userId: 'u1',
  companyId: 'co1',
  role: 'ADMIN',
  status: 'ACTIVE',
  ...over,
});

const resource = (over: Partial<AuthzResource> = {}): AuthzResource => ({
  type: 'workflow',
  companyId: 'co1',
  ...over,
});

const marketing = { id: 'd1', name: 'Marketing', scopes: ['MARKETING'] };
const hr = { id: 'd2', name: 'People', scopes: ['HR', 'RECRUITMENT'] };
const unscoped = { id: 'd3', name: 'General', scopes: [] as string[] };

describe('authorization policy', () => {
  describe('tenant isolation', () => {
    it('denies a cross-tenant resource even for an OWNER', () => {
      // Checked FIRST, before any role rule — otherwise the owner shortcut
      // would hand an owner another company's data.
      const d = decide({
        actor: actor({ role: 'OWNER' }),
        action: 'workflow:read',
        resource: resource({ companyId: 'other-co' }),
      });
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe('tenant');
    });
  });

  describe('account status', () => {
    it('denies a DISABLED user regardless of role', () => {
      // A disabled account keeps a valid JWT until it expires, so every path
      // has to re-check — not just login.
      const d = decide({
        actor: actor({ role: 'OWNER', status: 'DISABLED' }),
        action: 'workflow:read',
        resource: resource(),
      });
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe('user-status');
    });
  });

  describe('role floor', () => {
    it('lets a MEMBER read a workflow', () => {
      expect(
        decide({
          actor: actor({ role: 'MEMBER' }),
          action: 'workflow:read',
          resource: resource(),
        }).allowed,
      ).toBe(true);
    });

    it('denies a MEMBER the HR domain — reads included', () => {
      const d = decide({
        actor: actor({ role: 'MEMBER' }),
        action: 'hr:read',
        resource: resource({ type: 'hr' }),
      });
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe('role');
    });

    it('denies a MEMBER a high-risk approval decision', () => {
      expect(
        decide({
          actor: actor({ role: 'MEMBER' }),
          action: 'approval:decide',
          resource: resource({ type: 'approval' }),
        }).allowed,
      ).toBe(false);
    });

    it('fails CLOSED on an unknown action', () => {
      // A typo'd action string silently allowing everything is the worst
      // failure mode this layer could have.
      const d = decide({
        actor: actor({ role: 'OWNER' }),
        action: 'workflow:teleport' as never,
        resource: resource(),
      });
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe('unknown-action');
    });

    it('honours the OWNER ⊇ ADMIN ⊇ MEMBER hierarchy', () => {
      expect(roleSatisfies('OWNER', 'ADMIN')).toBe(true);
      expect(roleSatisfies('ADMIN', 'OWNER')).toBe(false);
      expect(roleSatisfies('MEMBER', 'MEMBER')).toBe(true);
    });
  });

  describe('department isolation (plan §7.2)', () => {
    it('Marketing Admin → Marketing = ALLOW', () => {
      expect(
        decide({
          actor: actor({ departmentId: 'd1' }),
          action: 'workflow:run',
          resource: resource({ scope: 'MARKETING' }),
          department: marketing,
        }).allowed,
      ).toBe(true);
    });

    it('Marketing Admin → HR = DENY', () => {
      const d = decide({
        actor: actor({ departmentId: 'd1' }),
        action: 'workflow:run',
        resource: resource({ scope: 'HR' }),
        department: marketing,
      });
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe('department-scope');
      // The reason names both sides — "Insufficient role" with no detail is
      // why authorization bugs take days to diagnose.
      expect(d.reason).toContain('Marketing');
      expect(d.reason).toContain('HR');
    });

    it('HR Admin → HR = ALLOW, HR Admin → Marketing = DENY', () => {
      expect(
        decide({
          actor: actor({ departmentId: 'd2' }),
          action: 'employee:read',
          resource: resource({ type: 'employee', scope: 'HR' }),
          department: hr,
        }).allowed,
      ).toBe(true);
      expect(
        decide({
          actor: actor({ departmentId: 'd2' }),
          action: 'employee:read',
          resource: resource({ type: 'employee', scope: 'MARKETING' }),
          department: hr,
        }).allowed,
      ).toBe(false);
    });

    it('a department may hold several scopes', () => {
      expect(
        decide({
          actor: actor({ departmentId: 'd2' }),
          action: 'workflow:read',
          resource: resource({ scope: 'RECRUITMENT' }),
          department: hr,
        }).allowed,
      ).toBe(true);
    });

    it('an OWNER is never department-scoped', () => {
      // Otherwise an owner placed in a department could lock themselves out of
      // their own company and nobody could undo it.
      const d = decide({
        actor: actor({ role: 'OWNER', departmentId: 'd1' }),
        action: 'workflow:run',
        resource: resource({ scope: 'HR' }),
        department: marketing,
      });
      expect(d.allowed).toBe(true);
      expect(d.rule).toBe('owner');
    });

    it('an unscoped resource stays visible to a scoped department', () => {
      // Shared knowledge / an uncategorised workflow belongs to no department,
      // so there is nothing to isolate it from.
      const d = decide({
        actor: actor({ departmentId: 'd1' }),
        action: 'workflow:read',
        resource: resource({ scope: null }),
        department: marketing,
      });
      expect(d.allowed).toBe(true);
      expect(d.rule).toBe('unscoped-resource');
    });
  });

  describe('ships inert', () => {
    it('a user with no department is unrestricted', () => {
      const d = decide({
        actor: actor(),
        action: 'workflow:run',
        resource: resource({ scope: 'HR' }),
        department: null,
      });
      expect(d.allowed).toBe(true);
      expect(d.rule).toBe('unscoped-actor');
    });

    it('a department with NO scopes restricts nothing', () => {
      // THE safety property: every existing tenant looks like this, so turning
      // the layer on changes nothing until scopes are configured. An authz
      // change that starts denying live users reads as an outage.
      const d = decide({
        actor: actor({ departmentId: 'd3' }),
        action: 'workflow:run',
        resource: resource({ scope: 'HR' }),
        department: unscoped,
      });
      expect(d.allowed).toBe(true);
      expect(d.rule).toBe('unscoped-actor');
    });
  });

  describe('scope normalisation', () => {
    it('treats spacing, case and separators as one scope', () => {
      // Scope names come from three enums plus human-typed department config.
      expect(normalizeScope('Project Manager')).toBe('PROJECT_MANAGER');
      expect(normalizeScope('project-manager')).toBe('PROJECT_MANAGER');
      expect(normalizeScope('  hr ')).toBe('HR');
    });

    it('matches a human-typed department scope against an enum value', () => {
      expect(
        decide({
          actor: actor({ departmentId: 'd1' }),
          action: 'employee:read',
          resource: resource({ type: 'employee', scope: 'PROJECT_MANAGER' }),
          department: { id: 'd1', name: 'PMO', scopes: ['Project Manager'] },
        }).allowed,
      ).toBe(true);
    });
  });
});
