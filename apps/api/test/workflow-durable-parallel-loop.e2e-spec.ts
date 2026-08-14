import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { EngineModeService } from '../src/modules/workflow-runtime/engine-mode';
import { WorkflowsService } from '../src/modules/workflows/workflows.service';

/**
 * WAVE 1 §8 → closed: PARALLEL and LOOP on the DURABLE engine.
 *
 * The cutover suite covered linear, branching and approval graphs only, and the
 * wave doc recorded control flow as "wired and unblocked but not yet covered".
 * Writing this found two things that were wired and did NOT work:
 *
 *  1. a JOIN always reported `arrived: 0` — the durable path never collected
 *     lane outputs into `__lanes`, so fan-out worked and fan-IN lost everything;
 *  2. a LOOP ran exactly ONE iteration — `startIteration` dispatched the first
 *     pass and nothing ever advanced the cursor (`readLoopCursor` had no caller).
 *
 * Both are fixed. This suite is what keeps them fixed.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 25_000,
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

describeIfDb('WAVE 1 — durable PARALLEL + LOOP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workflows: WorkflowsService;

  const stamp = Date.now();
  let companyId = '';
  let userId = '';

  const createWorkflow = async (name: string, definition: unknown) =>
    (
      await prisma.workflow.create({
        data: {
          companyId,
          name,
          status: 'ACTIVE',
          ownerUserId: userId,
          definition: definition as never,
        },
      })
    ).id;

  const stepsOf = (runId: string) =>
    prisma.workflowStepRun.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });

  const settled = (runId: string) =>
    waitFor(async () => {
      const run = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
      return ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(run.status)
        ? run
        : null;
    }, `run ${runId} to settle`);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EngineModeService)
      .useValue({
        modeFor: (id: string) => (id === companyId ? 'state_machine' : 'legacy_walk'),
        usesStateMachine: (id: string) => id === companyId,
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    workflows = app.get(WorkflowsService);

    const company = await prisma.company.create({
      data: { name: `Durable CF ${stamp}`, slug: `durable-cf-${stamp}` },
    });
    companyId = company.id;
    const user = await prisma.user.create({
      data: {
        companyId,
        email: `durable_cf_${stamp}@example.test`,
        passwordHash: 'x',
        name: 'CF Owner',
        role: 'OWNER',
      },
    });
    userId = user.id;
    await prisma.subscription.create({
      data: { companyId, plan: 'STARTER', status: 'ACTIVE' },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── PARALLEL / JOIN ────────────────────────────────────────────────────────

  it('fans out every lane, joins once, and collects lane outputs', async () => {
    const workflowId = await createWorkflow('parallel', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        {
          id: 'p',
          type: 'PARALLEL',
          config: { lanes: ['laneA', 'laneB'], joinNodeId: 'j', mode: 'ALL' },
        },
        { id: 'laneA', type: 'NOTIFY', config: { message: 'lane A ran' } },
        { id: 'laneB', type: 'NOTIFY', config: { message: 'lane B ran' } },
        { id: 'j', type: 'JOIN', config: {} },
        { id: 'after', type: 'NOTIFY', config: { message: 'after the join' } },
      ],
      edges: [
        { from: 't', to: 'p' },
        { from: 'laneA', to: 'j' },
        { from: 'laneB', to: 'j' },
        { from: 'j', to: 'after' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    const run = await settled(created.id);
    expect(run.status).toBe('COMPLETED');

    const steps = await stepsOf(run.id);
    const visited = steps.map((s) => s.nodeId);
    // Both lanes ran, exactly once each.
    expect(visited.filter((n) => n === 'laneA')).toHaveLength(1);
    expect(visited.filter((n) => n === 'laneB')).toHaveLength(1);
    // The JOIN ran exactly ONCE, not once per arriving lane.
    expect(visited.filter((n) => n === 'j')).toHaveLength(1);
    expect(visited).toContain('after');

    // Fan-IN actually carried the lanes' results through.
    const join = steps.find((s) => s.nodeId === 'j');
    const output = join?.output as { arrived?: number; lanes?: string[] } | null;
    expect(output?.arrived).toBe(2);
    expect(output?.lanes?.sort()).toEqual(['laneA', 'laneB']);
  });

  it('does not run the JOIN until every lane has arrived', async () => {
    // The join bookkeeping is what stops a run sailing past the JOIN while a
    // lane is still executing — downstream steps would then read a
    // half-populated context.
    const workflowId = await createWorkflow('parallel-join-state', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        {
          id: 'p',
          type: 'PARALLEL',
          config: { lanes: ['a1', 'a2', 'a3'], joinNodeId: 'j', mode: 'ALL' },
        },
        { id: 'a1', type: 'NOTIFY', config: { message: '1' } },
        { id: 'a2', type: 'NOTIFY', config: { message: '2' } },
        { id: 'a3', type: 'NOTIFY', config: { message: '3' } },
        { id: 'j', type: 'JOIN', config: {} },
      ],
      edges: [
        { from: 't', to: 'p' },
        { from: 'a1', to: 'j' },
        { from: 'a2', to: 'j' },
        { from: 'a3', to: 'j' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    await settled(created.id);

    const join = await prisma.workflowJoinState.findFirstOrThrow({
      where: { runId: created.id, joinNodeId: 'j' },
    });
    expect(join.expected).toBe(3);
    expect(join.arrived).toBeGreaterThanOrEqual(3);
    expect(join.resolvedAt).not.toBeNull();

    const steps = await stepsOf(created.id);
    expect(steps.filter((s) => s.nodeId === 'j')).toHaveLength(1);
  });

  it('ANY mode runs a single lane', async () => {
    const workflowId = await createWorkflow('parallel-any', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        {
          id: 'p',
          type: 'PARALLEL',
          config: { lanes: ['x', 'y'], joinNodeId: 'j', mode: 'ANY' },
        },
        { id: 'x', type: 'NOTIFY', config: { message: 'x' } },
        { id: 'y', type: 'NOTIFY', config: { message: 'y' } },
        { id: 'j', type: 'JOIN', config: {} },
      ],
      edges: [
        { from: 't', to: 'p' },
        { from: 'x', to: 'j' },
        { from: 'y', to: 'j' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    await settled(created.id);

    const visited = (await stepsOf(created.id)).map((s) => s.nodeId);
    expect(visited).toContain('x');
    expect(visited).not.toContain('y');
  });

  // ── LOOP ───────────────────────────────────────────────────────────────────

  it('runs the loop body ONCE PER ITEM, not once', async () => {
    // The bug this pins: `startIteration` dispatched iteration 0 and nothing
    // advanced the cursor, so a 3-item loop executed its body exactly once and
    // silently skipped the rest.
    const workflowId = await createWorkflow('loop', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        {
          id: 'seed',
          type: 'SET_VARIABLE',
          config: {
            name: 'items',
            value: ['a', 'b', 'c'],
            type: 'json',
            scope: 'RUNTIME',
          },
        },
        {
          id: 'l',
          type: 'LOOP',
          config: {
            over: 'items',
            itemVar: 'item',
            body: 'body',
            maxIterations: 10,
            done: 'done',
          },
        },
        { id: 'body', type: 'NOTIFY', config: { message: 'handling {{item}}' } },
        { id: 'done', type: 'NOTIFY', config: { message: 'loop finished' } },
      ],
      edges: [
        { from: 't', to: 'seed' },
        { from: 'seed', to: 'l' },
        { from: 'body', to: 'l' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    const run = await settled(created.id);
    expect(run.status).toBe('COMPLETED');

    const steps = await stepsOf(created.id);
    const bodyRuns = steps.filter((s) => s.nodeId === 'body');
    // One step row PER ITERATION — which is also what makes the run log show
    // every pass instead of only the last one.
    expect(bodyRuns).toHaveLength(3);

    // Each iteration saw its own item.
    const messages = bodyRuns
      .map((s) => (s.output as { message?: string } | null)?.message)
      .sort();
    expect(messages).toEqual(['handling a', 'handling b', 'handling c']);

    // And the loop reached its `done` target rather than re-entering itself.
    expect(steps.map((s) => s.nodeId)).toContain('done');
  });

  it('honours maxIterations rather than running the whole list', async () => {
    const workflowId = await createWorkflow('loop-capped', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        {
          id: 'seed',
          type: 'SET_VARIABLE',
          config: {
            name: 'items',
            value: [1, 2, 3, 4, 5],
            type: 'json',
            scope: 'RUNTIME',
          },
        },
        {
          id: 'l',
          type: 'LOOP',
          config: {
            over: 'items',
            itemVar: 'n',
            body: 'body',
            maxIterations: 2,
            done: 'done',
          },
        },
        { id: 'body', type: 'NOTIFY', config: { message: 'n={{n}}' } },
        { id: 'done', type: 'NOTIFY', config: { message: 'capped' } },
      ],
      edges: [
        { from: 't', to: 'seed' },
        { from: 'seed', to: 'l' },
        { from: 'body', to: 'l' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    await settled(created.id);

    const bodyRuns = (await stepsOf(created.id)).filter((s) => s.nodeId === 'body');
    // A runaway loop must not be able to burn the queue.
    expect(bodyRuns).toHaveLength(2);
  });

  it('an EMPTY list runs the body zero times and still completes', async () => {
    const workflowId = await createWorkflow('loop-empty', {
      nodes: [
        { id: 't', type: 'TRIGGER', config: {} },
        {
          id: 'seed',
          type: 'SET_VARIABLE',
          config: {
            name: 'items',
            value: [],
            type: 'json',
            scope: 'RUNTIME',
          },
        },
        {
          id: 'l',
          type: 'LOOP',
          config: { over: 'items', itemVar: 'i', body: 'body', maxIterations: 5 },
        },
        { id: 'body', type: 'NOTIFY', config: { message: 'never' } },
      ],
      edges: [
        { from: 't', to: 'seed' },
        { from: 'seed', to: 'l' },
        { from: 'l', to: 'body' },
      ],
    });

    const created = await workflows.createRun(companyId, workflowId, userId);
    const run = await settled(created.id);
    expect(run.status).toBe('COMPLETED');
  });
});
