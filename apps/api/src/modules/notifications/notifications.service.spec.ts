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
});
