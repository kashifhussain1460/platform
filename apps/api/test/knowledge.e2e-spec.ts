import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Like the auth e2e, this needs a live Postgres + Redis. It is skipped when
// DATABASE_URL is unset so it never blocks the build. Run it with:
//   EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DOC_TEXT = [
  'The Vertical AI Employee Platform lets companies hire managed AI employees.',
  'Each AI employee is onboarded with company knowledge and can handle support,',
  'sales, and operations tasks autonomously while staying tenant-scoped.',
].join(' ');

describeIfDb('Knowledge e2e (upload -> ingest -> search)', () => {
  let app: INestApplication;
  const email = `kb_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let documentId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'KB E2E Co', name: 'KB Owner', email, password })
      .expect(201);
    accessToken = res.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('uploads a text document (PENDING)', async () => {
    const res = await request(app.getHttpServer())
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from(DOC_TEXT, 'utf8'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.filename).toBe('notes.txt');
    expect(res.body.status).toBe('PENDING');
    documentId = res.body.id;
  });

  it('ingests the document to READY', async () => {
    const deadline = Date.now() + 20_000;
    let status = 'PENDING';
    let chunkCount = 0;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/knowledge/documents/${documentId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      status = res.body.status;
      chunkCount = res.body.chunkCount;
      if (status === 'READY' || status === 'FAILED') {
        break;
      }
      await sleep(500);
    }
    expect(status).toBe('READY');
    expect(chunkCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('returns a matching chunk from /knowledge/search', async () => {
    const res = await request(app.getHttpServer())
      .post('/knowledge/search')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ query: 'managed AI employees for support', k: 5 })
      .expect(201);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);

    const top = res.body[0];
    expect(top.documentId).toBe(documentId);
    expect(top.content.toLowerCase()).toContain('employee');

    // RANKING, not the score's sign.
    //
    // `expect(score > 0)` was asserting a property of the EMBEDDING PROVIDER, not
    // of search. The default test provider is `hash` — deterministic random
    // projections, offline — where the cosine between any two texts sits around
    // zero with either sign; this exact query scored -0.0212, every run. It only
    // ever passed when a real semantic provider was in play, which is to say the
    // suite was quietly making live API calls.
    //
    // What search actually promises is that the best match comes FIRST, and that
    // is what is checked now — a stronger assertion, and one that holds for every
    // provider rather than for whichever one happened to be configured.
    const scores = (res.body as { score: number }[]).map((r) => r.score);
    expect(scores.every((s) => Number.isFinite(s))).toBe(true);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('rejects knowledge routes without a token', async () => {
    await request(app.getHttpServer()).get('/knowledge/documents').expect(401);
  });

  it('uploads a document tagged with a category, and it is included when listing that category', async () => {
    const res = await request(app.getHttpServer())
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('category', 'SALES')
      .attach('file', Buffer.from('Sales playbook content.', 'utf8'), {
        filename: 'sales-playbook.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    expect(res.body.category).toBe('SALES');

    const listed = await request(app.getHttpServer())
      .get('/knowledge/documents?category=SALES')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(listed.body.some((d: { id: string }) => d.id === res.body.id)).toBe(true);

    const listedHr = await request(app.getHttpServer())
      .get('/knowledge/documents?category=HR')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(listedHr.body.some((d: { id: string }) => d.id === res.body.id)).toBe(false);
  });

  it('retags a document via PATCH .../category, moving it between categories', async () => {
    const updated = await request(app.getHttpServer())
      .patch(`/knowledge/documents/${documentId}/category`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ category: 'HR' })
      .expect(200);
    expect(updated.body.category).toBe('HR');

    const backToShared = await request(app.getHttpServer())
      .patch(`/knowledge/documents/${documentId}/category`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ category: null })
      .expect(200);
    expect(backToShared.body.category).toBeNull();
  });

  it('rejects an invalid category value on PATCH .../category with a 400', async () => {
    await request(app.getHttpServer())
      .patch(`/knowledge/documents/${documentId}/category`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ category: 'NOT_A_REAL_ROLE' })
      .expect(400);
  });

  it('a document uploaded with no category (Shared) appears in every category-filtered list', async () => {
    const salesListed = await request(app.getHttpServer())
      .get('/knowledge/documents?category=SALES')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const hrListed = await request(app.getHttpServer())
      .get('/knowledge/documents?category=HR')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // documentId was set back to a Shared document (no category) by the PATCH-to-null
    // step in the previous test — a Shared doc must appear in every category's list.
    expect(salesListed.body.some((d: { id: string }) => d.id === documentId)).toBe(true);
    expect(hrListed.body.some((d: { id: string }) => d.id === documentId)).toBe(true);
  });
});
