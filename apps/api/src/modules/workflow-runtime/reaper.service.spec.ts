import { ReaperService } from './reaper.service';

/**
 * P0-1 regression: sweepStuckRuns must act ONLY on state-machine runs
 * (those with at least one WorkflowStepAttempt row). A legacy graph-walk run
 * has no attempts and must never be re-enqueued into the durable advance path.
 */
describe('ReaperService (P0-1 stuck-run scoping)', () => {
  const findManyRun = jest.fn().mockResolvedValue([]);
  const findManyAttempt = jest.fn().mockResolvedValue([]);
  const findManyTimer = jest.fn().mockResolvedValue([]);
  const prisma = {
    workflowRun: { findMany: findManyRun },
    workflowStepAttempt: { findMany: findManyAttempt },
    workflowRunTimer: { findMany: findManyTimer },
  } as unknown as import('../../common/prisma/prisma.service').PrismaService;
  const state = { transitionRun: jest.fn() } as never;
  const queue = { add: jest.fn() } as never;
  const reaper = new ReaperService(prisma, state, queue);

  beforeEach(() => jest.clearAllMocks());

  it('filters stuck runs to those with at least one attempt row', async () => {
    await reaper.sweep();
    const stuckCall = findManyRun.mock.calls.find(
      ([arg]) => arg?.where?.status === 'RUNNING',
    );
    expect(stuckCall).toBeDefined();
    expect(stuckCall![0].where.attempts).toEqual({
      some: {},
      none: { status: 'RUNNING' },
    });
  });
});
