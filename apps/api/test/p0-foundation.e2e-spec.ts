import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * P0 Foundation e2e — covers the two gaps closed in this wave.
 *
 *   G29  DELETE /workflows/:id was a HARD delete that cascaded to every
 *        WorkflowRun and WorkflowStepRun, destroying execution history.
 *        It is now a soft delete (status=ARCHIVED) that keeps everything.
 *
 *   G10  EmployeeRole had no MARKETING value, so a Marketing AI Employee had to
 *        be CUSTOM — which silently broke role-scoped knowledge retrieval.
 *
 * Needs a live Postgres + Redis. Skipped when DATABASE_URL is unset.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('P0 Foundation — G29 soft delete + G10 MARKETING role', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ownerEmail = `p0_owner_${Date.now()}@example.com`;
  const password = 'password123';
  let ownerToken = '';
  let companyId = '';

  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

  /** A minimal runnable workflow: TRIGGER -> NOTIFY. */
  const makeWorkflow = async (name: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOTIFY', config: { message: 'hello' } },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(201);
    return res.body.id as string;
  };

  const runToTerminal = async (workflowId: string): Promise<string> => {
    const start = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({})
      .expect(201);
    const runId = start.body.id as string;

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/workflows/runs/${runId}`)
        .set(auth())
        .expect(200);
      if (['COMPLETED', 'FAILED'].includes(res.body.status)) break;
      await sleep(300);
    }
    return runId;
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

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'P0 Foundation Co',
        name: 'P0 Owner',
        email: ownerEmail,
        password,
      })
      .expect(201);
    ownerToken = res.body.tokens.accessToken;
    companyId = res.body.company.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── G29 ────────────────────────────────────────────────────────────────────

  it('G29: DELETE archives the workflow and PRESERVES its run history', async () => {
    const workflowId = await makeWorkflow('Soft delete me');
    const runId = await runToTerminal(workflowId);

    const stepsBefore = await prisma.workflowStepRun.count({ where: { runId } });
    expect(stepsBefore).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .delete(`/workflows/${workflowId}`)
      .set(auth())
      .expect(204);

    // The workflow row survives, archived — not destroyed.
    const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
    expect(wf).not.toBeNull();
    expect(wf!.status).toBe('ARCHIVED');

    // The whole point of G29: history is still there.
    expect(await prisma.workflowRun.count({ where: { id: runId } })).toBe(1);
    expect(await prisma.workflowStepRun.count({ where: { runId } })).toBe(
      stepsBefore,
    );
  });

  it('G29: DELETE is idempotent (archiving twice is a no-op, still 204)', async () => {
    const workflowId = await makeWorkflow('Delete twice');
    await request(app.getHttpServer())
      .delete(`/workflows/${workflowId}`)
      .set(auth())
      .expect(204);
    await request(app.getHttpServer())
      .delete(`/workflows/${workflowId}`)
      .set(auth())
      .expect(204);

    const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
    expect(wf!.status).toBe('ARCHIVED');
  });

  it('G29: an ARCHIVED workflow cannot be run', async () => {
    const workflowId = await makeWorkflow('Archived, not runnable');
    await request(app.getHttpServer())
      .delete(`/workflows/${workflowId}`)
      .set(auth())
      .expect(204);

    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({})
      .expect(409);
  });

  it('G29: an ARCHIVED workflow cannot be activated', async () => {
    const workflowId = await makeWorkflow('Archived, not activatable');
    await request(app.getHttpServer())
      .delete(`/workflows/${workflowId}`)
      .set(auth())
      .expect(204);

    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/activate`)
      .set(auth())
      .expect(409);
  });

  it('G29: DELETE returns 409 while a run is still in flight', async () => {
    const workflowId = await makeWorkflow('Has an in-flight run');
    // Force a non-terminal run directly — deterministic, no timing race.
    await prisma.workflowRun.create({
      data: { companyId, workflowId, status: 'RUNNING', source: 'MANUAL' },
    });

    await request(app.getHttpServer())
      .delete(`/workflows/${workflowId}`)
      .set(auth())
      .expect(409);

    // Still untouched — the guard must not partially apply.
    const wf = await prisma.workflow.findUnique({ where: { id: workflowId } });
    expect(wf!.status).not.toBe('ARCHIVED');
  });

  it('G29: PATCH cannot set status=ARCHIVED (would bypass the in-flight guard)', async () => {
    const workflowId = await makeWorkflow('Patch cannot archive');
    await request(app.getHttpServer())
      .patch(`/workflows/${workflowId}`)
      .set(auth())
      .send({ status: 'ARCHIVED' })
      .expect(400);
  });

  // ── G10 ────────────────────────────────────────────────────────────────────

  it('G10: MARKETING is an accepted employee role and persists', async () => {
    const res = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Mira', role: 'MARKETING' })
      .expect(201);

    expect(res.body.role).toBe('MARKETING');

    const row = await prisma.aiEmployee.findUnique({
      where: { id: res.body.id },
    });
    expect(row!.role).toBe('MARKETING');
  });

  it('G10: knowledge is role-scoped to MARKETING (not leaked to other roles)', async () => {
    // A MARKETING-categorised document must be invisible to an HR-scoped read.
    await prisma.knowledgeDocument.create({
      data: {
        companyId,
        filename: 'brand-voice-guide.txt',
        mimeType: 'text/plain',
        sizeBytes: 42,
        storageKey: `p0-test/${Date.now()}-brand-voice-guide.txt`,
        status: 'READY',
        category: 'MARKETING',
      },
    });

    const marketing = await request(app.getHttpServer())
      .get('/knowledge/documents?category=MARKETING')
      .set(auth())
      .expect(200);
    expect(
      marketing.body.some((d: { filename: string }) => d.filename === "brand-voice-guide.txt"),
    ).toBe(true);

    const hr = await request(app.getHttpServer())
      .get('/knowledge/documents?category=HR')
      .set(auth())
      .expect(200);
    expect(
      hr.body.some((d: { filename: string }) => d.filename === "brand-voice-guide.txt"),
    ).toBe(false);
  });
});
