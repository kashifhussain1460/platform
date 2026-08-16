import { ReaperService } from './reaper.service';
import type { EngineModeService } from './engine-mode';

/**
 * P0-1 regression: sweepStuckRuns must act ONLY on state-machine runs
 * (those with at least one WorkflowStepAttempt row). A legacy graph-walk run
 * has no attempts and must never be re-enqueued into the durable advance path.
 *
 * WAVE 1 (G-B3) adds the mirror case: a DURABLE run stuck in PENDING with no
 * attempt row must be re-enqueued rather than left for the legacy watchdog to
 * fail. Both sweeps are exercised here because they share one filter shape and
 * getting either wrong silently breaks recovery.
 */
describe('ReaperService (stuck-run scoping)', () => {
  const findManyRun = jest.fn().mockResolvedValue([]);
  const findManyAttempt = jest.fn().mockResolvedValue([]);
  const findManyTimer = jest.fn().mockResolvedValue([]);
  const updateAttempt = jest.fn();
  const transitionStep = jest.fn();
  const tx = { workflowStepAttempt: { update: updateAttempt } };
  const prisma = {
    workflowRun: { findMany: findManyRun },
    workflowStepAttempt: { findMany: findManyAttempt },
    workflowRunTimer: { findMany: findManyTimer },
    $transaction: jest.fn((fn: (c: unknown) => unknown) => fn(tx)),
  } as unknown as import('../../common/prisma/prisma.service').PrismaService;
  const state = { transitionRun: jest.fn(), transitionStep } as never;
  const add = jest.fn();
  const queue = { add } as never;
  const usesStateMachine = jest.fn().mockReturnValue(true);
  const engineMode = { usesStateMachine } as unknown as EngineModeService;
  const reaper = new ReaperService(prisma, state, engineMode, queue);

  beforeEach(() => {
    jest.clearAllMocks();
    findManyRun.mockResolvedValue([]);
    usesStateMachine.mockReturnValue(true);
  });

  it('filters stuck RUNNING runs to those with at least one attempt row', async () => {
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

  it('looks for PENDING runs that never got an attempt row', async () => {
    await reaper.sweep();
    const pendingCall = findManyRun.mock.calls.find(
      ([arg]) => arg?.where?.status === 'PENDING',
    );
    expect(pendingCall).toBeDefined();
    expect(pendingCall![0].where.attempts).toEqual({ none: {} });
  });

  it('re-enqueues an advance for a stalled PENDING durable run', async () => {
    findManyRun.mockImplementation((args: { where?: { status?: string } }) =>
      args?.where?.status === 'PENDING'
        ? Promise.resolve([{ id: 'run-1', companyId: 'co-1' }])
        : Promise.resolve([]),
    );

    const result = await reaper.sweep();

    expect(result.stalledPendingRuns).toBe(1);
    expect(add).toHaveBeenCalledWith(
      'advance',
      expect.objectContaining({ runId: 'run-1', companyId: 'co-1' }),
      expect.anything(),
    );
  });

  it('settles the STEP as well as the attempt when a lease expires', async () => {
    // WAVE 2: flagging only the attempt left the step RUNNING, which the
    // traversal does not treat as settled — so the next advance re-ran the node
    // and re-executed a side effect that may already have happened. Proven in
    // `workflow-side-effect-safety.e2e-spec.ts`: without this the run walked
    // past the unknown node and reported COMPLETED.
    findManyAttempt.mockResolvedValueOnce([
      { id: 'att-1', runId: 'run-1', companyId: 'co-1', stepId: 'step-1' },
    ]);

    await reaper.sweep();

    expect(updateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-1' },
        data: expect.objectContaining({
          status: 'FAILED',
          outcomeUnknown: true,
          failureClass: 'OUTCOME_UNKNOWN',
        }),
      }),
    );
    expect(transitionStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: 'step-1',
        runId: 'run-1',
        companyId: 'co-1',
        to: 'FAILED',
        event: 'step.failed',
      }),
      tx,
    );
  });

  it('leaves a stalled PENDING run alone when its company is on the legacy engine', async () => {
    // The legacy watchdog owns those runs; recovering them here would race it.
    usesStateMachine.mockReturnValue(false);
    findManyRun.mockImplementation((args: { where?: { status?: string } }) =>
      args?.where?.status === 'PENDING'
        ? Promise.resolve([{ id: 'run-legacy', companyId: 'co-legacy' }])
        : Promise.resolve([]),
    );

    const result = await reaper.sweep();

    expect(result.stalledPendingRuns).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });
});
