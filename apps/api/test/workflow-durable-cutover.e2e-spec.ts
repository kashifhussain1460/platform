import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { EngineModeService } from '../src/modules/workflow-runtime/engine-mode';
import { ReaperService } from '../src/modules/workflow-runtime/reaper.service';
import { WorkflowsService } from '../src/modules/workflows/workflows.service';

/**
 * WAVE 1 gate — the durable state machine as the PRODUCTION execution path.
 *
 * Everything here runs against real Postgres and real Redis/BullMQ workers. That
 * is the point: `workflow-runtime-p1.e2e-spec.ts` already covers the runtime's
 * PARTS (transitions, outbox, reaper, timers) in isolation, and every one of
 * them passed while the advance → attempt loop had never executed a single whole
 * workflow. A component test cannot catch "nothing ever calls this".
 *
 * The company is opted in by overriding `EngineModeService`, which is exactly
 * what `WORKFLOW_ENGINE_STATE_MACHINE_COMPANIES=<id>` does in production — the
 * flag's real value is only known at runtime, after the tenant exists.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

/** Poll until `check` passes. Queue work is asynchronous; sleeping is flaky. */
async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value as T;
    last = value;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

describeIfDb('WAVE 1 — durable runtime cutover', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workflows: WorkflowsService;
  let reaper: ReaperService;

  const stamp = Date.now();
  let companyId = '';
  let userId = '';

  const createWorkflow = async (
    name: string,
    definition: Record<string, unknown>,
  ) => {
    const wf = await prisma.workflow.create({
      data: {
        companyId,
        name,
        status: 'ACTIVE',
        ownerUserId: userId,
        definition: definition as never,
      },
    });
    return wf.id;
  };

  const runOf = (runId: string) =>
    prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });

  const stepsOf = (runId: string) =>
    prisma.workflowStepRun.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });

  const settled = async (runId: string) =>
    waitFor(async () => {
      const run = await runOf(runId);
      return ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(run.status)
        ? run
        : null;
    }, `run ${runId} to settle`);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Opt THIS company into the durable engine, exactly as the env-var
      // allowlist does in production. Overriding rather than setting env keeps
      // every other e2e suite on the legacy walk.
      .overrideProvider(EngineModeService)
      .useValue({
        modeFor: (id: string) =>
          id === companyId ? 'state_machine' : 'legacy_walk',
        usesStateMachine: (id: string) => id === companyId,
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    workflows = app.get(WorkflowsService);
    reaper = app.get(ReaperService);

    const company = await prisma.company.create({
      data: { name: `Durable ${stamp}`, slug: `durable-${stamp}` },
    });
    companyId = company.id;

    const user = await prisma.user.create({
      data: {
        companyId,
        email: `durable-${stamp}@example.test`,
        passwordHash: 'x',
        name: 'Durable Owner',
        role: 'OWNER',
      },
    });
    userId = user.id;

    // A STARTER subscription: `blockedBySubscription` fails a run without one,
    // and that failure looks exactly like a broken engine.
    await prisma.subscription.create({
      data: { companyId, plan: 'STARTER', status: 'ACTIVE' },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── The cutover itself ────────────────────────────────────────────────────

  it('executes a whole workflow on the durable runtime, not the legacy walk', async () => {
    const workflowId = await createWorkflow('linear', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'a', type: 'NOTIFY', config: { message: 'first' } },
        { id: 'b', type: 'NOTIFY', config: { message: 'second' } },
      ],
      edges: [
        { from: 't', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    const run = await settled(created.id);

    expect(run.status).toBe('COMPLETED');

    const steps = await stepsOf(run.id);
    expect(steps.map((s) => s.nodeId)).toEqual(['t', 'a', 'b']);
    expect(steps.every((s) => s.status === 'COMPLETED')).toBe(true);

    // THE discriminator: only the durable path writes attempt rows. Without it
    // this test would pass just as happily on the legacy engine.
    const attempts = await prisma.workflowStepAttempt.findMany({
      where: { runId: run.id },
    });
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.status === 'COMPLETED')).toBe(true);

    // And the transactional outbox recorded the lifecycle.
    const events = await prisma.runEventOutbox.findMany({
      where: { runId: run.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['run.started', 'step.completed', 'run.completed']),
    );
  });

  it('seeds {{trigger.*}} so the FIRST node can read it', async () => {
    // The legacy walk builds the context in memory before it starts. The state
    // machine has no such moment — every attempt reads the context from the row
    // — so an unseeded run rendered `{{trigger.who}}` as empty at node 1.
    const workflowId = await createWorkflow('trigger-context', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        {
          id: 'greet',
          type: 'NOTIFY',
          config: { message: 'hello {{trigger.who}}' },
        },
      ],
      edges: [{ from: 't', to: 'greet' }],
    });

    const created = await workflows.createRun(companyId, workflowId, userId, {
      who: 'Ada',
    });
    await settled(created.id);

    const steps = await stepsOf(created.id);
    const greet = steps.find((s) => s.nodeId === 'greet');
    expect((greet?.output as { message?: string } | null)?.message).toBe(
      'hello Ada',
    );
  });

  // ── W1-b: routing, the correctness blocker ────────────────────────────────

  it('follows the FALSE branch and never touches the true one', async () => {
    // The old advance picked `nodes.find(n => !done.has(n.id))` — declaration
    // order. `yes` is declared first, so it ran the wrong branch (and then the
    // right one as well, since it simply walked the array).
    const workflowId = await createWorkflow('branching', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'c', type: 'CONDITION', config: { left: 'a', op: 'eq', right: 'b' } },
        { id: 'yes', type: 'NOTIFY', config: { message: 'TRUE branch' } },
        { id: 'no', type: 'NOTIFY', config: { message: 'FALSE branch' } },
      ],
      edges: [
        { from: 't', to: 'c' },
        { from: 'c', to: 'yes', branch: 'true' },
        { from: 'c', to: 'no', branch: 'false' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    const run = await settled(created.id);
    expect(run.status).toBe('COMPLETED');

    const steps = await stepsOf(run.id);
    const visited = steps.map((s) => s.nodeId);
    expect(visited).toContain('no');
    expect(visited).not.toContain('yes');

    // And the decision is on disk, so a reaper-driven advance can re-derive it.
    expect(steps.find((s) => s.nodeId === 'c')?.branch).toBe('false');
  });

  // ── §1.10: approval as a durable state ────────────────────────────────────

  it('pauses at an APPROVAL, survives, and resumes exactly once when approved', async () => {
    const workflowId = await createWorkflow('approval', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'gate', type: 'APPROVAL', config: { message: 'Ship it?' } },
        { id: 'after', type: 'NOTIFY', config: { message: 'shipped' } },
      ],
      edges: [
        { from: 't', to: 'gate' },
        { from: 'gate', to: 'after' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);

    const waiting = await waitFor(async () => {
      const run = await runOf(created.id);
      return run.status === 'WAITING' ? run : null;
    }, 'run to pause at the approval');
    expect(waiting.resumeNodeId).toBe('gate');

    const request = await waitFor(
      async () =>
        prisma.approvalRequest.findFirst({
          where: { companyId, workflowRunId: created.id, kind: 'WORKFLOW' },
        }),
      'the approval request',
    );
    expect(request.status).toBe('PENDING');
    // The node is recorded so concurrent lanes can each find THEIR gate.
    expect((request.args as { nodeId?: string }).nodeId).toBe('gate');

    // The downstream node must NOT have run while waiting.
    let steps = await stepsOf(created.id);
    expect(steps.map((s) => s.nodeId)).not.toContain('after');
    // The gate's own step is WAITING, not COMPLETED: it has work left to do.
    expect(steps.find((s) => s.nodeId === 'gate')?.status).toBe('WAITING');

    // Approve, then resume the way ApprovalsService does.
    await prisma.approvalRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED', decidedById: userId, decidedAt: new Date() },
    });
    await workflows.resumeRun(created.id, companyId);

    const run = await settled(created.id);
    expect(run.status).toBe('COMPLETED');

    steps = await stepsOf(created.id);
    // Exactly one `after` step — a resumed run must not double-execute the work
    // the approval was gating.
    expect(steps.filter((s) => s.nodeId === 'after')).toHaveLength(1);
    expect(steps.find((s) => s.nodeId === 'after')?.status).toBe('COMPLETED');
    // The pointer is consumed, so a later advance cannot bounce back to the gate.
    expect(run.resumeNodeId).toBeNull();
  });

  it('fails the run safely when an approval is rejected', async () => {
    const workflowId = await createWorkflow('approval-reject', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'gate', type: 'APPROVAL', config: { message: 'Ship it?' } },
        { id: 'after', type: 'NOTIFY', config: { message: 'shipped' } },
      ],
      edges: [
        { from: 't', to: 'gate' },
        { from: 'gate', to: 'after' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    const request = await waitFor(
      async () =>
        prisma.approvalRequest.findFirst({
          where: { companyId, workflowRunId: created.id, kind: 'WORKFLOW' },
        }),
      'the approval request',
    );
    // Wait for the pause to land, since resumeRun only acts on a WAITING run.
    await waitFor(async () => {
      const r = await runOf(created.id);
      return r.status === 'WAITING' ? r : null;
    }, 'run to pause at the approval');

    await prisma.approvalRequest.update({
      where: { id: request.id },
      data: {
        status: 'REJECTED',
        decidedById: userId,
        decidedAt: new Date(),
        note: 'not now',
      },
    });

    // Re-entering the gate with a REJECTED decision must fail the run, not walk
    // past it. This is the belt-and-braces half of rejection handling: even if
    // something resumes a rejected run (an SLA auto-reject racing a manual
    // resume, a reaper re-enqueue), the gate refuses on its own.
    await workflows.resumeRun(created.id, companyId);

    const run = await waitFor(async () => {
      const r = await runOf(created.id);
      return r.status === 'FAILED' ? r : null;
    }, 'the rejected run to fail');

    expect(run.error).toContain('not now');
    const steps = await stepsOf(created.id);
    // Rejection is a SAFE failure: the gated work never happens.
    expect(steps.map((s) => s.nodeId)).not.toContain('after');
  });

  // ── §1.8 idempotency / §1.9 no duplicate side effects ─────────────────────

  it('returns the SAME run for a duplicate idempotency key', async () => {
    const workflowId = await createWorkflow('idempotent', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'a', type: 'NOTIFY', config: { message: 'once' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });

    const key = `dup-${stamp}`;
    const first = await workflows.createRun(
      companyId,
      workflowId,
      userId,
      undefined,
      false,
      key,
    );
    const second = await workflows.createRun(
      companyId,
      workflowId,
      userId,
      undefined,
      false,
      key,
    );

    expect(second.id).toBe(first.id);
    await settled(first.id);

    const runs = await prisma.workflowRun.count({ where: { workflowId } });
    expect(runs).toBe(1);
  });

  it('does not re-execute a node when the same advance is delivered twice', async () => {
    const workflowId = await createWorkflow('replay', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        { id: 'a', type: 'NOTIFY', config: { message: 'once only' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    await settled(created.id);

    // Replay the wake-up several times, as at-least-once delivery would.
    await reaper.sweep();
    await reaper.sweep();
    await new Promise((r) => setTimeout(r, 500));

    const steps = await stepsOf(created.id);
    expect(steps.filter((s) => s.nodeId === 'a')).toHaveLength(1);
    const attempts = await prisma.workflowStepAttempt.findMany({
      where: { runId: created.id },
    });
    // One attempt per node: a completed attempt can never be re-claimed.
    expect(attempts).toHaveLength(2);
  });

  // ── §1.9 crash recovery ───────────────────────────────────────────────────

  it('marks a dead worker’s attempt outcomeUnknown instead of re-running it', async () => {
    const workflowId = await createWorkflow('crash', {
      nodes: [{ id: 'only', type: 'NOTIFY', config: { message: 'x' } }],
      edges: [],
    });
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId, status: 'RUNNING', source: 'MANUAL' },
    });
    const step = await prisma.workflowStepRun.create({
      data: { companyId, runId: run.id, nodeId: 'only', type: 'NOTIFY', status: 'RUNNING' },
    });
    // A worker that died mid-effect: RUNNING, lease already expired.
    const attempt = await prisma.workflowStepAttempt.create({
      data: {
        companyId,
        runId: run.id,
        stepId: step.id,
        attempt: 1,
        status: 'RUNNING',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    await reaper.sweep();

    const reaped = await prisma.workflowStepAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(reaped.status).toBe('FAILED');
    // The side effect MAY already have happened. Re-running it is the worse
    // failure, so the runtime surfaces it rather than retrying.
    expect(reaped.outcomeUnknown).toBe(true);

    const attempts = await prisma.workflowStepAttempt.count({
      where: { runId: run.id },
    });
    expect(attempts).toBe(1);
  });

  // ── Migration safety: the flag really is the rollback ─────────────────────

  it('leaves a non-opted-in company on the legacy walk', async () => {
    const other = await prisma.company.create({
      data: { name: `Legacy ${stamp}`, slug: `legacy-${stamp}` },
    });
    await prisma.subscription.create({
      data: { companyId: other.id, plan: 'STARTER', status: 'ACTIVE' },
    });
    const otherUser = await prisma.user.create({
      data: {
        companyId: other.id,
        email: `legacy-${stamp}@example.test`,
        passwordHash: 'x',
        name: 'Legacy Owner',
        role: 'OWNER',
      },
    });
    const wf = await prisma.workflow.create({
      data: {
        companyId: other.id,
        name: 'legacy path',
        status: 'ACTIVE',
        ownerUserId: otherUser.id,
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'a', type: 'NOTIFY', config: { message: 'legacy' } },
          ],
          edges: [{ from: 't', to: 'a' }],
        } as never,
      },
    });

    const created = await workflows.createRun(other.id, wf.id, otherUser.id);
    await waitFor(async () => {
      const run = await prisma.workflowRun.findUniqueOrThrow({
        where: { id: created.id },
      });
      return run.status === 'COMPLETED' ? run : null;
    }, 'the legacy run to complete');

    // No attempt rows: this run never entered the durable engine.
    const attempts = await prisma.workflowStepAttempt.count({
      where: { runId: created.id },
    });
    expect(attempts).toBe(0);
  });
});
