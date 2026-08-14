import { NotificationsService } from './notifications.service';

/** Fakes just large enough for the paths under test. */
function make(opts: {
  enabled: boolean;
  send?: jest.Mock;
  assignee?: { email: string; name: string } | null;
  admins?: { email: string; name: string }[];
}) {
  const send = opts.send ?? jest.fn().mockResolvedValue(undefined);
  const mail = { enabled: () => opts.enabled, send } as never;
  const prisma = {
    company: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme' }) },
    user: {
      findFirst: jest.fn().mockResolvedValue(opts.assignee ?? null),
      findMany: jest.fn().mockResolvedValue(opts.admins ?? []),
    },
  } as never;
  const config = { get: () => 'http://localhost:3000' } as never;
  return { svc: new NotificationsService(prisma, mail, config), send, prisma };
}

describe('NotificationsService', () => {
  it('does nothing at all when mail is disabled (no send, no queries)', async () => {
    const { svc, send, prisma } = make({ enabled: false });
    await svc.approvalRequested('co_1', { assigneeUserId: 'u1', summary: 'x' });
    await svc.teamInvite('co_1', { email: 'a@b.co', name: 'A' });
    expect(send).not.toHaveBeenCalled();
    expect((prisma as never as { user: { findFirst: jest.Mock } }).user.findFirst)
      .not.toHaveBeenCalled();
  });

  it('emails the named assignee when routed', async () => {
    const { svc, send } = make({
      enabled: true,
      assignee: { email: 'approver@acme.co', name: 'Approver' },
    });
    await svc.approvalRequested('co_1', { assigneeUserId: 'u1', summary: 'Approve X' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('approver@acme.co');
  });

  it('falls back to owners/admins when unrouted', async () => {
    const { svc, send } = make({
      enabled: true,
      admins: [
        { email: 'owner@acme.co', name: 'Owner' },
        { email: 'admin@acme.co', name: 'Admin' },
      ],
    });
    await svc.approvalRequested('co_1', { summary: 'Approve X' });
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      'owner@acme.co',
      'admin@acme.co',
    ]);
  });

  it('is best-effort: a mail failure never throws into the caller', async () => {
    const send = jest.fn().mockRejectedValue(new Error('smtp down'));
    const { svc } = make({
      enabled: true,
      send,
      assignee: { email: 'a@b.co', name: 'A' },
    });
    await expect(
      svc.approvalRequested('co_1', { assigneeUserId: 'u1', summary: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('team invite never includes a password and points at sign-in', async () => {
    const { svc, send } = make({ enabled: true });
    await svc.teamInvite('co_1', { email: 'new@acme.co', name: 'New' });
    const [to, subject, body] = send.mock.calls[0];
    expect(to).toBe('new@acme.co');
    expect(subject).toContain('Acme');
    expect(body).toContain('/login');
    expect(body.toLowerCase()).not.toContain('password:');
  });

  // ── workflowNotify — hardening plan §30 ────────────────────────────────────
  // The node's whole output is the claim "this was delivered", so these are
  // about whether that claim can ever be wrong.

  describe('workflowNotify', () => {
    it('sends nothing, and says why, when no recipient is configured', async () => {
      const { svc, send } = make({ enabled: true });

      const result = await svc.workflowNotify('co_1', { message: 'hello' });

      expect(send).not.toHaveBeenCalled();
      expect(result).toMatchObject({ delivered: false, recipientCount: 0 });
      expect(result.reason).toMatch(/no recipients configured/);
    });

    it('does not claim delivery when mail is disabled', async () => {
      // Mail is off in dev and in every test. Reporting success there is how a
      // broken notifier reaches production unnoticed.
      const { svc, send } = make({ enabled: false });

      const result = await svc.workflowNotify('co_1', {
        message: 'hello',
        roles: ['ADMIN'],
      });

      expect(send).not.toHaveBeenCalled();
      expect(result.delivered).toBe(false);
      expect(result.reason).toMatch(/MAIL_ENABLED/);
    });

    it('scopes recipients to the company and to ACTIVE users, and caps the fan-out', async () => {
      const { svc, prisma } = make({
        enabled: true,
        admins: [{ email: 'a@acme.co', name: 'A' }],
      });

      await svc.workflowNotify('co_1', {
        message: 'hello',
        userIds: ['u_from_another_tenant'],
      });

      const where = (
        prisma as never as { user: { findMany: jest.Mock } }
      ).user.findMany.mock.calls[0][0];
      // companyId + ACTIVE are non-negotiable: a workflow naming any id at all
      // must not be able to reach a user outside its own tenant.
      expect(where.where.companyId).toBe('co_1');
      expect(where.where.status).toBe('ACTIVE');
      expect(where.take).toBe(50);
    });

    it('reports delivered:false when the filters match nobody', async () => {
      const { svc, send } = make({ enabled: true, admins: [] });

      const result = await svc.workflowNotify('co_1', {
        message: 'hello',
        roles: ['ADMIN'],
      });

      expect(send).not.toHaveBeenCalled();
      expect(result.delivered).toBe(false);
      expect(result.reason).toMatch(/no matching active users/);
    });

    it('one failed address does not cancel the rest, and the count is what ACTUALLY sent', async () => {
      const send = jest
        .fn()
        .mockRejectedValueOnce(new Error('550 mailbox unavailable'))
        .mockResolvedValueOnce(undefined);
      const { svc } = make({
        enabled: true,
        send,
        admins: [
          { email: 'bad@acme.co', name: 'Bad' },
          { email: 'good@acme.co', name: 'Good' },
        ],
      });

      const result = await svc.workflowNotify('co_1', {
        message: 'hello',
        roles: ['ADMIN'],
      });

      expect(send).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ delivered: true, recipientCount: 1 });
    });
  });
});
