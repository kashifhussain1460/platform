import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PostizClientService } from '../src/modules/engines/marketing/postiz-client.service';

/**
 * JOURNEY B (reconciliation) — the Postiz "invisible engine" reconciling a
 * scheduled post against the platform's real status, AGAINST THE REAL DB.
 *
 * Postiz is an EXTERNAL provider, so its HTTP client (`PostizClientService`) is
 * the one thing sandboxed here — every Orlixa surface (the cron route, the
 * MarketingSyncService, Prisma) is real. This closes the gap that the sweep's
 * SCHEDULED→PUBLISHED/FAILED DB transition was only proven in a fully-mocked
 * unit; here real rows are seeded and the real `/admin/cron/marketing-sync`
 * route drives the real transaction.
 */
process.env.CRON_SECRET ||= 'e2e-cron-secret';

const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

// A controllable stand-in for the external Postiz API.
const postizStub = {
  posts: [] as { id: string; state: string; releaseId?: string; releaseURL?: string }[],
  listPosts: jest.fn(),
};
postizStub.listPosts.mockImplementation(async () => postizStub.posts);

describeIfDb('Journey B — Postiz reconciliation against the real DB', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  let companyId = '';
  let socialAccountId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PostizClientService)
      .useValue(postizStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: `Reconcile Co ${ts}`, name: 'Owner', email: `reconcile_${ts}@ex.com`, password: 'password123' })
      .expect(201);
    companyId = reg.body.company.id;

    const account = await prisma.socialAccount.create({
      data: { companyId, provider: 'instagram', postizIntegrationId: `int_${ts}` },
    });
    socialAccountId = account.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const seedScheduled = (postizPostId: string) =>
    prisma.scheduledPost.create({
      data: {
        companyId,
        socialAccountId,
        content: 'hello world',
        publishAt: new Date(0),
        postizPostId,
        status: 'SCHEDULED',
      },
    });

  it('marks a scheduled post PUBLISHED and records a PublishedPost when Postiz confirms it', async () => {
    const post = await seedScheduled(`p_pub_${ts}`);
    postizStub.posts = [
      { id: post.postizPostId!, state: 'PUBLISHED', releaseId: 'ig_123', releaseURL: 'https://instagram.com/p/abc' },
    ];

    const res = await request(app.getHttpServer())
      .post('/admin/cron/marketing-sync')
      .set('x-cron-secret', process.env.CRON_SECRET as string)
      .expect(200);
    expect(res.body.reconciled).toBeGreaterThanOrEqual(1);

    const after = await prisma.scheduledPost.findUnique({ where: { id: post.id } });
    expect(after?.status).toBe('PUBLISHED');
    const published = await prisma.publishedPost.findUnique({
      where: { scheduledPostId: post.id },
    });
    expect(published).not.toBeNull();
    expect(published?.platformPostId).toBe('ig_123');
    expect(published?.permalink).toBe('https://instagram.com/p/abc');
  }, 30_000);

  it('marks a scheduled post FAILED and records no PublishedPost when Postiz reports an error', async () => {
    const post = await seedScheduled(`p_err_${ts}`);
    postizStub.posts = [{ id: post.postizPostId!, state: 'ERROR' }];

    await request(app.getHttpServer())
      .post('/admin/cron/marketing-sync')
      .set('x-cron-secret', process.env.CRON_SECRET as string)
      .expect(200);

    const after = await prisma.scheduledPost.findUnique({ where: { id: post.id } });
    expect(after?.status).toBe('FAILED');
    const published = await prisma.publishedPost.findUnique({
      where: { scheduledPostId: post.id },
    });
    expect(published).toBeNull();
  }, 30_000);
});
