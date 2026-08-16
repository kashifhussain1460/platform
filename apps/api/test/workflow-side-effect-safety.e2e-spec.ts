import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  WF_ADVANCE_JOB,
  WF_RUN_ADVANCE_QUEUE,
} from '../src/modules/workflow-runtime/workflow-runtime.constants';

/**
 * WAVE 2 — SIDE-EFFECT SAFETY.
 *
 * The single most important guarantee in the runtime, and the one the Workflow
 * SDK POC showed a durable engine can quietly get wrong: when a worker dies
 * between an external side effect and its bookkeeping commit, the attempt is
 * marked `outcomeUnknown` and must NEVER be retried by machinery.
 *
 * That flag existed before this wave, and was written, logged — and then
 * ignored. The reaper flagged the ATTEMPT but left the `WorkflowStepRun` in
 * RUNNING, which the traversal does not treat as settled, so the next advance
 * resolved to the same node and opened attempt N+1. The protection was a
 * comment, not a behaviour.
 *
 * This suite reproduces the crash state directly in the database (a real
 * `SIGKILL` cannot be scripted inside a jest process) and drives the REAL
 * advance worker over it.
 *
 * It deliberately does NOT call `ReaperService.sweep()`: that sweep is
 * cross-tenant by design and the shared dev database holds dozens of tenants.
 * Reaper behaviour is covered by `reaper.service.spec.ts` against a mock.
 *
 * Needs live Postgres + Redis.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('WAVE 2 — side-effect safety (outcomeUnknown)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let advanceQueue: Queue;
  const ts = Date.now();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let companyId = '';

  const definition = {
    nodes: [
      { id: 'n1', type: 'TRIGGER', config: {} },
      { id: 'n2', type: 'NOOP', config: {} },
      { id: 'n3', type: 'NOOP', config: {} },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    advanceQueue = app.get<Queue>(getQueueToken(WF_RUN_ADVANCE_QUEUE));

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Side Effect Co',
        name: 'Owner',
        email: `sfx_owner_${ts}@ex.com`,
        password: 'password123',
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * Build a run that is mid-flight at node `n2`, with an attempt that ended the
   * way a hard worker kill ends one: FAILED, `outcomeUnknown`, and a step still
   * RUNNING because the process never got to write the step's outcome.
   */
  const crashedRun = async (name: string) => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name, definition })
      .expect(201);
    const workflowId = created.body.id as string;

    const run = await prisma.workflowRun.create({
      data: {
        companyId,
        workflowId,
        status: 'RUNNING',
        source: 'MANUAL',
        startedAt: new Date(),
      },
      select: { id: true },
    });

    // n1 completed normally.
    await prisma.workflowStepRun.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: 'n1',
        type: 'TRIGGER',
        status: 'COMPLETED',
        startedAt: new Date(Date.now() - 5_000),
        finishedAt: new Date(Date.now() - 4_000),
      },
    });

    // n2 is THE side-effecting step: still RUNNING, its attempt outcomeUnknown.
    const step = await prisma.workflowStepRun.create({
      data: {
        companyId,
        runId: run.id,
        nodeId: 'n2',
        type: 'NOOP',
        status: 'RUNNING',
        attempt: 1,
        startedAt: new Date(Date.now() - 3_000),
      },
      select: { id: true },
    });
    await prisma.workflowStepAttempt.create({
      data: {
        companyId,
        runId: run.id,
        stepId: step.id,
        attempt: 1,
        status: 'FAILED',
        outcomeUnknown: true,
        failureClass: 'OUTCOME_UNKNOWN',
        error:
          'Worker lease expired — the outcome of this attempt is UNKNOWN. ' +
          'It was not retried automatically because the side effect may already have happened.',
        startedAt: new Date(Date.now() - 3_000),
        finishedAt: new Date(Date.now() - 1_000),
      },
    });

    return { workflowId, runId: run.id, stepId: step.id };
  };

  const settle = async (runId: string) => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const r = await prisma.workflowRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true },
      });
      if (['FAILED', 'COMPLETED', 'CANCELLED', 'TIMED_OUT'].includes(r.status)) {
        return r.status;
      }
      await sleep(250);
    }
    return 'TIMEOUT';
  };

  it('never opens a new attempt at a node whose outcome is unknown', async () => {
    const { runId, stepId } = await crashedRun(`sfx-noretry-${ts}`);

    // Drive the REAL advance worker over the crashed state — exactly what the
    // reaper does after it flags the attempt.
    await advanceQueue.add(
      WF_ADVANCE_JOB,
      { runId, companyId },
      { removeOnComplete: true, removeOnFail: 100 },
    );

    const status = await settle(runId);
    expect(status).toBe('FAILED');

    // THE regression: a second attempt row here means the side effect ran twice.
    const attempts = await prisma.workflowStepAttempt.findMany({
      where: { runId },
      select: { attempt: true, status: true, outcomeUnknown: true },
      orderBy: { attempt: 'asc' },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcomeUnknown).toBe(true);

    // And the run never moved past the unknown node.
    const steps = await prisma.workflowStepRun.findMany({
      where: { runId },
      select: { nodeId: true, status: true },
    });
    expect(steps.map((s) => s.nodeId).sort()).toEqual(['n1', 'n2']);
    expect(steps.find((s) => s.nodeId === 'n2')?.status).toBe('FAILED');
    expect(steps.find((s) => s.nodeId === 'n3')).toBeUndefined();

    const stepRow = await prisma.workflowStepRun.findUniqueOrThrow({
      where: { id: stepId },
      select: { status: true },
    });
    expect(stepRow.status).toBe('FAILED');
  });

  it('classifies the run as OUTCOME_UNKNOWN so an operator can find it', async () => {
    const { runId } = await crashedRun(`sfx-class-${ts}`);
    await advanceQueue.add(
      WF_ADVANCE_JOB,
      { runId, companyId },
      { removeOnComplete: true, removeOnFail: 100 },
    );
    expect(await settle(runId)).toBe('FAILED');

    const run = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      select: { failureClass: true, error: true, resumeNodeId: true },
    });
    // Was `INTERNAL` on the attempt and nothing at all on the run, so "which
    // runs might have half-executed a side effect?" was unanswerable.
    expect(run.failureClass).toBe('OUTCOME_UNKNOWN');
    expect(run.error).toMatch(/UNKNOWN/i);
    expect(run.resumeNodeId).toBeNull();
  });

  it('is idempotent: repeated advances cannot resurrect the run', async () => {
    const { runId } = await crashedRun(`sfx-idem-${ts}`);

    for (let i = 0; i < 3; i++) {
      await advanceQueue.add(
        WF_ADVANCE_JOB,
        { runId, companyId },
        { removeOnComplete: true, removeOnFail: 100 },
      );
    }
    expect(await settle(runId)).toBe('FAILED');
    await sleep(1_500);

    const attempts = await prisma.workflowStepAttempt.count({ where: { runId } });
    expect(attempts).toBe(1);
    const after = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true },
    });
    expect(after.status).toBe('FAILED');
  });

  it('emits a step.failed and a run.failed event for the stream', async () => {
    const { runId } = await crashedRun(`sfx-events-${ts}`);
    await advanceQueue.add(
      WF_ADVANCE_JOB,
      { runId, companyId },
      { removeOnComplete: true, removeOnFail: 100 },
    );
    expect(await settle(runId)).toBe('FAILED');

    const events = await prisma.runEventOutbox.findMany({
      where: { runId },
      select: { eventType: true },
    });
    const types = events.map((e) => e.eventType);
    expect(types).toContain('step.failed');
    expect(types).toContain('run.failed');
  });

  it('OUTCOME_UNKNOWN is classified non-retryable by the retry policy', async () => {
    const { RetryPolicyService } = await import(
      '../src/modules/workflow-runtime/retry-policy.service'
    );
    const policy = new RetryPolicyService();
    expect(policy.isRetryable('OUTCOME_UNKNOWN')).toBe(false);
  });
});
