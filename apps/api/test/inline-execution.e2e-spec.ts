import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * `WORKFLOW_EXECUTION_MODE=inline` — the G40 proof.
 *
 * G40: on a serverless-only deployment there is no persistent worker, so a run
 * is created, enqueued, and then sits `PENDING` for ever. `QUEUE_WORKERS_ENABLED
 * =false` removes the consumer but nothing stops the producer, and
 * `queue-workers.ts` assumes *"the persistent worker keeps running on its current
 * host"* — an assumption that is silently false when no such host exists.
 *
 * This suite deliberately runs with **the worker switched off**, which is exactly
 * the broken configuration, and asserts a run still completes. If inline dispatch
 * regresses, this is the test that fails.
 *
 * ⚠️ Env is set in `beforeAll` BEFORE the module compiles: `queueWorkersEnabled()`
 * and `isInlineExecution()` read `process.env` at call time, but the processor
 * providers are decided at module construction.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('Inline workflow execution (no worker — G40)', () => {
  let app: INestApplication;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  const previous = {
    mode: process.env.WORKFLOW_EXECUTION_MODE,
    workers: process.env.QUEUE_WORKERS_ENABLED,
  };

  beforeAll(async () => {
    // The exact serverless shape: inline dispatch, no queue consumer anywhere.
    process.env.WORKFLOW_EXECUTION_MODE = 'inline';
    process.env.QUEUE_WORKERS_ENABLED = 'false';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Inline Co',
        name: 'Ivy Owner',
        email: `inline_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    // Restore so suite order can't leak this configuration into another file.
    process.env.WORKFLOW_EXECUTION_MODE = previous.mode;
    process.env.QUEUE_WORKERS_ENABLED = previous.workers;
  });

  const makeWorkflow = async (
    name: string,
    nodes: unknown[],
    edges: unknown[],
  ): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name, definition: { nodes, edges } })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/workflows/${created.body.id}/activate`)
      .set(bearer(token))
      .expect(200);
    return created.body.id;
  };

  it('executes a run to COMPLETED with no worker process at all', async () => {
    const workflowId = await makeWorkflow(
      `inline-basic-${ts}`,
      [
        { id: 'trigger', type: 'TRIGGER', config: {} },
        {
          id: 'setvar',
          type: 'SET_VARIABLE',
          config: { scope: 'RUNTIME', name: 'greeting', value: 'hello' },
        },
        { id: 'done', type: 'NOOP', config: {} },
      ],
      [
        { from: 'trigger', to: 'setvar' },
        { from: 'setvar', to: 'done' },
      ],
    );

    const run = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);

    // 🔑 Already terminal in the CREATE response: inline execution is awaited, so
    // there is nothing to poll for. Under `queue` mode with no worker this would
    // be PENDING for ever — that is precisely G40.
    expect(run.body.status).toBe('COMPLETED');

    const final = await request(app.getHttpServer())
      .get(`/workflows/runs/${run.body.id}`)
      .set(bearer(token))
      .expect(200);
    expect(final.body.status).toBe('COMPLETED');

    const step = (nodeId: string) =>
      final.body.steps.find((s: { nodeId: string }) => s.nodeId === nodeId);
    expect(step('setvar')?.status).toBe('COMPLETED');
    expect(step('done')?.status).toBe('COMPLETED');
  }, 40_000);

  it('still pauses at an APPROVAL, and resumes inline when it is approved', async () => {
    // The resume path is a SEPARATE dispatch (`{resume:true}`), so it needs its
    // own proof — inline creation working says nothing about inline resumption.
    const workflowId = await makeWorkflow(
      `inline-approval-${ts}`,
      [
        { id: 'trigger', type: 'TRIGGER', config: {} },
        {
          id: 'gate',
          type: 'APPROVAL',
          config: { message: 'Please approve this test.' },
        },
        { id: 'after', type: 'NOOP', config: {} },
      ],
      [
        { from: 'trigger', to: 'gate' },
        { from: 'gate', to: 'after' },
      ],
    );

    const run = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);
    expect(run.body.status).toBe('WAITING');

    const pending = await request(app.getHttpServer())
      .get('/approvals?status=PENDING')
      .set(bearer(token))
      .expect(200);
    const approval = pending.body.find(
      (a: { workflowRunId: string | null }) => a.workflowRunId === run.body.id,
    );
    expect(approval).toBeDefined();

    await request(app.getHttpServer())
      .post(`/approvals/${approval.id}/approve`)
      .set(bearer(token))
      .expect(201);

    // Approval → resumeRun → inline resume. Given a moment because the approve
    // handler dispatches after its own response.
    let status = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const r = await request(app.getHttpServer())
        .get(`/workflows/runs/${run.body.id}`)
        .set(bearer(token));
      status = r.body.status;
      if (status === 'COMPLETED' || status === 'FAILED') break;
      await sleep(200);
    }
    expect(status).toBe('COMPLETED');
  }, 40_000);

  it('clamps a long WAIT so it cannot exceed a serverless request budget', async () => {
    // Inline execution makes a WAIT spend the HTTP request's own budget. The
    // existing global MAX_WAIT_MS (10s) already bounds that safely — this test
    // pins it, because raising that constant would silently make inline runs
    // capable of blowing a function timeout.
    const workflowId = await makeWorkflow(
      `inline-wait-${ts}`,
      [
        { id: 'trigger', type: 'TRIGGER', config: {} },
        // Ten minutes: fine on a persistent worker, fatal inside a request.
        { id: 'hold', type: 'WAIT', config: { durationMs: 600_000 } },
      ],
      [{ from: 'trigger', to: 'hold' }],
    );

    const startedAt = Date.now();
    const run = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);
    const elapsed = Date.now() - startedAt;

    expect(run.body.status).toBe('COMPLETED');
    // Clamped, not honoured.
    expect(elapsed).toBeLessThan(20_000);

    const final = await request(app.getHttpServer())
      .get(`/workflows/runs/${run.body.id}`)
      .set(bearer(token))
      .expect(200);
    const wait = final.body.steps.find(
      (s: { nodeId: string }) => s.nodeId === 'hold',
    );
    expect(wait.status).toBe('COMPLETED');
    // The run log explains the surprise rather than hiding it.
    expect(wait.output.requestedMs).toBe(600_000);
    expect(wait.output.waitedMs).toBeLessThanOrEqual(10_000);
  }, 60_000);

  it('records a failing step as a FAILED run instead of erroring the request', async () => {
    const workflowId = await makeWorkflow(
      `inline-fail-${ts}`,
      [
        { id: 'trigger', type: 'TRIGGER', config: {} },
        // A skill nobody installed — the step must fail, the HTTP call must not.
        {
          id: 'boom',
          type: 'TOOL_ACTION',
          config: { skillKey: 'slack', tool: 'send_message', args: { channel: '#x', text: 'hi' } },
        },
      ],
      [{ from: 'trigger', to: 'boom' }],
    );

    const run = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(bearer(token))
      .send({})
      // Still 201: the run row is the authoritative record of what happened.
      .expect(201);

    expect(['FAILED', 'COMPLETED']).toContain(run.body.status);
  }, 40_000);

  describe('cron sweeps (the repeatables that never fire without a worker)', () => {
    it('is disabled entirely when CRON_SECRET is unset', async () => {
      // Unauthenticated + cross-tenant + able to trigger every workflow: closed
      // by default is the only safe posture.
      delete process.env.CRON_SECRET;
      await request(app.getHttpServer())
        .post('/admin/cron/workflow-watchdog')
        .expect(403);
    });

    it('rejects a wrong secret', async () => {
      process.env.CRON_SECRET = 'right-secret';
      await request(app.getHttpServer())
        .post('/admin/cron/workflow-watchdog')
        .set({ 'x-cron-secret': 'wrong-secret' })
        .expect(403);
      delete process.env.CRON_SECRET;
    });

    it('runs the sweep for a correct secret, over GET as well as POST', async () => {
      process.env.CRON_SECRET = 'right-secret';

      // POST — a human or a generic scheduler.
      const posted = await request(app.getHttpServer())
        .post('/admin/cron/workflow-watchdog')
        .set({ 'x-cron-secret': 'right-secret' })
        // 200, not 201: `@All` uses Nest's default status, unlike `@Post`.
        .expect(200);
      expect(posted.body).toHaveProperty('swept');

      // GET with a Bearer token — exactly what Vercel Cron sends. Stacking
      // @Get/@Post on one Nest handler silently 404s one of them, so this is
      // the guard against the schedule quietly doing nothing.
      const got = await request(app.getHttpServer())
        .get('/admin/cron/workflow-watchdog')
        .set({ authorization: 'Bearer right-secret' })
        .expect(200);
      expect(got.body).toHaveProperty('swept');

      delete process.env.CRON_SECRET;
    });

    it('drives gmail-poll and connector-reconcile sweeps (P1-4 serverless)', async () => {
      process.env.CRON_SECRET = 'right-secret';
      const gmail = await request(app.getHttpServer())
        .post('/admin/cron/gmail-poll')
        .set({ 'x-cron-secret': 'right-secret' })
        .expect(200);
      expect(gmail.body).toHaveProperty('polled');
      const rec = await request(app.getHttpServer())
        .get('/admin/cron/connector-reconcile')
        .set({ authorization: 'Bearer right-secret' })
        .expect(200);
      expect(rec.body).toHaveProperty('reconciled');
      // Postiz reconciliation must also be cron-drivable on serverless.
      const mkt = await request(app.getHttpServer())
        .post('/admin/cron/marketing-sync')
        .set({ 'x-cron-secret': 'right-secret' })
        .expect(200);
      expect(mkt.body).toHaveProperty('reconciled');
      delete process.env.CRON_SECRET;
    });

    it('reports an unknown job rather than silently doing nothing', async () => {
      process.env.CRON_SECRET = 'right-secret';
      const res = await request(app.getHttpServer())
        .post('/admin/cron/not-a-real-job')
        .set({ 'x-cron-secret': 'right-secret' })
        .expect(400);
      expect(String(res.body.message)).toContain('workflow-watchdog');
      delete process.env.CRON_SECRET;
    });

    it('fires a due scheduled workflow — the path that is dead without a worker', async () => {
      process.env.CRON_SECRET = 'right-secret';

      const created = await request(app.getHttpServer())
        .post('/workflows')
        .set(bearer(token))
        .send({
          name: `inline-sched-${ts}`,
          definition: {
            nodes: [
              { id: 'trigger', type: 'TRIGGER', config: {} },
              { id: 'done', type: 'NOOP', config: {} },
            ],
            edges: [{ from: 'trigger', to: 'done' }],
          },
        })
        .expect(201);

      // The trigger is set via PATCH, not create: `CreateWorkflowDto` has no
      // trigger fields, so the global `whitelist: true` pipe silently strips
      // them — the same trap `position` and `disabled` hit.
      await request(app.getHttpServer())
        .patch(`/workflows/${created.body.id}`)
        .set(bearer(token))
        .send({ triggerType: 'SCHEDULE', triggerConfig: { everyMs: 60_000 } })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/workflows/${created.body.id}/activate`)
        .set(bearer(token))
        .expect(200);

      await request(app.getHttpServer())
        .post('/admin/cron/workflow-schedules')
        .set({ 'x-cron-secret': 'right-secret' })
        .expect(200);

      // Assert on THIS workflow, not the sweep's global counter: the sweep is
      // deliberately cross-tenant, so `fired` also counts leftovers from other
      // suites and is not a stable thing to assert on.
      const runs = await request(app.getHttpServer())
        .get(`/workflows/${created.body.id}/runs`)
        .set(bearer(token))
        .expect(200);
      expect(runs.body.length).toBe(1);
      expect(runs.body[0].source).toBe('SCHEDULE');
      // It didn't just get created — inline dispatch ran it too.
      expect(runs.body[0].status).toBe('COMPLETED');

      // Called again immediately, the interval has NOT elapsed, so this workflow
      // must be skipped rather than fired a second time.
      await request(app.getHttpServer())
        .post('/admin/cron/workflow-schedules')
        .set({ 'x-cron-secret': 'right-secret' })
        .expect(200);
      const after = await request(app.getHttpServer())
        .get(`/workflows/${created.body.id}/runs`)
        .set(bearer(token))
        .expect(200);
      expect(after.body.length).toBe(1);

      delete process.env.CRON_SECRET;
    }, 40_000);
  });
});
