import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { WorkflowsService } from '../src/modules/workflows/workflows.service';

// Workflow triggers + activation e2e (Steps 8/9/11). Needs a live Postgres +
// Redis (BullMQ). Skipped when DATABASE_URL is unset so it never blocks builds.
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A runnable linear definition: TRIGGER -> AI_STEP -> NOTIFY (no external deps). */
const RUNNABLE_DEFINITION = {
  nodes: [
    { id: 'n1', type: 'TRIGGER', config: {} },
    {
      id: 'n2',
      type: 'AI_STEP',
      config: { prompt: 'Acknowledge the payload.', outputKey: 'aiText' },
    },
    { id: 'n3', type: 'NOTIFY', config: { message: 'Done: {{aiText}}' } },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
  ],
};

describeIfDb('Workflow triggers + activation e2e', () => {
  let app: INestApplication;
  let workflows: WorkflowsService;
  const email = `wf_trig_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });
  const server = () => app.getHttpServer();

  /** Create a workflow (runnable) then PATCH its trigger; returns the id. */
  async function createTriggered(
    triggerType: string,
    triggerConfig?: Record<string, unknown>,
  ): Promise<string> {
    const created = await request(server())
      .post('/workflows')
      .set(auth())
      .send({ name: `${triggerType} wf`, definition: RUNNABLE_DEFINITION })
      .expect(201);
    const id = created.body.id;
    await request(server())
      .patch(`/workflows/${id}`)
      .set(auth())
      .send({ triggerType, triggerConfig })
      .expect(200);
    return id;
  }

  /** Poll a run to a terminal state; returns the final run body. */
  async function pollRun(runId: string, timeoutMs = 20_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let run: any = {};
    while (Date.now() < deadline) {
      const res = await request(server())
        .get(`/workflows/runs/${runId}`)
        .set(auth())
        .expect(200);
      run = res.body;
      if (run.status === 'COMPLETED' || run.status === 'FAILED') break;
      await sleep(300);
    }
    return run;
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    workflows = app.get(WorkflowsService);

    const res = await request(server())
      .post('/auth/register')
      .send({ companyName: 'WF Trig Co', name: 'WF Owner', email, password })
      .expect(201);
    accessToken = res.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('EVENT: activate then fire event -> run COMPLETED with source EVENT', async () => {
    const id = await createTriggered('EVENT', { eventType: 'new_resume' });

    const activated = await request(server())
      .post(`/workflows/${id}/activate`)
      .set(auth())
      .expect(200);
    expect(activated.body.status).toBe('ACTIVE');
    expect(activated.body.triggerType).toBe('EVENT');

    const fired = await request(server())
      .post('/workflows/events')
      .set(auth())
      .send({ eventType: 'new_resume', payload: { x: 1 } })
      .expect(200);
    expect(fired.body.eventType).toBe('new_resume');
    expect(fired.body.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(fired.body.runIds)).toBe(true);
    expect(fired.body.runIds.length).toBeGreaterThanOrEqual(1);

    const run = await pollRun(fired.body.runIds[0]);
    expect(run.status).toBe('COMPLETED');
    expect(run.source).toBe('EVENT');
    expect(run.trigger).toEqual({ x: 1 });
  }, 30_000);

  it('WEBHOOK: activate -> token present -> public POST (no auth) -> COMPLETED, source WEBHOOK', async () => {
    const id = await createTriggered('WEBHOOK');

    await request(server())
      .post(`/workflows/${id}/activate`)
      .set(auth())
      .expect(200);

    const got = await request(server())
      .get(`/workflows/${id}`)
      .set(auth())
      .expect(200);
    const token = got.body.webhookToken;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    // No Authorization header — the public route must accept it.
    const fired = await request(server())
      .post(`/workflows/webhooks/${token}`)
      .send({ hello: 'world' })
      .expect(201);
    expect(typeof fired.body.id).toBe('string');
    expect(fired.body.source).toBe('WEBHOOK');

    const run = await pollRun(fired.body.id);
    expect(run.status).toBe('COMPLETED');
    expect(run.source).toBe('WEBHOOK');
    expect(run.trigger).toEqual({ hello: 'world' });
  }, 30_000);

  it('WEBHOOK: redelivery with same Idempotency-Key returns the same run (P0-2)', async () => {
    const id = await createTriggered('WEBHOOK');
    await request(server())
      .post(`/workflows/${id}/activate`)
      .set(auth())
      .expect(200);
    const got = await request(server())
      .get(`/workflows/${id}`)
      .set(auth())
      .expect(200);
    const token = got.body.webhookToken;

    const first = await request(server())
      .post(`/workflows/webhooks/${token}`)
      .set('Idempotency-Key', 'delivery-abc')
      .send({ hello: 'world' })
      .expect(201);

    const second = await request(server())
      .post(`/workflows/webhooks/${token}`)
      .set('Idempotency-Key', 'delivery-abc')
      .send({ hello: 'world' })
      .expect(201);

    // Same run id returned; no duplicate run created for this workflow.
    expect(second.body.id).toBe(first.body.id);
    const runs = await request(server())
      .get(`/workflows/${id}/runs`)
      .set(auth())
      .expect(200);
    expect(runs.body.length).toBe(1);
  }, 30_000);

  it('RUN: same Idempotency-Key returns the same run, no duplicate (P1-2)', async () => {
    const id = await createTriggered('MANUAL');
    const first = await request(server())
      .post(`/workflows/${id}/run`)
      .set(auth())
      .set('Idempotency-Key', 'run-key-1')
      .send({})
      .expect(201);
    const second = await request(server())
      .post(`/workflows/${id}/run`)
      .set(auth())
      .set('Idempotency-Key', 'run-key-1')
      .send({})
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
    const runs = await request(server())
      .get(`/workflows/${id}/runs`)
      .set(auth())
      .expect(200);
    expect(runs.body.length).toBe(1);
  }, 30_000);

  it('SCHEDULE: activate registers a repeatable job; deactivate removes it', async () => {
    const id = await createTriggered('SCHEDULE', { everyMs: 60_000 });

    await request(server())
      .post(`/workflows/${id}/activate`)
      .set(auth())
      .expect(200);

    const after = await workflows.listSchedulers();
    expect(after.some((s) => s.key === `wf:${id}`)).toBe(true);

    await request(server())
      .post(`/workflows/${id}/deactivate`)
      .set(auth())
      .expect(200);

    const removed = await workflows.listSchedulers();
    expect(removed.some((s) => s.key === `wf:${id}`)).toBe(false);
  }, 20_000);

  it('activating a trigger-only workflow (no runnable steps) returns 400', async () => {
    // Created without a definition => seeded with a single TRIGGER node only.
    const created = await request(server())
      .post('/workflows')
      .set(auth())
      .send({ name: 'Empty wf' })
      .expect(201);

    await request(server())
      .post(`/workflows/${created.body.id}/activate`)
      .set(auth())
      .expect(400);
  });

  it('a webhook with a bad token returns 404', async () => {
    await request(server())
      .post('/workflows/webhooks/not-a-real-token')
      .send({ any: 'thing' })
      .expect(404);
  });

  it('events and activate without a token return 401', async () => {
    await request(server())
      .post('/workflows/events')
      .send({ eventType: 'new_resume' })
      .expect(401);

    const created = await request(server())
      .post('/workflows')
      .set(auth())
      .send({ name: 'Auth guard wf', definition: RUNNABLE_DEFINITION })
      .expect(201);

    await request(server())
      .post(`/workflows/${created.body.id}/activate`)
      .expect(401);
  });
});
