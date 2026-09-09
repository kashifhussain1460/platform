import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Billing & Subscription e2e: needs a live Postgres + Redis. Skipped when
// DATABASE_URL is unset so it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   BILLING_PROVIDER=mock \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Billing e2e (default subscription + plans + change + usage)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `billing_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let companyId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    // register → login (register should auto-create the default subscription).
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Billing E2E Co',
        name: 'Bill Ling',
        email,
        password,
      })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    accessToken = login.body.tokens.accessToken;
    companyId = login.body.company.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('auto-creates a default STARTER/ACTIVE subscription at registration', async () => {
    // Directly assert the row exists (created during register, not on read).
    const row = await prisma.subscription.findUnique({ where: { companyId } });
    expect(row).toBeTruthy();
    expect(row?.plan).toBe('STARTER');
    expect(row?.status).toBe('ACTIVE');
    expect(row?.provider).toBe('mock');

    const res = await request(app.getHttpServer())
      .get('/billing/subscription')
      .set(auth())
      .expect(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.plan).toBe('STARTER');
    expect(res.body.status).toBe('ACTIVE');
  });

  it('GET /billing/plans returns the 4-plan catalog', async () => {
    const res = await request(app.getHttpServer())
      .get('/billing/plans')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);
    const plans = res.body.map((p: { plan: string }) => p.plan);
    expect(plans).toEqual(['STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE']);
    // Each entry has the catalog shape.
    for (const p of res.body) {
      expect(typeof p.name).toBe('string');
      expect(p.priceMonthlyUsd === null || typeof p.priceMonthlyUsd === 'number').toBe(
        true,
      );
      expect(p.maxEmployees === null || typeof p.maxEmployees === 'number').toBe(
        true,
      );
      expect(Array.isArray(p.features)).toBe(true);
    }
  });

  it('POST /billing/subscription {plan:PRO} switches the plan (mock: immediate)', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(auth())
      .send({ plan: 'PRO' })
      .expect(201);
    expect(res.body.plan).toBe('PRO');
    expect(res.body.status).toBe('ACTIVE');

    // Persisted.
    const after = await request(app.getHttpServer())
      .get('/billing/subscription')
      .set(auth())
      .expect(200);
    expect(after.body.plan).toBe('PRO');
  });

  it('GET /billing/usage returns counts + plan limit + soft over-limit flag', async () => {
    const res = await request(app.getHttpServer())
      .get('/billing/usage')
      .set(auth())
      .expect(200);
    const u = res.body;
    expect(u.plan).toBe('PRO');
    // PRO ("Starter", $20) is 2 roles × 1 = 2 seats since role-based plans.
    expect(u.maxEmployees).toBe(2);
    expect(u.seats.maxRoles).toBe(2);
    expect(u.seats.maxPerRole).toBe(1);
    expect(typeof u.employees).toBe('number');
    expect(typeof u.installedSkills).toBe('number');
    expect(typeof u.tasks).toBe('number');
    expect(u.tokens).toBe(0);
    expect(u.voiceMinutes).toBe(0);
    expect(typeof u.overEmployeeLimit).toBe('boolean');
    // Fresh company under PRO (limit 10) is not over the limit.
    expect(u.overEmployeeLimit).toBe(false);
  });

  it('a chat turn records real token usage/cost on GET /billing/usage', async () => {
    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Usage Bot', role: 'SUPPORT' })
      .expect(201);
    const conv = await request(app.getHttpServer())
      .post(`/employees/${emp.body.id}/conversations`)
      .set(auth())
      .send({ title: 'Usage check' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/conversations/${conv.body.id}/messages`)
      .set(auth())
      .send({ content: 'Hello, what can you help me with?' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/billing/usage')
      .set(auth())
      .expect(200);
    expect(res.body.tokens).toBeGreaterThan(0);
    expect(res.body.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('POST /billing/portal returns url: null under the mock provider (no real external customer)', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/portal')
      .set(auth())
      .expect(201);
    expect(res.body).toEqual({ url: null });
  });

  it('rejects billing routes without a token (401)', async () => {
    await request(app.getHttpServer()).get('/billing/subscription').expect(401);
    await request(app.getHttpServer()).get('/billing/plans').expect(401);
    await request(app.getHttpServer()).get('/billing/usage').expect(401);
    await request(app.getHttpServer())
      .post('/billing/subscription')
      .send({ plan: 'PRO' })
      .expect(401);
  });
});
