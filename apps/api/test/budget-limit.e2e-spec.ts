import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Budget-limit enforcement e2e: needs a live Postgres + Redis. Skipped when
// DATABASE_URL is unset so it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Budget limit enforcement e2e (chat)', () => {
  let app: INestApplication;
  const email = `budget_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let employeeId = '';
  let conversationId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

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
      .send({ companyName: 'Budget E2E Co', name: 'Budget Owner', email, password })
      .expect(201);
    accessToken = res.body.tokens.accessToken;

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Budget Bot', role: 'SUPPORT' })
      .expect(201);
    employeeId = emp.body.id;
    // Role-based hiring (2026-09-04): every new employee starts at the plan's
    // per-employee ceiling — Free is 500 credits = $5 — instead of unlimited.
    expect(emp.body.budgetLimit).toBe(5);
    // The create response does not compute month-to-date cost.
    expect(emp.body.monthToDateCostUsd).toBeNull();

    const conv = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/conversations`)
      .set(auth())
      .send({ title: 'Budget check' })
      .expect(201);
    conversationId = conv.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a message succeeds under the plan default ceiling, and records real cost', async () => {
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth())
      .send({ content: 'Hello, first message' })
      .expect(201);

    const emp = await request(app.getHttpServer())
      .get(`/employees/${employeeId}`)
      .set(auth())
      .expect(200);
    // monthToDateCostUsd is computed whenever budgetLimit is set — and since
    // every employee now starts at the plan ceiling, that is always, so the
    // real cost of the message above shows up here.
    expect(emp.body.monthToDateCostUsd).toBeGreaterThan(0);
  });

  it('blocks a message once a budget limit set below the already-spent amount', async () => {
    // Discover this month's real spend so far by setting a limit, then
    // reading it back -- avoids hardcoding an assumption about exact token
    // counts/rates.
    await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set(auth())
      .send({ budgetLimit: 5 }) // the plan's ceiling; anything above is refused
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set(auth())
      .send({ budgetLimit: 999999 })
      .expect(400);
    const before = await request(app.getHttpServer())
      .get(`/employees/${employeeId}`)
      .set(auth())
      .expect(200);
    const spentSoFar = before.body.monthToDateCostUsd as number;
    expect(spentSoFar).toBeGreaterThan(0);

    // budgetLimit is a whole-dollar Int, but real per-message cost is a tiny
    // fraction of a cent -- there's no non-zero whole-dollar value guaranteed
    // to sit below it. $0 is the one integer limit certain to be at/below
    // any positive spend, and (spent >= budgetLimit) blocks correctly.
    await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set(auth())
      .send({ budgetLimit: 0 })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth())
      .send({ content: 'This one should be blocked' })
      .expect(409);
    expect(String(res.body.message)).toContain('budget limit');
  });

  it('a fresh employee with a real (unspent) budget limit can still chat', async () => {
    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      // A DIFFERENT role: Free is 1 per role, and SUPPORT is already taken above.
      .send({ name: 'Fresh Budget Bot', role: 'SALES' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/employees/${emp.body.id}`)
      .set(auth())
      .send({ budgetLimit: 5 }) // plan maximum
      .expect(200);
    const conv = await request(app.getHttpServer())
      .post(`/employees/${emp.body.id}/conversations`)
      .set(auth())
      .send({ title: 'Fresh budget check' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/conversations/${conv.body.id}/messages`)
      .set(auth())
      .send({ content: 'Well under the limit' })
      .expect(201);
  });
});
