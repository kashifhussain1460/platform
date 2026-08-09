import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { WorkflowVersionService } from '../src/modules/workflows/workflow-version.service';

/**
 * P1-01 + P1-02 — workflow versioning (closes gap G1).
 *
 * G1: `PATCH /workflows/:id` wrote straight to `Workflow.definition`, so editing
 * an ACTIVE workflow mutated the graph that in-flight runs were still walking.
 * A run now pins `workflowVersionId` and a PUBLISHED version is immutable, so
 * an edit cannot rewrite history.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const graph = (message: string) => ({
  nodes: [
    { id: 'n1', type: 'TRIGGER', config: {} },
    { id: 'n2', type: 'NOTIFY', config: { message } },
  ],
  edges: [{ from: 'n1', to: 'n2' }],
});

describeIfDb('P1 — workflow versioning (G1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let versions: WorkflowVersionService;

  const stamp = Date.now();
  let token = '';
  let companyId = '';
  let workflowId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    versions = app.get(WorkflowVersionService);

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Versioning Co ${stamp}`,
        name: 'Version Owner',
        email: `versioning_${stamp}@example.com`,
        password: 'password123',
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;

    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name: 'Versioned workflow', definition: graph('v1') })
      .expect(201);
    workflowId = wf.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('saving a draft twice overwrites it — a draft is a scratchpad, not history', async () => {
    const first = await request(app.getHttpServer())
      .put(`/workflows/${workflowId}/draft`)
      .set(auth())
      .send({ definition: graph('draft-a') })
      .expect(200);

    const second = await request(app.getHttpServer())
      .put(`/workflows/${workflowId}/draft`)
      .set(auth())
      .send({ definition: graph('draft-b') })
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.version).toBe(first.body.version);
    expect(second.body.status).toBe('DRAFT');

    const rows = await prisma.workflowVersion.count({ where: { workflowId } });
    expect(rows).toBe(1);
  });

  it('publish freezes the draft and makes it the active version', async () => {
    const res = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/publish`)
      .set(auth())
      .send({ changeNote: 'first release' })
      .expect(200);

    expect(res.body.unchanged).toBe(false);
    expect(res.body.version.status).toBe('PUBLISHED');
    expect(res.body.version.changeNote).toBe('first release');

    const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
    expect(wf!.activeVersionId).toBe(res.body.version.id);
    // The draft pointer is cleared — the draft became the published version.
    expect(wf!.draftVersionId).toBeNull();
  });

  it('publishing an unchanged graph is idempotent (no duplicate version)', async () => {
    const before = await prisma.workflowVersion.count({ where: { workflowId } });

    await request(app.getHttpServer())
      .put(`/workflows/${workflowId}/draft`)
      .set(auth())
      .send({ definition: graph('draft-b') })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/publish`)
      .set(auth())
      .send({})
      .expect(200);

    expect(res.body.unchanged).toBe(true);
    // The no-op publish left the draft row in place; what must NOT happen is a
    // second PUBLISHED version carrying an identical graph.
    const published = await prisma.workflowVersion.count({
      where: { workflowId, status: 'PUBLISHED' },
    });
    expect(published).toBe(1);
    expect(before).toBeGreaterThan(0);
  });

  it('publishing a CHANGED graph creates v2 and deprecates v1', async () => {
    await request(app.getHttpServer())
      .put(`/workflows/${workflowId}/draft`)
      .set(auth())
      .send({ definition: graph('v2-changed') })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/publish`)
      .set(auth())
      .send({})
      .expect(200);

    expect(res.body.unchanged).toBe(false);
    expect(res.body.version.version).toBeGreaterThan(1);

    const deprecated = await prisma.workflowVersion.count({
      where: { workflowId, status: 'DEPRECATED' },
    });
    // The superseded version is kept (in-flight runs still reference it).
    expect(deprecated).toBe(1);
  });

  it('a PUBLISHED version is immutable — editing the workflow does not change it', async () => {
    const active = await prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { activeVersionId: true },
    });
    const before = await prisma.workflowVersion.findUnique({
      where: { id: active!.activeVersionId! },
    });

    // The deprecated PATCH shim still accepts a definition (ledger R6).
    await request(app.getHttpServer())
      .patch(`/workflows/${workflowId}`)
      .set(auth())
      .send({ definition: graph('patched-behind-the-scenes') })
      .expect(200);

    const after = await prisma.workflowVersion.findUnique({
      where: { id: active!.activeVersionId! },
    });
    // THE POINT OF G1: the frozen graph is byte-identical after the edit.
    expect(JSON.stringify(after!.definition)).toBe(
      JSON.stringify(before!.definition),
    );
  });

  it('a new run pins the active workflowVersionId', async () => {
    const active = await prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { activeVersionId: true },
    });

    const started = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({})
      .expect(201);

    const run = await prisma.workflowRun.findUnique({
      where: { id: started.body.id },
    });
    expect(run!.workflowVersionId).toBe(active!.activeVersionId);
  });

  it('EXECUTES the pinned version, not the live column (runtime-verification P0)', async () => {
    // State here: active version = v2 ('v2-changed'); Workflow.definition was
    // PATCHed to 'patched-behind-the-scenes' by the immutability test above.
    // A run pins v2, so the engine must execute 'v2-changed' — never the
    // patched live column. Before the fix the engine read Workflow.definition
    // and would have recorded 'patched-behind-the-scenes'.
    const started = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({})
      .expect(201);

    let run: { status: string; steps?: { type: string; output: unknown }[] } =
      started.body;
    for (let i = 0; i < 50 && run.status !== 'COMPLETED' && run.status !== 'FAILED'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const got = await request(app.getHttpServer())
        .get(`/workflows/runs/${started.body.id}`)
        .set(auth())
        .expect(200);
      run = got.body;
    }
    expect(run.status).toBe('COMPLETED');
    const notify = (run.steps ?? []).find((s) => s.type === 'NOTIFY');
    expect(notify).toBeDefined();
    expect((notify!.output as { message: string }).message).toBe('v2-changed');
    expect((notify!.output as { message: string }).message).not.toBe(
      'patched-behind-the-scenes',
    );
  }, 20_000);

  it('GET versions lists newest first; GET :version fetches one', async () => {
    const list = await request(app.getHttpServer())
      .get(`/workflows/${workflowId}/versions`)
      .set(auth())
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    expect(list.body[0].version).toBeGreaterThan(list.body[1].version);

    const one = await request(app.getHttpServer())
      .get(`/workflows/${workflowId}/versions/1`)
      .set(auth())
      .expect(200);
    expect(one.body.version).toBe(1);

    await request(app.getHttpServer())
      .get(`/workflows/${workflowId}/versions/999`)
      .set(auth())
      .expect(404);
  });

  it('backfill gives a pre-versioning workflow a v1 and is idempotent', async () => {
    // A workflow created straight through Prisma has no version, exactly like
    // every workflow that existed before this migration.
    const legacy = await prisma.workflow.create({
      data: {
        companyId,
        name: 'Legacy workflow',
        definition: graph('legacy') as never,
      },
    });

    const first = await versions.backfillMissingVersions();
    expect(first.created).toBeGreaterThanOrEqual(1);

    const after = await prisma.workflow.findUnique({
      where: { id: legacy.id },
      select: { activeVersionId: true, definition: true },
    });
    expect(after!.activeVersionId).not.toBeNull();

    const v1 = await prisma.workflowVersion.findFirst({
      where: { workflowId: legacy.id, version: 1 },
    });
    expect(v1!.status).toBe('PUBLISHED');
    // Non-destructive: the original column is untouched, so rollback is trivial.
    expect(JSON.stringify(after!.definition)).toBe(
      JSON.stringify(v1!.definition),
    );

    // Idempotent: a second run must create nothing.
    const second = await versions.backfillMissingVersions();
    expect(second.created).toBe(0);
  });

  it('an ARCHIVED workflow cannot be drafted or published', async () => {
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name: 'To archive', definition: graph('x') })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/workflows/${wf.body.id}`)
      .set(auth())
      .expect(204);

    await request(app.getHttpServer())
      .put(`/workflows/${wf.body.id}/draft`)
      .set(auth())
      .send({ definition: graph('y') })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/publish`)
      .set(auth())
      .send({})
      .expect(409);
  });
});
