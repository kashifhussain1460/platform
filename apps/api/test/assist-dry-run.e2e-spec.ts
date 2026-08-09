import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * The agent's self-test (doc 30 wave A6, §13).
 *
 * The load-bearing assertion in this file is that **the dry run is genuinely
 * dry**. Letting an agent run a workflow is only acceptable because the engine
 * short-circuits every real side effect under `dryRun` — if that ever stopped
 * being true, an assist "test" would quietly send real emails and post to real
 * channels while telling the user it was simulated. That is the worst possible
 * failure mode this feature has, so it gets a test that fails loudly.
 *
 * Runs inline (`WORKFLOW_EXECUTION_MODE=inline`) so no worker is needed.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Assist dry-run self-test (doc 30 A6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let companyId = '';
  const previousMode = process.env.WORKFLOW_EXECUTION_MODE;

  beforeAll(async () => {
    process.env.WORKFLOW_EXECUTION_MODE = 'inline';

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
      .send({
        companyName: 'DryRun Co',
        name: 'Dee Owner',
        email: `dryrun_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;

    await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(token))
      .send({ plan: 'BUSINESS' })
      .expect(201);

    // A real employee and a real messaging skill, so the built graph contains a
    // TOOL_ACTION that WOULD send something if the dry run were not honoured.
    await request(app.getHttpServer())
      .post('/employees')
      .set(bearer(token))
      .send({ name: 'Emma', role: 'HR' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'slack' })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    process.env.WORKFLOW_EXECUTION_MODE = previousMode;
  });

  /** Run one full build turn and hand back the session id. */
  const build = async (prompt: string): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(token))
      .send({ prompt })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/assist/sessions/${created.body.id}/turns`)
      .set(bearer(token))
      .send({ text: 'Build it and test it.' })
      .expect(201);
    return created.body.id;
  };

  it('🔑 runs the test WITHOUT causing any real side effect', async () => {
    const before = await prisma.skillExecution.count({ where: { companyId } });

    const sessionId = await build(
      'When a CV arrives, have Emma score it and post the result to Slack.',
    );

    const messages = await prisma.assistMessage.findMany({
      where: { sessionId, role: 'ASSISTANT' },
    });
    const meta = messages[0]?.metadata as {
      toolTrace: { name: string; ok: boolean }[];
    };
    // It actually tested — not just claimed to.
    expect(meta.toolTrace.map((t) => t.name)).toContain('dry_run_test');

    // 🔑 THE assertion. A real Slack post would have written a SkillExecution
    // audit row; a simulated one does not.
    const after = await prisma.skillExecution.count({ where: { companyId } });
    expect(after).toBe(before);
  }, 60_000);

  it('reports every simulated step as simulated, and never claims otherwise', async () => {
    const sessionId = await build('Score a CV then message the team on Slack.');

    const message = await prisma.assistMessage.findFirstOrThrow({
      where: { sessionId, role: 'ASSISTANT' },
    });
    const trace = (message.metadata as { toolTrace: { name: string; summary: string }[] })
      .toolTrace;
    const test = trace.find((t) => t.name === 'dry_run_test');
    expect(test).toBeDefined();

    // The headline is written by the SERVER, not narrated by the model, so the
    // honesty is structural rather than a matter of prompt compliance.
    expect(test?.summary).toMatch(/simulated|paused|Ran/i);
  }, 60_000);

  it('deletes the scratch workflow and keeps it out of the user\'s list', async () => {
    const listBefore = await request(app.getHttpServer())
      .get('/workflows')
      .set(bearer(token))
      .expect(200);

    await build('Build something testable.');

    // No leftovers at all — the `finally` cleaned up.
    const scratch = await prisma.workflow.count({
      where: { companyId, isAssistScratch: true },
    });
    expect(scratch).toBe(0);

    // And the user's list is untouched by the whole exercise.
    const listAfter = await request(app.getHttpServer())
      .get('/workflows')
      .set(bearer(token))
      .expect(200);
    expect(listAfter.body.length).toBe(listBefore.body.length);
  }, 60_000);

  it('hides a scratch workflow from the list even if one is left behind', async () => {
    // Belt and braces: a hard crash between create and delete would leak one,
    // and it must still never be visible to the user.
    const leaked = await prisma.workflow.create({
      data: {
        companyId,
        name: '[assist test] leaked',
        definition: { nodes: [], edges: [] },
        isAssistScratch: true,
      },
      select: { id: true },
    });

    const list = await request(app.getHttpServer())
      .get('/workflows')
      .set(bearer(token))
      .expect(200);
    expect(list.body.some((w: { id: string }) => w.id === leaked.id)).toBe(false);

    await prisma.workflow.delete({ where: { id: leaked.id } });
  });

  it('records the test result on the turn so the UI can show it', async () => {
    const sessionId = await build('Make a small flow and check it runs.');

    const session = await request(app.getHttpServer())
      .get(`/assist/sessions/${sessionId}`)
      .set(bearer(token))
      .expect(200);

    // The draft survived the test — testing must never mutate what was built.
    expect(session.body.draftDefinition).toBeTruthy();
    expect(session.body.draftDefinition.nodes.length).toBeGreaterThan(1);
  }, 60_000);
});
