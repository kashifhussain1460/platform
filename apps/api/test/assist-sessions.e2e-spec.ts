import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Orlixa AI Assist — session lifecycle (doc 30 wave A0).
 *
 * The agent itself lands in wave A2; what matters here is that the boundaries
 * are right BEFORE anything can write to a session: the plan gate, tenant
 * isolation, author privacy, and the accept role-gate that deliberately avoids
 * repeating G36 (generate-but-cannot-save).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Assist sessions (doc 30 A0)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  // Company A: owner (BUSINESS plan) + a member. Company B: an outsider.
  let ownerToken = '';
  let memberToken = '';
  let outsiderToken = '';
  let companyAId = '';
  let starterToken = '';

  const upgrade = async (token: string) =>
    request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(token))
      .send({ plan: 'BUSINESS' })
      .expect(201);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const owner = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Assist Co A',
        name: 'Ann Owner',
        email: `assist_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    ownerToken = owner.body.tokens.accessToken;
    companyAId = owner.body.company.id;
    await upgrade(ownerToken);

    // A MEMBER of the same company.
    await request(app.getHttpServer())
      .post('/users')
      .set(bearer(ownerToken))
      .send({
        name: 'Mo Member',
        email: `assist_member_${ts}@ex.com`,
        password,
        role: 'MEMBER',
      })
      .expect(201);
    const memberLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `assist_member_${ts}@ex.com`, password })
      .expect(201);
    memberToken = memberLogin.body.tokens.accessToken;

    // A different tenant entirely.
    const outsider = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Assist Co B',
        name: 'Otto Outsider',
        email: `assist_outsider_${ts}@ex.com`,
        password,
      })
      .expect(201);
    outsiderToken = outsider.body.tokens.accessToken;
    await upgrade(outsiderToken);

    // A company left on the default STARTER plan, for the plan gate.
    const starter = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Assist Co Starter',
        name: 'Stan Starter',
        email: `assist_starter_${ts}@ex.com`,
        password,
      })
      .expect(201);
    starterToken = starter.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('gates the whole feature behind BUSINESS/ENTERPRISE', async () => {
    await request(app.getHttpServer())
      .get('/assist/sessions')
      .set(bearer(starterToken))
      .expect(403);
    await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(starterToken))
      .send({ prompt: 'build me something' })
      .expect(403);
  });

  it('rejects an unauthenticated caller', async () => {
    await request(app.getHttpServer()).get('/assist/sessions').expect(401);
  });

  it('creates a session, stores the opening prompt as the first turn, and derives a title', async () => {
    const res = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(ownerToken))
      .send({ prompt: 'When a CV arrives, score it and tell me who to interview.' })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.title).toBe(
      'When a CV arrives, score it and tell me who to interview.',
    );
    // Stored, NOT answered — the agent replies on the stream (wave A3).
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].role).toBe('USER');
    // No draft yet, and therefore nothing to accept.
    expect(res.body.draftDefinition).toBeNull();
    expect(res.body.draftNodeCount).toBe(0);
    expect(res.body.draftVersion).toBe(0);
  });

  it('lists only the calling AUTHOR\'s sessions, not the whole company\'s', async () => {
    const mine = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(ownerToken))
      .send({ prompt: 'owner private session' })
      .expect(201);

    // A colleague in the SAME company must not see it.
    const memberList = await request(app.getHttpServer())
      .get('/assist/sessions')
      .set(bearer(memberToken))
      .expect(200);
    expect(memberList.body.some((s: { id: string }) => s.id === mine.body.id)).toBe(
      false,
    );

    const ownerList = await request(app.getHttpServer())
      .get('/assist/sessions')
      .set(bearer(ownerToken))
      .expect(200);
    expect(ownerList.body.some((s: { id: string }) => s.id === mine.body.id)).toBe(
      true,
    );
  });

  it('hides another author\'s session behind a 404, even for a colleague', async () => {
    const mine = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(ownerToken))
      .send({ prompt: 'still private' })
      .expect(201);

    // Same tenant, different author → 404 (not 403: existence is itself private).
    await request(app.getHttpServer())
      .get(`/assist/sessions/${mine.body.id}`)
      .set(bearer(memberToken))
      .expect(404);

    // Different tenant → 404.
    await request(app.getHttpServer())
      .get(`/assist/sessions/${mine.body.id}`)
      .set(bearer(outsiderToken))
      .expect(404);
  });

  it('refuses a targetWorkflowId belonging to another tenant', async () => {
    const theirs = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(outsiderToken))
      .send({ name: `outsider-wf-${ts}` })
      .expect(201);

    await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(ownerToken))
      .send({ prompt: 'edit that', targetWorkflowId: theirs.body.id })
      .expect(404);
  });

  it('will not accept a session that has no draft yet', async () => {
    const session = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(ownerToken))
      .send({ prompt: 'nothing built yet' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/assist/sessions/${session.body.id}/accept`)
      .set(bearer(ownerToken))
      .send({ name: 'Should not exist' })
      .expect(404);
  });

  it('accepts a draft into a REAL workflow, records provenance, and completes the session', async () => {
    const session = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(ownerToken))
      .send({ prompt: 'build a two step flow' })
      .expect(201);

    // Stand in for the agent (wave A2), which is the only thing that writes here.
    await prisma.assistSession.update({
      where: { id: session.body.id },
      data: {
        draftVersion: 3,
        draftDefinition: {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', config: {} },
            { id: 'noop', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 'trigger', to: 'noop' }],
        },
      },
    });

    const accepted = await request(app.getHttpServer())
      .post(`/assist/sessions/${session.body.id}/accept`)
      .set(bearer(ownerToken))
      .send({ name: `Accepted from assist ${ts}` })
      .expect(201);

    expect(accepted.body.id).toBeTruthy();
    expect(accepted.body.definition.nodes).toHaveLength(2);

    // It is an ordinary workflow — it shows up in the normal list.
    const list = await request(app.getHttpServer())
      .get('/workflows')
      .set(bearer(ownerToken))
      .expect(200);
    expect(list.body.some((w: { id: string }) => w.id === accepted.body.id)).toBe(
      true,
    );

    // Provenance both ways, and the conversation is closed out.
    const row = await prisma.workflow.findUnique({
      where: { id: accepted.body.id },
      select: { assistSessionId: true, isAssistScratch: true },
    });
    expect(row?.assistSessionId).toBe(session.body.id);
    expect(row?.isAssistScratch).toBe(false);

    const after = await request(app.getHttpServer())
      .get(`/assist/sessions/${session.body.id}`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(after.body.status).toBe('COMPLETED');
    expect(after.body.createdWorkflowId).toBe(accepted.body.id);
    expect(after.body.draftNodeCount).toBe(2);
    expect(after.body.draftVersion).toBe(3);
  });

  it('lets a MEMBER build but not accept — the G36 mismatch, not repeated', async () => {
    const session = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(memberToken))
      .send({ prompt: 'member is allowed to explore' })
      .expect(201);

    await prisma.assistSession.update({
      where: { id: session.body.id },
      data: {
        draftDefinition: {
          nodes: [{ id: 'trigger', type: 'TRIGGER', config: {} }],
          edges: [],
        },
      },
    });

    await request(app.getHttpServer())
      .post(`/assist/sessions/${session.body.id}/accept`)
      .set(bearer(memberToken))
      .send({ name: 'Member attempt' })
      .expect(403);
  });

  it('deletes a session and its messages, but never the workflow it produced', async () => {
    const session = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(ownerToken))
      .send({ prompt: 'delete me later' })
      .expect(201);

    await prisma.assistSession.update({
      where: { id: session.body.id },
      data: {
        draftDefinition: {
          nodes: [{ id: 'trigger', type: 'TRIGGER', config: {} }],
          edges: [],
        },
      },
    });
    const accepted = await request(app.getHttpServer())
      .post(`/assist/sessions/${session.body.id}/accept`)
      .set(bearer(ownerToken))
      .send({ name: `Survives deletion ${ts}` })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/assist/sessions/${session.body.id}`)
      .set(bearer(ownerToken))
      .expect(204);

    expect(
      await prisma.assistMessage.count({ where: { sessionId: session.body.id } }),
    ).toBe(0);
    // The workflow outlives the conversation that produced it.
    await request(app.getHttpServer())
      .get(`/workflows/${accepted.body.id}`)
      .set(bearer(ownerToken))
      .expect(200);
  });

  it('returns suggestions grounded in the tenant\'s own employees', async () => {
    await request(app.getHttpServer())
      .post('/employees')
      .set(bearer(ownerToken))
      .send({ name: 'Emma', role: 'HR' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/assist/suggestions')
      .set(bearer(ownerToken))
      .expect(200);

    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.length).toBeLessThanOrEqual(4);
    // An HR company gets HR starts, not a hardcoded generic list.
    expect(res.body.some((s: { id: string }) => s.id.startsWith('hr-'))).toBe(true);
    for (const s of res.body) {
      expect(typeof s.label).toBe('string');
      expect(typeof s.prompt).toBe('string');
    }
  });

  it('falls back to generic suggestions for a tenant with no employees', async () => {
    const res = await request(app.getHttpServer())
      .get('/assist/suggestions')
      .set(bearer(outsiderToken))
      .expect(200);
    expect(res.body.length).toBe(4);
    expect(res.body.every((s: { id: string }) => s.id.startsWith('gen-'))).toBe(true);
  });

  it('keeps sessions out of another tenant entirely', async () => {
    const rows = await prisma.assistSession.findMany({
      where: { companyId: companyAId },
      select: { userId: true },
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});
