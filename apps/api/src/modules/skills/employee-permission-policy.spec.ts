import { EMPLOYEE_PERMISSION_KEYS, SKILL_CAPABILITIES } from '@vaep/types';
import { SkillCatalog } from './catalog';
import { SkillCapabilities } from './capabilities';
import {
  EMPLOYEE_PERMISSION_CAPABILITIES,
  knowledgeRetrievalAllowed,
  permissionDenialFor,
} from './employee-permission-policy';

/**
 * Phase 1 — these flags used to be decoration. The whole point of this suite is
 * that a future refactor cannot quietly make them decoration again.
 */
describe('employee permission policy', () => {
  describe('registry integrity', () => {
    it('covers every permission key exactly once', () => {
      expect(Object.keys(EMPLOYEE_PERMISSION_CAPABILITIES).sort()).toEqual(
        [...EMPLOYEE_PERMISSION_KEYS].sort(),
      );
    });

    it('only references capabilities that exist', () => {
      for (const [key, caps] of Object.entries(EMPLOYEE_PERMISSION_CAPABILITIES)) {
        for (const cap of caps) {
          expect(SKILL_CAPABILITIES).toContain(cap);
          // A capability with no (skill, tool) pair behind it would make the
          // flag unenforceable without anything failing.
          expect(SkillCapabilities.skillsFor(cap).length).toBeGreaterThan(0);
          expect(typeof key).toBe('string');
        }
      }
    });
  });

  describe('three-valued semantics', () => {
    it('allows when the permissions object is absent (back-compat)', () => {
      expect(permissionDenialFor(null, 'gmail', 'send_email')).toBeNull();
      expect(permissionDenialFor(undefined, 'gmail', 'send_email')).toBeNull();
      expect(permissionDenialFor({}, 'gmail', 'send_email')).toBeNull();
    });

    it('allows when the key is absent but others are present', () => {
      expect(
        permissionDenialFor({ makePayments: false }, 'gmail', 'send_email'),
      ).toBeNull();
    });

    it('allows when explicitly true', () => {
      expect(
        permissionDenialFor({ sendEmail: true }, 'gmail', 'send_email'),
      ).toBeNull();
    });

    it('DENIES when explicitly false', () => {
      const denial = permissionDenialFor({ sendEmail: false }, 'gmail', 'send_email');
      expect(denial).not.toBeNull();
      expect(denial?.permission).toBe('sendEmail');
      expect(denial?.capability).toBe('EMAIL_SEND');
      expect(denial?.reason).toContain('Send email');
    });

    it('ignores a non-boolean value rather than treating it as denial', () => {
      // Garbage in the JSON column must not silently disable a live employee.
      expect(
        permissionDenialFor({ sendEmail: 'no' } as never, 'gmail', 'send_email'),
      ).toBeNull();
    });
  });

  describe('capability coverage — the reason this maps to capabilities, not tools', () => {
    it('sendEmail denies EVERY provider of EMAIL_SEND, not just gmail', () => {
      for (const { skillKey, tool } of [
        { skillKey: 'gmail', tool: 'send_email' },
        { skillKey: 'email', tool: 'send_email' },
      ]) {
        expect(permissionDenialFor({ sendEmail: false }, skillKey, tool)).not.toBeNull();
      }
    });

    it('makePayments denies PAYMENTS_WRITE but not PAYMENTS_READ', () => {
      expect(
        permissionDenialFor({ makePayments: false }, 'stripe', 'create_payment_link'),
      ).not.toBeNull();
      // Reading a balance moves no money.
      expect(
        permissionDenialFor({ makePayments: false }, 'stripe', 'get_balance'),
      ).toBeNull();
      expect(
        permissionDenialFor({ makePayments: false }, 'stripe', 'list_charges'),
      ).toBeNull();
    });

    it('contactCustomers denies the person-facing capabilities', () => {
      for (const { skillKey, tool } of [
        { skillKey: 'gmail', tool: 'send_email' },
        { skillKey: 'slack', tool: 'send_message' },
        { skillKey: 'chatwoot', tool: 'reply_to_conversation' },
      ]) {
        expect(
          permissionDenialFor({ contactCustomers: false }, skillKey, tool),
        ).not.toBeNull();
      }
    });

    it('leaves tools outside the capability map alone', () => {
      // `http.request` is HTTP_REQUEST, governed by none of today's four flags.
      // It is still subject to the EmployeeSkill grant, the approval gate and
      // the suppression list — this policy is a restriction layer, not the only
      // layer.
      const allFalse = {
        sendEmail: false,
        contactCustomers: false,
        makePayments: false,
        accessKnowledge: false,
      };
      expect(permissionDenialFor(allFalse, 'http', 'request')).toBeNull();
      expect(permissionDenialFor(allFalse, 'gdrive', 'list_files')).toBeNull();
    });

    it('returns null for a tool that is not in the catalog at all', () => {
      expect(permissionDenialFor({ sendEmail: false }, 'nope', 'nope')).toBeNull();
      expect(SkillCatalog.getTool('nope', 'nope')).toBeUndefined();
    });
  });

  describe('knowledgeRetrievalAllowed — the stricter of two controls wins', () => {
    it('allows when both controls are permissive', () => {
      expect(knowledgeRetrievalAllowed({ knowledgeAccess: 'ALL' })).toBe(true);
      expect(
        knowledgeRetrievalAllowed({
          knowledgeAccess: 'ALL',
          permissions: { accessKnowledge: true },
        }),
      ).toBe(true);
    });

    it('denies on the knowledgeAccess enum alone (unchanged behaviour)', () => {
      expect(knowledgeRetrievalAllowed({ knowledgeAccess: 'NONE' })).toBe(false);
    });

    it('denies on the permission flag alone (the new half)', () => {
      expect(
        knowledgeRetrievalAllowed({
          knowledgeAccess: 'ALL',
          permissions: { accessKnowledge: false },
        }),
      ).toBe(false);
    });
  });
});
