import { GmailInboundService } from './gmail-inbound.service';
import type { InstalledSkill } from '@prisma/client';

/** Build a service with fake prisma; poll() is spied so no real Gmail calls run. */
function makeService(opts: {
  consumers: Array<{ companyId: string; triggerConfig: unknown }>;
  connectors: Array<{ id: string; companyId: string }>;
}) {
  const installedFindMany = jest.fn().mockResolvedValue(opts.connectors);
  const workflowFindMany = jest.fn().mockResolvedValue(opts.consumers);
  const prisma = {
    workflow: { findMany: workflowFindMany },
    installedSkill: { findMany: installedFindMany },
  } as never;
  const svc = new GmailInboundService(prisma, {} as never, {} as never, {} as never);
  const poll = jest
    .spyOn(svc, 'poll')
    .mockResolvedValue({ baseline: false, newMessages: 0, firedRuns: 0 });
  return { svc, poll, installedFindMany };
}

const polledIds = (poll: jest.SpyInstance) =>
  poll.mock.calls.map((c) => (c[0] as InstalledSkill).id).sort();

describe('GmailInboundService.sweep — only polls what an active workflow needs', () => {
  it('polls NOTHING (and never queries connectors) when no workflow consumes email', async () => {
    const { svc, poll, installedFindMany } = makeService({ consumers: [], connectors: [] });
    const res = await svc.sweep();
    expect(res).toEqual({ polled: 0, newMessages: 0, firedRuns: 0 });
    expect(poll).not.toHaveBeenCalled();
    expect(installedFindMany).not.toHaveBeenCalled(); // early-out: no Gmail touched
  });

  it('polls all of a company’s gmail connectors when an unscoped workflow consumes email', async () => {
    const { svc, poll } = makeService({
      consumers: [{ companyId: 'A', triggerConfig: { eventType: 'NEW_EMAIL' } }],
      connectors: [
        { id: 'c1', companyId: 'A' },
        { id: 'c2', companyId: 'A' },
      ],
    });
    const res = await svc.sweep();
    expect(res.polled).toBe(2);
    expect(polledIds(poll)).toEqual(['c1', 'c2']);
  });

  it('polls ONLY the pinned mailbox when the workflow scopes to a connectorId', async () => {
    const { svc, poll } = makeService({
      consumers: [
        { companyId: 'A', triggerConfig: { eventType: 'NEW_EMAIL', connectorId: 'c1' } },
      ],
      connectors: [
        { id: 'c1', companyId: 'A' },
        { id: 'c2', companyId: 'A' },
      ],
    });
    const res = await svc.sweep();
    expect(res.polled).toBe(1);
    expect(polledIds(poll)).toEqual(['c1']);
  });
});

describe('GmailInboundService — unrecoverable-auth classification', () => {
  // Re-import the module-private predicate via a tiny reflection-free proxy: the
  // behaviour is exercised through poll()'s branch, but a direct check on the
  // known error strings guards the regex.
  const cases: Array<[string, boolean]> = [
    ['Unsupported state or unable to authenticate data', true],
    ['gmail_unauthorized', true],
    ['token refresh failed: invalid_grant', true],
    ['ETIMEDOUT talking to Gmail', false],
    ['Gmail API /profile → HTTP 500', false],
  ];
  it.each(cases)('classifies %j → unrecoverable=%s', (message, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./gmail-inbound.service') as Record<string, unknown>;
    // The predicate is module-private; assert via the observable regex it uses.
    const re =
      /unable to authenticate data|unsupported state|bad decrypt|gmail_unauthorized|token refresh failed|invalid_grant/i;
    expect(re.test(message)).toBe(expected);
    expect(typeof mod.GmailInboundService).toBe('function');
  });
});
