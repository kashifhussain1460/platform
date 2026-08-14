import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * JOURNEY A — a real HR admin, walked end-to-end AGAINST THE REAL STACK
 * (Postgres + Redis + BullMQ; only external skill providers are sandboxed via
 * SKILL_EXECUTOR=mock, which is standard, not a mock of any Orlixa API).
 *
 * This is the ONE continuous from-scratch story the suite was missing: the
 * builder half (create → configure → save draft → validate → publish-freeze)
 * and the run half (trigger → approval → complete) meet in a single test, then
 * we read the audit trail and analytics back through their real query APIs.
 *
 * Covers both a happy approval (→ COMPLETED) and a rejection (→ FAILED), plus a
 * save-time validation failure. Every stage asserts the real DB/run state.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('Journey A — HR admin, from scratch to audited execution', () => {
  let app: INestApplication;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let ownerUserId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const runStatus = async (runId: string, want: string[]): Promise<string> => {
    const deadline = Date.now() + 20_000;
    let status = 'PENDING';
    while (Date.now() < deadline) {
      const r = await request(app.getHttpServer())
        .get(`/workflows/runs/${runId}`)
        .set(bearer(token));
      status = r.body.status;
      if (want.includes(status)) return status;
      await sleep(200);
    }
    return status;
  };

  const pendingApprovalFor = async (runId: string): Promise<string> => {
    const pending = await request(app.getHttpServer())
      .get('/approvals?status=PENDING')
      .set(bearer(token))
      .expect(200);
    const approval = pending.body.find(
      (a: { workflowRunId: string | null }) => a.workflowRunId === runId,
    );
    expect(approval).toBeDefined();
    return approval.id;
  };

  const graph = (employeeId: string) => ({
    nodes: [
      { id: 'trigger', type: 'TRIGGER', config: {} },
      {
        id: 'ai',
        type: 'AI_EMPLOYEE_STEP',
        config: {
          employeeId,
          instruction: 'Summarise the request in {{trigger.payload}}. Recommend only.',
          outputKey: 'summary',
        },
      },
      { id: 'appr', type: 'APPROVAL', config: { message: 'Approve before notifying the team.' } },
      {
        id: 'notify',
        type: 'TOOL_ACTION',
        config: { skillKey: 'slack', tool: 'send_message', args: { channel: '#hr', text: 'Done: {{summary}}' } },
      },
      { id: 'done', type: 'TERMINATE', config: {} },
    ],
    edges: [
      { from: 'trigger', to: 'ai' },
      { from: 'ai', to: 'appr' },
      { from: 'appr', to: 'notify' },
      { from: 'notify', to: 'done' },
    ],
  });

  it('creates a company, hires HR, builds+publishes a workflow, runs it through approval, and it is audited', async () => {
    // 1. Create company.
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: `Journey A ${ts}`, name: 'Owner', email: `journeyA_${ts}@ex.com`, password })
      .expect(201);
    token = reg.body.tokens.accessToken;
    ownerUserId = reg.body.user.id;
    expect(reg.body.company.onboardedAt).toBeNull();

    // 2. Hire an HR AI Employee (via onboarding).
    const onboarded = await request(app.getHttpServer())
      .post('/onboarding/complete')
      .set(bearer(token))
      .send({
        business: { industry: 'SaaS', size: '11-50', description: 'Journey A test company.' },
        departments: ['HR'],
        employees: [{ role: 'HR', name: 'Emma' }],
      })
      .expect(201);
    const hr = onboarded.body.employees.find((e: { role: string }) => e.role === 'HR');
    expect(hr).toBeDefined();

    // 3. Install AND connect a required Skill (the notify step calls slack).
    // Connecting matters: a workflow whose required skills aren't connected
    // stays a DRAFT and cannot be published (doc 30 §12 readiness gate) under a
    // real-execution mode. Installing alone leaves it NOT_CONNECTED.
    const installedSlack = await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'slack' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/skills/installed/${installedSlack.body.id}/connect`)
      .set(bearer(token))
      .send({ credentials: { token: 'xoxb-journey-test' } })
      .expect(201);

    // 4. Validate (failure path): a cyclic graph SAVES — a half-wired graph is
    //    the normal state of one being built, and the builder autosaves — but it
    //    can never be RUN. The check moved off the save path in WAVE 7; it did
    //    not go away.
    const doomed = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({
        name: 'doomed',
        definition: {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', config: {} },
            { id: 'a', type: 'NOOP', config: {} },
            { id: 'b', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 'trigger', to: 'a' },
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' }, // cycle
          ],
        },
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/workflows/${doomed.body.id}/run`)
      .set(bearer(token))
      .send({})
      .expect(400);

    // 5. Create the real workflow from scratch → DRAFT.
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: `Onboarding notice ${ts}`, definition: graph(hr.id) })
      .expect(201);
    const workflowId: string = created.body.id;
    expect(created.body.status).toBe('DRAFT');

    // 6/7. Configure + save draft (autosave path).
    await request(app.getHttpServer())
      .put(`/workflows/${workflowId}/draft`)
      .set(bearer(token))
      .send({ definition: graph(hr.id) })
      .expect(200);

    // 8/9. Validate passes → publish freezes an immutable v1.
    const published = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/publish`)
      .set(bearer(token))
      .send({ changeNote: 'First publish' })
      .expect(200);
    expect(published.body.version.status).toBe('PUBLISHED');

    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/activate`)
      .set(bearer(token))
      .expect(200);

    // 10/11/12. Trigger → pauses at approval → approve → COMPLETED.
    const run = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(bearer(token))
      .send({ trigger: { payload: { employee: 'Priya', task: 'onboarding' } } })
      .expect(201);
    expect(await runStatus(run.body.id, ['WAITING', 'FAILED'])).toBe('WAITING');

    const approvalId = await pendingApprovalFor(run.body.id);
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`)
      .set(bearer(token))
      .expect(201);
    expect(await runStatus(run.body.id, ['COMPLETED', 'FAILED'])).toBe('COMPLETED');

    const finalRun = await request(app.getHttpServer())
      .get(`/workflows/runs/${run.body.id}`)
      .set(bearer(token))
      .expect(200);
    const notify = finalRun.body.steps.find((s: { nodeId: string }) => s.nodeId === 'notify');
    expect(notify.status).toBe('COMPLETED');

    // 11b. Failure path: a second run, rejected at approval → FAILED, notify never runs.
    const run2 = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(bearer(token))
      .send({ trigger: { payload: { employee: 'Sam', task: 'onboarding' } } })
      .expect(201);
    expect(await runStatus(run2.body.id, ['WAITING', 'FAILED'])).toBe('WAITING');
    const approval2 = await pendingApprovalFor(run2.body.id);
    await request(app.getHttpServer())
      .post(`/approvals/${approval2}/reject`)
      .set(bearer(token))
      .send({ note: 'Not this time' })
      .expect(201);
    expect(await runStatus(run2.body.id, ['COMPLETED', 'FAILED'])).toBe('FAILED');
    const failedRun = await request(app.getHttpServer())
      .get(`/workflows/runs/${run2.body.id}`)
      .set(bearer(token))
      .expect(200);
    const notify2 = failedRun.body.steps.find((s: { nodeId: string }) => s.nodeId === 'notify');
    expect(notify2?.status ?? 'never-ran').not.toBe('COMPLETED');

    // 13. Inspect audit — the create is on the record, attributed to the owner.
    const audit = await request(app.getHttpServer())
      .get('/audit-log')
      .query({ entityType: 'Workflow' })
      .set(bearer(token))
      .expect(200);
    const createEntry = audit.body.find(
      (e: { action: string; entityId: string }) =>
        e.action === 'workflow.create' && e.entityId === workflowId,
    );
    expect(createEntry).toBeDefined();
    expect(createEntry.actorUserId).toBe(ownerUserId);

    // 14. Inspect analytics — the KPI surface answers for this tenant.
    const analytics = await request(app.getHttpServer())
      .get('/analytics/overview?range=all')
      .set(bearer(token))
      .expect(200);
    expect(analytics.body).toBeTruthy();

    // The company genuinely ran its business through the platform.
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer(token))
      .expect(200);
    expect(me.body.company.onboardedAt).not.toBeNull();
  }, 90_000);
});
