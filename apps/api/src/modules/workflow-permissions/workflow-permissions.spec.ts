import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AuditLogService } from '../audit/audit-log.service';
import { WorkflowPermissionService } from './workflow-permissions.service';

/** Unit tests for the enqueue-time `workflow:run` authorization (P3-06 §9.C.3). */
describe('WorkflowPermissionService.assertCanRun', () => {
  const grantsFindMany = jest.fn();
  const userFindFirst = jest.fn();
  const prisma = {
    workflowPermission: { findMany: grantsFindMany },
    user: { findFirst: userFindFirst },
  } as unknown as PrismaService;
  // These tests only exercise `assertCanRun`, which never audits — a stub is
  // enough, and a real AuditLogService would drag Prisma writes into a pure
  // unit test.
  const auditLog = { record: jest.fn() } as unknown as AuditLogService;
  const svc = new WorkflowPermissionService(prisma, auditLog);

  beforeEach(() => jest.clearAllMocks());

  const subject = (over: Record<string, unknown>) =>
    userFindFirst.mockResolvedValueOnce({
      id: 'u1',
      role: 'MEMBER',
      departmentId: null,
      teamId: null,
      ...over,
    });

  it('a workflow with NO grants is runnable by anyone (back-compat)', async () => {
    grantsFindMany.mockResolvedValueOnce([]);
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).resolves.toBeUndefined();
    expect(userFindFirst).not.toHaveBeenCalled(); // short-circuits before loading the subject
  });

  it('OWNER/ADMIN may run a restricted workflow (admin bypass)', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'USER', subjectId: 'someone-else' }]);
    subject({ id: 'u1', role: 'ADMIN' });
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).resolves.toBeUndefined();
  });

  it('a MEMBER named by a USER grant may run it', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'USER', subjectId: 'u1' }]);
    subject({ id: 'u1', role: 'MEMBER' });
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).resolves.toBeUndefined();
  });

  it('a MEMBER matched by a DEPARTMENT grant may run it', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'DEPARTMENT', subjectId: 'd1' }]);
    subject({ id: 'u1', role: 'MEMBER', departmentId: 'd1' });
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).resolves.toBeUndefined();
  });

  // The TEAM subject is the ONE team-shaped control that exists. General
  // team-level isolation (the department-style "hide other teams' things")
  // does not — see docs/status/cto-gap-closure-wave9.md B2. This branch had no
  // test at all, so the little that does work was unproven.
  it('a MEMBER matched by a TEAM grant may run it', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'TEAM', subjectId: 't1' }]);
    subject({ id: 'u1', role: 'MEMBER', teamId: 't1' });
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).resolves.toBeUndefined();
  });

  it('a MEMBER in a DIFFERENT team is denied by a TEAM grant', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'TEAM', subjectId: 't1' }]);
    subject({ id: 'u1', role: 'MEMBER', teamId: 't2' });
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a MEMBER with NO team is denied by a TEAM grant', async () => {
    // `null === null` would be a silent grant-to-everyone, which is exactly the
    // shape of bug that makes a permission layer worse than none.
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'TEAM', subjectId: 't1' }]);
    subject({ id: 'u1', role: 'MEMBER', teamId: null });
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a non-matching MEMBER is denied (403)', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'USER', subjectId: 'someone-else' }]);
    subject({ id: 'u1', role: 'MEMBER' });
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a restricted workflow with an unresolvable subject is denied', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'USER', subjectId: 'u9' }]);
    await expect(svc.assertCanRun('c1', 'w1', null)).rejects.toBeInstanceOf(ForbiddenException);
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it('applies the DISABLED kill-switch — the run subject must be ACTIVE (doc 09 §9.C.5)', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'USER', subjectId: 'u1' }]);
    userFindFirst.mockResolvedValueOnce(null); // a DISABLED user is filtered out by the query
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
  });

  it('an EMPLOYEE grant does not gate a user-triggered run (never matches a user)', async () => {
    grantsFindMany.mockResolvedValueOnce([{ subjectType: 'EMPLOYEE', subjectId: 'emp1' }]);
    subject({ id: 'u1', role: 'MEMBER' });
    await expect(svc.assertCanRun('c1', 'w1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
