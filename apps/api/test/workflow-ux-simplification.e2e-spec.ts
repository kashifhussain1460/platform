import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * The three backend additions the simplified workflow UX depends on:
 *
 *  1. `GET /workflows/:id/readiness` — a NON-MUTATING preflight, so Review &
 *     Publish can explain problems without a separate [Validate] click.
 *  2. `POST /workflows/:id/publish { activate: true }` — one customer-facing
 *     action, still two guarded server operations.
 *  3. `GET /workflows/runs` — the cross-workflow operations list.
 *
 * The point of each assertion is that simplifying the UI did NOT weaken the
 * enforcement behind it: a failed validation must not activate anything, and
 * neither read may cross a tenant boundary.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Workflow UX simplification — readiness, publish+activate, runs', () => {
  let app: INestApplication;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let otherToken = '';

  const runnable = {
    nodes: [
      { id: 'n1', type: 'TRIGGER', config: {}, position: { x: 100, y: 40 } },
      { id: 'n2', type: 'NOOP', config: {}, position: { x: 100, y: 200 } },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };

  beforeAll(async () => {
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
        companyName: 'Simplify Co',
        name: 'Owner',
        email: `simplify_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;

    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Other Co',
        name: 'Other Owner',
        email: `simplify_other_${ts}@ex.com`,
        password,
      })
      .expect(201);
    otherToken = other.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function createWorkflow(body: Record<string, unknown>): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send(body)
      .expect(201);
    return created.body.id as string;
  }

  // ── 1. Readiness preflight ─────────────────────────────────────────────────

  it('reports a runnable manual workflow as ready without changing it', async () => {
    const id = await createWorkflow({
      name: `ready-${ts}`,
      definition: runnable,
    });

    const before = await request(app.getHttpServer())
      .get(`/workflows/${id}`)
      .set(bearer(token))
      .expect(200);

    const readiness = await request(app.getHttpServer())
      .get(`/workflows/${id}/readiness`)
      .set(bearer(token))
      .expect(200);

    expect(readiness.body.ready).toBe(true);
    expect(readiness.body.issues).toEqual([]);
    expect(readiness.body.summary.stepCount).toBe(1);
    expect(readiness.body.summary.triggerSummary).toBe(
      'Manual — someone starts it',
    );
    expect(readiness.body.checks.map((c: { key: string }) => c.key)).toContain(
      'STRUCTURE',
    );

    // Non-mutating: the workflow is byte-identical afterwards (status, version
    // pointers and updatedAt all unchanged).
    const after = await request(app.getHttpServer())
      .get(`/workflows/${id}`)
      .set(bearer(token))
      .expect(200);
    expect(after.body).toEqual(before.body);
  });

  it('refuses to store a schedule with no time, and reports a real one as ready', async () => {
    const id = await createWorkflow({
      name: `unscheduled-${ts}`,
      definition: runnable,
    });

    // The trigger is set by PATCH, not on create. An incomplete SCHEDULE is
    // rejected at SAVE time — which is the guarantee that actually protects the
    // user, and the reason readiness' TRIGGER_INCOMPLETE branch is defence in
    // depth (covered directly in workflow-readiness.spec.ts) rather than the
    // everyday path. The builder therefore has to write a complete schedule.
    await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({ triggerType: 'SCHEDULE', triggerConfig: {} })
      .expect(400);

    // Every Monday at 09:00 — exactly what the friendly schedule picker emits.
    await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({ triggerType: 'SCHEDULE', triggerConfig: { cron: '0 9 * * 1' } })
      .expect(200);

    const readiness = await request(app.getHttpServer())
      .get(`/workflows/${id}/readiness`)
      .set(bearer(token))
      .expect(200);

    expect(readiness.body.ready).toBe(true);
    expect(readiness.body.summary.triggerSummary).toBe(
      'On a schedule (0 9 * * 1)',
    );
    expect(
      readiness.body.checks.find((c: { key: string }) => c.key === 'SCHEDULE')
        .status,
    ).toBe('PASS');
  });

  it('does not leak another tenant’s workflow readiness', async () => {
    const id = await createWorkflow({
      name: `isolated-${ts}`,
      definition: runnable,
    });

    await request(app.getHttpServer())
      .get(`/workflows/${id}/readiness`)
      .set(bearer(otherToken))
      .expect(404);
  });

  it('agrees with publish: what readiness blocks, publish refuses', async () => {
    // THE contract this preflight exists to keep. Readiness is only useful if
    // "ready" means publish will succeed and "not ready" means it won't — a
    // preflight that disagrees with the operation it predicts is worse than no
    // preflight, because the user acts on it.
    //
    // The regression that prompted this: an unreachable step was classified as
    // a warning, readiness reported ready, and publish returned 400.
    const orphaned = {
      nodes: [
        { id: 'n1', type: 'TRIGGER', config: {}, position: { x: 0, y: 0 } },
        { id: 'n2', type: 'NOOP', config: {}, position: { x: 0, y: 120 } },
        { id: 'n3', type: 'NOOP', config: {}, position: { x: 200, y: 120 } },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const id = await createWorkflow({ name: `agree-${ts}`, definition: orphaned });

    const readiness = await request(app.getHttpServer())
      .get(`/workflows/${id}/readiness`)
      .set(bearer(token))
      .expect(200);
    expect(readiness.body.ready).toBe(false);
    const unreachable = readiness.body.issues.find(
      (i: { code: string }) => i.code === 'UNREACHABLE_NODE',
    );
    expect(unreachable.severity).toBe('BLOCKER');
    // Listed once, not once per source.
    expect(
      readiness.body.issues.filter((i: { message: string }) =>
        i.message.includes('n3'),
      ),
    ).toHaveLength(1);

    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition: orphaned })
      .expect(200);

    // Publish agrees.
    await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({ activate: true })
      .expect(400);

    // Connect it, and both flip together.
    const connected = {
      ...orphaned,
      edges: [...orphaned.edges, { from: 'n2', to: 'n3' }],
    };
    await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({ definition: connected })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`/workflows/${id}/readiness`)
      .set(bearer(token))
      .expect(200);
    expect(after.body.ready).toBe(true);

    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition: connected })
      .expect(200);

    const published = await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({ activate: true })
      .expect(200);
    expect(published.body.activated).toBe(true);
  });

  // ── 2. Publish & activate in one request ──────────────────────────────────

  it('publishes and activates in one request, and stays idempotent', async () => {
    const id = await createWorkflow({
      name: `oneclick-${ts}`,
      definition: runnable,
    });

    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition: runnable })
      .expect(200);

    const first = await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({ changeNote: 'Go live', activate: true })
      .expect(200);

    expect(first.body.unchanged).toBe(false);
    expect(first.body.activated).toBe(true);
    expect(first.body.workflow.status).toBe('ACTIVE');
    expect(first.body.version.version).toBe(1);

    // Pressing it twice must not create v2 of the same graph, and must leave the
    // workflow active rather than bouncing it. The draft save mirrors what
    // `usePublishAndActivate` does on every click — publish refuses outright
    // when there is no draft to freeze.
    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition: runnable })
      .expect(200);

    const second = await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({ activate: true })
      .expect(200);

    expect(second.body.unchanged).toBe(true);
    expect(second.body.activated).toBe(true);
    expect(second.body.workflow.status).toBe('ACTIVE');
    expect(second.body.version.version).toBe(1);
  });

  it('publishes without activating when the flag is absent', async () => {
    const id = await createWorkflow({
      name: `publishonly-${ts}`,
      definition: runnable,
    });

    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition: runnable })
      .expect(200);

    const result = await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({})
      .expect(200);

    expect(result.body.activated).toBe(false);
    expect(result.body.workflow).toBeNull();

    const after = await request(app.getHttpServer())
      .get(`/workflows/${id}`)
      .set(bearer(token))
      .expect(200);
    expect(after.body.status).toBe('DRAFT');
  });

  it('reports a refused activation truthfully instead of failing the whole call', async () => {
    // Publish and activate enforce different rules: a trigger with nothing after
    // it is a VALID graph to publish, but activate refuses it. Since publish has
    // already committed a version by then, the response must say "published, not
    // activated, here's why" — a bare error would leave the client believing
    // nothing happened while v1 exists.
    const triggerOnly = {
      nodes: [{ id: 'n1', type: 'TRIGGER', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const id = await createWorkflow({
      name: `invalid-${ts}`,
      definition: triggerOnly,
    });

    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition: triggerOnly })
      .expect(200);

    const result = await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({ activate: true })
      .expect(200);

    expect(result.body.activated).toBe(false);
    expect(result.body.workflow).toBeNull();
    expect(result.body.activationError).toContain('at least one step');

    const after = await request(app.getHttpServer())
      .get(`/workflows/${id}`)
      .set(bearer(token))
      .expect(200);
    // Published, but NOT live — exactly what the response said.
    expect(after.body.status).toBe('DRAFT');
    expect(after.body.activeVersionId).toBe(result.body.version.id);
  });

  it('readiness catches that case BEFORE anything is published', async () => {
    // The reason the case above is an edge case and not the normal experience:
    // Review & Publish runs the preflight first, and the preflight applies the
    // activation rules too.
    const triggerOnly = {
      nodes: [{ id: 'n1', type: 'TRIGGER', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const id = await createWorkflow({
      name: `preflight-${ts}`,
      definition: triggerOnly,
    });

    const readiness = await request(app.getHttpServer())
      .get(`/workflows/${id}/readiness`)
      .set(bearer(token))
      .expect(200);

    expect(readiness.body.ready).toBe(false);
    expect(
      readiness.body.issues.map((i: { code: string }) => i.code),
    ).toContain('NO_STEPS');
  });

  // ── 3. Cross-workflow runs list ───────────────────────────────────────────

  it('lists runs across workflows with the workflow name joined in', async () => {
    const idA = await createWorkflow({
      name: `runs-a-${ts}`,
      definition: runnable,
    });
    const idB = await createWorkflow({
      name: `runs-b-${ts}`,
      definition: runnable,
    });

    for (const id of [idA, idB]) {
      await request(app.getHttpServer())
        .post(`/workflows/${id}/run`)
        .set(bearer(token))
        .send({})
        .expect(201);
    }

    const all = await request(app.getHttpServer())
      .get('/workflows/runs')
      .set(bearer(token))
      .expect(200);

    const mine = all.body.filter((r: { workflowId: string }) =>
      [idA, idB].includes(r.workflowId),
    );
    expect(mine).toHaveLength(2);
    expect(mine.map((r: { workflowName: string }) => r.workflowName).sort()).toEqual(
      [`runs-a-${ts}`, `runs-b-${ts}`],
    );

    // Filtering by workflow narrows it.
    const filtered = await request(app.getHttpServer())
      .get(`/workflows/runs?workflowId=${idA}`)
      .set(bearer(token))
      .expect(200);
    expect(
      filtered.body.every((r: { workflowId: string }) => r.workflowId === idA),
    ).toBe(true);

    // An unrecognised status degrades to "no filter" rather than a 400, so a
    // stale bookmark can't break the operations page.
    await request(app.getHttpServer())
      .get('/workflows/runs?status=NOT_A_STATUS')
      .set(bearer(token))
      .expect(200);

    // Tenant isolation: the other company sees none of these runs.
    const others = await request(app.getHttpServer())
      .get('/workflows/runs')
      .set(bearer(otherToken))
      .expect(200);
    expect(
      others.body.some((r: { workflowId: string }) =>
        [idA, idB].includes(r.workflowId),
      ),
    ).toBe(false);
  });
});
