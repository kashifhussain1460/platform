import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Run controls (cancel/retry) + EVENT single-active enforcement e2e. Needs live PG+Redis.
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('Workflow run controls + EVENT single-active (backend gap fixes)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Run Controls Co', name: 'Owner', email: `rc_owner_${ts}@ex.com`, password })
      .expect(201);
    token = reg.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  const newWorkflow = async (withApproval: boolean): Promise<string> => {
    const nodes = withApproval
      ? [
          { id: 'n1', type: 'TRIGGER', config: {} },
          { id: 'n2', type: 'APPROVAL', config: { message: 'ok?' } },
          { id: 'n3', type: 'NOOP', config: {} },
        ]
      : [
          { id: 'n1', type: 'TRIGGER', config: {} },
          { id: 'n2', type: 'NOOP', config: {} },
        ];
    const edges = withApproval
      ? [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }]
      : [{ from: 'n1', to: 'n2' }];
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: `rc-${Math.round(Date.now())}-${Math.random()}`, definition: { nodes, edges } })
      .expect(201);
    return res.body.id;
  };

  const runStatus = async (runId: string, want: string[]): Promise<string> => {
    const deadline = Date.now() + 20_000;
    let status = 'PENDING';
    while (Date.now() < deadline) {
      const r = await request(app.getHttpServer()).get(`/workflows/runs/${runId}`).set(bearer(token));
      status = r.body.status;
      if (want.includes(status)) break;
      await sleep(200);
    }
    return status;
  };

  it('GET /workflows/node-definitions returns the rich node catalog', async () => {
    const res = await request(app.getHttpServer())
      .get('/workflows/node-definitions')
      .set(bearer(token))
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(19);
    const trigger = res.body.find((n: { type: string }) => n.type === 'TRIGGER');
    expect(trigger.inputs).toBe(0);
    const approval = res.body.find((n: { type: string }) => n.type === 'APPROVAL');
    expect(approval.canPauseForApproval).toBe(true);
    const employee = res.body.find((n: { type: string }) => n.type === 'AI_EMPLOYEE_STEP');
    expect(employee.category).toBeTruthy();
    expect(Array.isArray(employee.configSchema)).toBe(true);
  });

  it('WorkflowRunDto exposes the new fields (startedByUserId, resumeNodeId, failureClass, versionId; steps carry attempt)', async () => {
    const wf = await newWorkflow(false);
    const start = await request(app.getHttpServer())
      .post(`/workflows/${wf}/run`)
      .set(bearer(token))
      .send({ trigger: {} })
      .expect(201);
    // The DTO carries the new fields (nullable, but present as keys).
    expect(start.body).toHaveProperty('startedByUserId');
    expect(start.body).toHaveProperty('resumeNodeId');
    expect(start.body).toHaveProperty('failureClass');
    expect(start.body).toHaveProperty('workflowVersionId');
    expect(start.body.startedByUserId).toBeTruthy(); // MANUAL run → the clicking user
    await runStatus(start.body.id, ['COMPLETED', 'FAILED']);
    const full = await request(app.getHttpServer()).get(`/workflows/runs/${start.body.id}`).set(bearer(token));
    for (const step of full.body.steps ?? []) {
      expect(typeof step.attempt).toBe('number');
    }
  });

  it('cancel a WAITING run → CANCELLED; a finished run cannot be cancelled (409)', async () => {
    const wf = await newWorkflow(true);
    const start = await request(app.getHttpServer())
      .post(`/workflows/${wf}/run`)
      .set(bearer(token))
      .send({ trigger: {} })
      .expect(201);
    const runId = start.body.id;
    expect(await runStatus(runId, ['WAITING'])).toBe('WAITING');

    const cancelled = await request(app.getHttpServer())
      .post(`/workflows/runs/${runId}/cancel`)
      .set(bearer(token))
      .expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');

    // Cancelling again → 409 (already finished).
    await request(app.getHttpServer())
      .post(`/workflows/runs/${runId}/cancel`)
      .set(bearer(token))
      .expect(409);
  });

  it('retry starts a FRESH run of the same workflow (new id)', async () => {
    const wf = await newWorkflow(false);
    const first = await request(app.getHttpServer())
      .post(`/workflows/${wf}/run`)
      .set(bearer(token))
      .send({ trigger: { note: 'first' } })
      .expect(201);
    await runStatus(first.body.id, ['COMPLETED', 'FAILED']);

    const retried = await request(app.getHttpServer())
      .post(`/workflows/runs/${first.body.id}/retry`)
      .set(bearer(token))
      .expect(201);
    expect(retried.body.id).not.toBe(first.body.id);
    expect(retried.body.workflowId).toBe(wf);
  });

  it('EVENT single-active: a 2nd overlapping EVENT workflow cannot be activated (409); different connectors are allowed', async () => {
    // Build EVENT workflows with a runnable step, trigger set directly (bypasses the update DTO).
    const mkEvent = async (connectorId?: string): Promise<string> => {
      const id = await newWorkflow(false); // TRIGGER → NOOP (a runnable step)
      await prisma.workflow.update({
        where: { id },
        data: { triggerType: 'EVENT', triggerConfig: { eventType: 'NEW_EMAIL', ...(connectorId ? { connectorId } : {}) } },
      });
      return id;
    };
    const wf1 = await mkEvent(); // unscoped
    const wf2 = await mkEvent(); // unscoped, same eventType
    const wf3 = await mkEvent('connA');
    const wf4 = await mkEvent('connB');

    await request(app.getHttpServer()).post(`/workflows/${wf1}/activate`).set(bearer(token)).expect(200);
    // 2nd unscoped on the same event → conflict.
    await request(app.getHttpServer()).post(`/workflows/${wf2}/activate`).set(bearer(token)).expect(409);
    // A scoped workflow still conflicts with the unscoped ACTIVE one (unscoped matches all).
    await request(app.getHttpServer()).post(`/workflows/${wf3}/activate`).set(bearer(token)).expect(409);

    // Deactivate the unscoped one, then two DIFFERENT-connector workflows coexist.
    await request(app.getHttpServer()).post(`/workflows/${wf1}/deactivate`).set(bearer(token)).expect(200);
    await request(app.getHttpServer()).post(`/workflows/${wf3}/activate`).set(bearer(token)).expect(200);
    await request(app.getHttpServer()).post(`/workflows/${wf4}/activate`).set(bearer(token)).expect(200);
    // But the unscoped one now conflicts with the two scoped ACTIVE ones.
    await request(app.getHttpServer()).post(`/workflows/${wf1}/activate`).set(bearer(token)).expect(409);
  });
});
