import type { PrismaService } from '../../common/prisma/prisma.service';
import { ApprovalRoutingService, type DeciderUser } from './approval-routing.service';

/**
 * Unit tests for approval routing (P3-05 §8.1). `canDecide` is pure; `resolveStep`
 * touches Prisma only for EMPLOYEE_MANAGER, which is stubbed. Includes the single
 * regression test §8.1.11 says this phase must not ship without: an UNROUTED
 * request is decidable ONLY by OWNER/ADMIN, byte-for-byte today's rule.
 */
describe('ApprovalRoutingService', () => {
  const findFirst = jest.fn();
  const prisma = { aiEmployee: { findFirst } } as unknown as PrismaService;
  const svc = new ApprovalRoutingService(prisma);

  const user = (over: Partial<DeciderUser>): DeciderUser => ({
    id: 'u1',
    role: 'MEMBER',
    departmentId: null,
    teamId: null,
    ...over,
  });

  describe('canDecide — UNROUTED (§8.1.11 mandatory regression)', () => {
    const unrouted = { approverRuleType: null, approverRuleValue: null, assigneeUserId: null };
    it('OWNER and ADMIN may decide; MEMBER may NOT (exactly today\'s rule)', () => {
      expect(svc.canDecide(user({ role: 'OWNER' }), unrouted)).toBe(true);
      expect(svc.canDecide(user({ role: 'ADMIN' }), unrouted)).toBe(true);
      expect(svc.canDecide(user({ role: 'MEMBER' }), unrouted)).toBe(false);
    });
  });

  describe('canDecide — routed rules', () => {
    it('ANY_ADMIN: OWNER/ADMIN yes, MEMBER no', () => {
      const req = { approverRuleType: 'ANY_ADMIN' as const, approverRuleValue: null, assigneeUserId: null };
      expect(svc.canDecide(user({ role: 'ADMIN' }), req)).toBe(true);
      expect(svc.canDecide(user({ role: 'MEMBER' }), req)).toBe(false);
    });

    it('ROLE: satisfied via the role hierarchy', () => {
      const req = { approverRuleType: 'ROLE' as const, approverRuleValue: 'MEMBER', assigneeUserId: null };
      expect(svc.canDecide(user({ role: 'MEMBER' }), req)).toBe(true); // any member qualifies
      const adminReq = { approverRuleType: 'ROLE' as const, approverRuleValue: 'ADMIN', assigneeUserId: null };
      expect(svc.canDecide(user({ role: 'MEMBER' }), adminReq)).toBe(false);
      expect(svc.canDecide(user({ role: 'OWNER' }), adminReq)).toBe(true); // OWNER ⊇ ADMIN
    });

    it('USER: only the named user (a MEMBER)', () => {
      const req = { approverRuleType: 'USER' as const, approverRuleValue: 'u1', assigneeUserId: 'u1' };
      expect(svc.canDecide(user({ id: 'u1', role: 'MEMBER' }), req)).toBe(true);
      expect(svc.canDecide(user({ id: 'u2', role: 'ADMIN' }), req)).toBe(false); // even an admin can't
    });

    it('DEPARTMENT / TEAM: only a matching membership', () => {
      const dept = { approverRuleType: 'DEPARTMENT' as const, approverRuleValue: 'd1', assigneeUserId: null };
      expect(svc.canDecide(user({ departmentId: 'd1' }), dept)).toBe(true);
      expect(svc.canDecide(user({ departmentId: 'd2' }), dept)).toBe(false);
      expect(svc.canDecide(user({ departmentId: null }), dept)).toBe(false);
      const team = { approverRuleType: 'TEAM' as const, approverRuleValue: 't1', assigneeUserId: null };
      expect(svc.canDecide(user({ teamId: 't1' }), team)).toBe(true);
      expect(svc.canDecide(user({ teamId: null }), team)).toBe(false);
    });

    it('EMPLOYEE_MANAGER: only the resolved manager', () => {
      const req = { approverRuleType: 'EMPLOYEE_MANAGER' as const, approverRuleValue: null, assigneeUserId: 'mgr' };
      expect(svc.canDecide(user({ id: 'mgr' }), req)).toBe(true);
      expect(svc.canDecide(user({ id: 'other' }), req)).toBe(false);
    });
  });

  describe('resolveStep', () => {
    it('resolves pool + literal rules without touching the DB', async () => {
      expect(await svc.resolveStep('c1', { rule: 'ANY_ADMIN' }, {})).toEqual({ approverRuleType: 'ANY_ADMIN' });
      expect(await svc.resolveStep('c1', { rule: 'DEPARTMENT', target: 'd1' }, {})).toEqual({
        approverRuleType: 'DEPARTMENT',
        approverRuleValue: 'd1',
      });
      expect(await svc.resolveStep('c1', { rule: 'USER', target: 'u9' }, {})).toEqual({
        approverRuleType: 'USER',
        approverRuleValue: 'u9',
        assigneeUserId: 'u9',
      });
    });

    it('EMPLOYEE_MANAGER resolves the AI employee\'s manager (tenant-scoped)', async () => {
      findFirst.mockResolvedValueOnce({ managerUserId: 'mgr-7' });
      const res = await svc.resolveStep('c1', { rule: 'EMPLOYEE_MANAGER' }, { employeeId: 'e1' });
      expect(res).toEqual({ approverRuleType: 'EMPLOYEE_MANAGER', assigneeUserId: 'mgr-7' });
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'e1', companyId: 'c1' },
        select: { managerUserId: true },
      });
    });

    it('resolves a {{template}} target against the run context (WORKFLOW-kind)', async () => {
      const res = await svc.resolveStep(
        'c1',
        { rule: 'USER', target: '{{trigger.approverId}}' },
        { runContext: { trigger: { approverId: 'u-42' } } },
      );
      expect(res).toEqual({ approverRuleType: 'USER', approverRuleValue: 'u-42', assigneeUserId: 'u-42' });
    });
  });

  describe('resolveInitial', () => {
    it('returns null when there are no levels (caller stays unrouted)', async () => {
      expect(await svc.resolveInitial('c1', undefined, {}, new Date(0))).toBeNull();
      expect(await svc.resolveInitial('c1', { levels: [] }, {}, new Date(0))).toBeNull();
    });

    it('resolves level 0 with SLA deadline + snapshot defaults', async () => {
      const now = new Date('2026-08-01T00:00:00.000Z');
      const init = await svc.resolveInitial(
        'c1',
        { levels: [{ rule: 'ANY_ADMIN', slaMinutes: 60 }] },
        {},
        now,
      );
      expect(init?.approverRuleType).toBe('ANY_ADMIN');
      expect(init?.slaMinutes).toBe(60);
      expect(init?.dueAt?.toISOString()).toBe('2026-08-01T01:00:00.000Z');
      expect(init?.snapshot).toEqual({
        levels: [{ rule: 'ANY_ADMIN', slaMinutes: 60 }],
        maxEscalations: 3,
        defaultOnTimeout: 'NONE',
      });
    });
  });
});
