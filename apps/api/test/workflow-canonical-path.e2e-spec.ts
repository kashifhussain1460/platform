import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { WorkflowEngine } from '../src/modules/workflows/engine/workflow-engine.service';
import { WorkflowsService } from '../src/modules/workflows/workflows.service';

/**
 * WAVE 1 — ONE canonical execution path.
 *
 * `WorkflowsService.enqueueRun` is the only place a WorkflowRun may be created,
 * and `RunStateWriter` the only place its status may change. Before this wave a
 * SCHEDULE fire did neither: `WorkflowEngine.trigger()` called
 * `prisma.workflowRun.create()` itself, so scheduled runs were the one kind that
 * executed with no pinned version, no idempotency key and no `workflow:run`
 * check. This suite pins all three, plus the cancel path that used to write
 * `status` directly and emit no realtime event.
 *
 * Needs live Postgres + Redis.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('WAVE 1 — canonical execution path', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workflows: WorkflowsService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let companyId = '';


  const linear = {
    nodes: [
      { id: 'n1', type: 'TRIGGER', config: {} },
      { id: 'n2', type: 'NOOP', config: {} },
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
    prisma = app.get(PrismaService);
    workflows = app.get(WorkflowsService);

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Canonical Path Co',
        name: 'Owner',
        email: `canon_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

  });

  afterAll(async () => {
    await app?.close();
  });

  /** Create a SCHEDULE workflow, publish v1 and activate it. */
  const scheduledWorkflow = async (name: string): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name, definition: linear })
      .expect(201);
    const id = created.body.id as string;

    await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({ triggerType: 'SCHEDULE', triggerConfig: { everyMs: 3_600_000 } })
      .expect(200);
    // The DRAFT version is what publish freezes; it is created by PUT /draft.
    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition: linear })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({})
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${id}/activate`)
      .set(bearer(token))
      .expect(200);
    return id;
  };

  const runsOf = (workflowId: string) =>
    prisma.workflowRun.findMany({
      where: { workflowId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        source: true,
        workflowVersionId: true,
        idempotencyKey: true,
      },
    });

  // ── G-B1 ──────────────────────────────────────────────────────────────────

  it('G-B1: a SCHEDULE fire pins the run to the ACTIVE WorkflowVersion', async () => {
    const id = await scheduledWorkflow(`canon-pin-${ts}`);
    const wf = await prisma.workflow.findUniqueOrThrow({
      where: { id },
      select: { activeVersionId: true },
    });
    expect(wf.activeVersionId).toBeTruthy();

    await workflows.fireSchedule(id);

    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe('SCHEDULE');
    // THE regression: this was null for every scheduled run, so the run
    // executed the mutable `Workflow.definition` column instead of the version.
    expect(runs[0].workflowVersionId).toBe(wf.activeVersionId);
    expect(runs[0].idempotencyKey).toContain(`schedule:${id}:`);
  });

  it('G-B1: publishing a new version does NOT move an existing scheduled run', async () => {
    const id = await scheduledWorkflow(`canon-pin2-${ts}`);
    const v1 = (
      await prisma.workflow.findUniqueOrThrow({
        where: { id },
        select: { activeVersionId: true },
      })
    ).activeVersionId;

    await workflows.fireSchedule(id);
    const [runA] = await runsOf(id);

    // Edit + publish v2, and activate it.
    await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOOP', config: {} },
            { id: 'n3', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' },
          ],
        },
      })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOOP', config: {} },
            { id: 'n3', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' },
          ],
        },
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({ activate: true })
      .expect(200);

    const v2 = (
      await prisma.workflow.findUniqueOrThrow({
        where: { id },
        select: { activeVersionId: true },
      })
    ).activeVersionId;
    expect(v2).not.toBe(v1);

    const runAAfter = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runA.id },
      select: { workflowVersionId: true },
    });
    expect(runAAfter.workflowVersionId).toBe(v1);
  });

  it('G-B1: two schedule fires inside one interval produce ONE run', async () => {
    const id = await scheduledWorkflow(`canon-idem-${ts}`);

    // Both drivers firing the same occurrence — the exact double-fire the
    // inline-mode guard exists to prevent, now also stopped at the database.
    await workflows.fireSchedule(id);
    await workflows.fireSchedule(id);

    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
  });

  it('G-B1: a schedule fire is REFUSED once the run subject is DISABLED', async () => {
    const id = await scheduledWorkflow(`canon-authz-${ts}`);

    // Restrict RUN to one named user. The run subject for an automated trigger
    // is the pinned version's publisher (doc 09 §9.C.3), so make the publisher
    // that user — and then disable them. §9.C.5's company kill-switch says a
    // DISABLED user's permissions must stop authorising automated runs.
    const publisher = await prisma.user.create({
      data: {
        companyId,
        email: `canon_pub_${ts}@ex.com`,
        name: 'Publisher',
        passwordHash: 'x',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const wf = await prisma.workflow.findUniqueOrThrow({
      where: { id },
      select: { activeVersionId: true },
    });
    await prisma.workflowVersion.update({
      where: { id: wf.activeVersionId! },
      data: { publishedById: publisher.id },
    });
    await request(app.getHttpServer())
      .post(`/workflows/${id}/permissions`)
      .set(bearer(token))
      .send({ subjectType: 'USER', subjectId: publisher.id, action: 'RUN' })
      .expect(201);

    // Activation registers a BullMQ repeatable whose FIRST occurrence lands
    // asynchronously. Let it settle and clear it, so what follows measures only
    // the call under test. The interval is an hour, so nothing else can fire.
    await new Promise((r) => setTimeout(r, 1_500));
    await prisma.workflowRun.deleteMany({ where: { workflowId: id } });

    // While the publisher is ACTIVE the schedule fires normally.
    await workflows.fireSchedule(id);
    expect(await runsOf(id)).toHaveLength(1);
    await prisma.workflowRun.deleteMany({ where: { workflowId: id } });

    // Kill switch: revoke the publisher's account.
    await prisma.user.update({
      where: { id: publisher.id },
      data: { status: 'DISABLED' },
    });

    await workflows.fireSchedule(id);

    // Refused, not crashed: a background job has no caller to receive a 403,
    // so `fireSchedule` swallows the denial and logs it.
    expect(await runsOf(id)).toHaveLength(0);
  });

  it('G-B1: a PAUSED workflow does not fire even if a repeatable outlives deactivation', async () => {
    // Published but never activated, so no repeatable is ever registered and
    // nothing but the call under test can create a run here.
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: `canon-paused-${ts}`, definition: linear })
      .expect(201);
    const id = created.body.id as string;
    await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({ triggerType: 'SCHEDULE', triggerConfig: { everyMs: 3_600_000 } })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition: linear })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({})
      .expect(200);

    const status = (
      await prisma.workflow.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      })
    ).status;
    expect(status).not.toBe('ACTIVE');

    await workflows.fireSchedule(id);

    expect(await runsOf(id)).toHaveLength(0);
  });

  it('G-B1: WorkflowEngine no longer exposes a run-creating trigger()', () => {
    // Structural guard. The gap was one method that created a WorkflowRun
    // outside enqueueRun; this fails if it is ever reintroduced.
    const engine = app.get(WorkflowEngine) as unknown as Record<string, unknown>;
    expect(typeof engine.trigger).toBe('undefined');
  });

  // ── G-B2 ──────────────────────────────────────────────────────────────────

  it('G-B2: cancelling a run emits run.cancelled and is guarded', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({
        name: `canon-cancel-${ts}`,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'APPROVAL', config: { message: 'ok?' } },
            { id: 'n3', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' },
          ],
        },
      })
      .expect(201);
    const id = created.body.id as string;

    const run = await request(app.getHttpServer())
      .post(`/workflows/${id}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);
    const runId = run.body.id as string;

    // Wait for it to park on the approval.
    const deadline = Date.now() + 25_000;
    let status = '';
    while (Date.now() < deadline) {
      const r = await prisma.workflowRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true },
      });
      status = r.status;
      if (status === 'WAITING') break;
      await new Promise((res) => setTimeout(res, 250));
    }
    expect(status).toBe('WAITING');

    await request(app.getHttpServer())
      .post(`/workflows/runs/${runId}/cancel`)
      .set(bearer(token))
      .expect(201);

    const after = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true, failureClass: true, resumeNodeId: true },
    });
    expect(after.status).toBe('CANCELLED');
    // Was missing entirely: a user cancel was indistinguishable from a crash.
    expect(after.failureClass).toBe('CANCELLED');
    expect(after.resumeNodeId).toBeNull();

    // THE regression: `run.cancelled` is a declared event type that nothing
    // emitted, so the realtime stream never learned the run had been cancelled.
    const events = await prisma.runEventOutbox.findMany({
      where: { runId },
      select: { eventType: true },
    });
    expect(events.map((e) => e.eventType)).toContain('run.cancelled');
  });

  it('G-B2: cancelling an already-finished run is a 409, not a silent stomp', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: `canon-cancel2-${ts}`, definition: linear })
      .expect(201);
    const id = created.body.id as string;
    const run = await request(app.getHttpServer())
      .post(`/workflows/${id}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);
    const runId = run.body.id as string;

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const r = await prisma.workflowRun.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true },
      });
      if (r.status === 'COMPLETED' || r.status === 'FAILED') break;
      await new Promise((res) => setTimeout(res, 250));
    }

    await request(app.getHttpServer())
      .post(`/workflows/runs/${runId}/cancel`)
      .set(bearer(token))
      .expect(409);

    // And the terminal state survived the attempt.
    const after = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
      select: { status: true },
    });
    expect(['COMPLETED', 'FAILED']).toContain(after.status);
    expect(after.status).not.toBe('CANCELLED');
  });

  // ── Guard: enqueueRun is the ONLY WorkflowRun creator ─────────────────────

  it('every WorkflowRun this suite created carries a pinned version or an explicit reason', async () => {
    const runs = await prisma.workflowRun.findMany({
      where: { companyId },
      select: { id: true, source: true, workflowVersionId: true },
    });
    const scheduled = runs.filter((r) => r.source === 'SCHEDULE');
    expect(scheduled.length).toBeGreaterThan(0);
    for (const r of scheduled) {
      expect(r.workflowVersionId).toBeTruthy();
    }
  });
});
