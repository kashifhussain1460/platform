import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Marketing production verification e2e — the central invariant (doc 28 §0.2):
 * a Marketing employee cannot publish without a human approval. Verified on the
 * TOOL_ACTION publish surface end-to-end (postiz.publish_now is highRisk, so the
 * engine auto-pauses the run BEFORE executing, even with no APPROVAL node), and
 * a rejection fails the run so nothing publishes.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Marketing production verification — publish is never autonomous', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let companyId = '';

  const pollRun = async (id: string): Promise<{ status: string }> => {
    let run = { status: 'PENDING' };
    for (let i = 0; i < 40 && !['WAITING', 'COMPLETED', 'FAILED'].includes(run.status); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const got = await request(app.getHttpServer())
        .get(`/workflows/runs/${id}`)
        .set(bearer(token))
        .expect(200);
      run = got.body;
    }
    return run;
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
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Mkt Prod Co', name: 'Owner', email: `mktprod_${ts}@example.com`, password: 'password123' })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const publishes = () =>
    prisma.skillExecution.count({
      where: { companyId, skillKey: 'postiz', tool: 'publish_now' },
    });

  it('a postiz.publish_now TOOL_ACTION auto-pauses (WAITING) and does NOT publish; reject → FAILED, still no publish', async () => {
    const before = await publishes();
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({
        name: 'Publish probe',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'pub', type: 'TOOL_ACTION', config: { skillKey: 'postiz', tool: 'publish_now', args: { content: 'hello world' } } },
            { id: 'done', type: 'TERMINATE', config: {} },
          ],
          edges: [
            { from: 't', to: 'pub' },
            { from: 'pub', to: 'done' },
          ],
        },
      })
      .expect(201);

    const started = await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);

    const run = await pollRun(started.body.id);
    expect(run.status).toBe('WAITING'); // paused BEFORE publishing
    expect(await publishes()).toBe(before); // nothing published

    // A PENDING approval for the publish exists.
    const approvals = await request(app.getHttpServer())
      .get('/approvals')
      .set(bearer(token))
      .expect(200);
    const pending = (approvals.body as { id: string; skillKey?: string; tool?: string; status: string }[]).find(
      (a) => a.tool === 'publish_now' && a.status === 'PENDING',
    );
    expect(pending).toBeDefined();

    // Reject → run FAILED → still nothing published.
    await request(app.getHttpServer())
      .post(`/approvals/${pending!.id}/reject`)
      .set(bearer(token))
      .send({ note: 'off brand' })
      .expect((r) => {
        if (![200, 201].includes(r.status)) throw new Error(`reject failed: ${r.status}`);
      });

    const after = await pollRun(started.body.id);
    expect(after.status).toBe('FAILED');
    expect(await publishes()).toBe(before);
  }, 30_000);
});
