import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Marketplace e2e: needs a live Postgres + Redis. Skipped when DATABASE_URL is
// unset so it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   BILLING_PROVIDER=mock \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Marketplace e2e (unified catalog + install employee/workflow)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let companyId = '';
  const email = `marketplace_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';

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

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Marketplace E2E Co',
        name: 'Marta Place',
        email,
        password,
      })
      .expect(201);
    companyId = reg.body.company.id;
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    accessToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /marketplace returns non-empty employees and skills', async () => {
    const res = await request(app.getHttpServer())
      .get('/marketplace')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body.employees)).toBe(true);
    expect(Array.isArray(res.body.skills)).toBe(true);
    expect(res.body.employees.length).toBeGreaterThan(0);
    expect(res.body.skills.length).toBeGreaterThan(0);
    // Employee templates carry role + persona.
    const emp = res.body.employees[0];
    expect(typeof emp.key).toBe('string');
    expect(typeof emp.role).toBe('string');
    expect(typeof emp.persona).toBe('string');
  });

  it('no longer serves workflow templates — one authoritative system', async () => {
    // Phase 4 §4. Two systems installed workflow templates; the DB-backed
    // `WorkflowTemplate` at `/workflow-templates` won because it has
    // versioning, provenance, idempotent installs, prerequisite checks and
    // node-vocabulary validation. This shim had none of them.
    const res = await request(app.getHttpServer())
      .get('/marketplace')
      .set(auth())
      .expect(200);
    expect(res.body.workflows).toBeUndefined();

    await request(app.getHttpServer())
      .post('/marketplace/workflows/recruiting-resume-score-schedule/install')
      .set(auth())
      .expect(404);
  });

  it('POST /marketplace/employees/:key/install hires an employee that appears in /employees', async () => {
    const res = await request(app.getHttpServer())
      .post('/marketplace/employees/sales-ai/install')
      .set(auth())
      .send({ name: 'Ada the Closer' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('Ada the Closer');
    expect(res.body.role).toBe('SALES');
    expect(res.body.persona).toBeTruthy();

    const list = await request(app.getHttpServer())
      .get('/employees')
      .set(auth())
      .expect(200);
    expect(
      list.body.some((e: { id: string }) => e.id === res.body.id),
    ).toBe(true);
  });

  it('POST /marketplace/employees/marketing-ai/install hires role MARKETING, not CUSTOM', async () => {
    // Regression: this entry predated the MARKETING EmployeeRole and was left
    // as role: 'CUSTOM' — an employee hired from here could not satisfy any of
    // the 11 Marketing workflow templates' `requires: {employeeRoles:
    // ['MARKETING']}` prerequisite (workflow-templates.service.ts), so it was
    // installable but silently unusable for its own product's Marketing
    // workflows.
    const res = await request(app.getHttpServer())
      .post('/marketplace/employees/marketing-ai/install')
      .set(auth())
      .send({ name: 'Max the Marketer' })
      .expect(201);
    expect(res.body.role).toBe('MARKETING');
  });


  it('returns 404 for an unknown employee key', async () => {
    await request(app.getHttpServer())
      .post('/marketplace/employees/does-not-exist/install')
      .set(auth())
      .send({})
      .expect(404);
  });

  it('rejects marketplace routes without a token (401)', async () => {
    await request(app.getHttpServer()).get('/marketplace').expect(401);
    await request(app.getHttpServer())
      .post('/marketplace/employees/sales-ai/install')
      .send({})
      .expect(401);
    // The workflow-install route is gone, so there is nothing left to guard.
  });

  it('a MEMBER may browse the catalog but NOT hire from it', async () => {
    // Regression test for a real privilege gap: this controller carried
    // `@UseGuards(JwtAuthGuard)` alone with no permission decorator on the
    // install route, so any authenticated MEMBER could hire an AI Employee —
    // consuming a plan seat and stamping a monthly credit budget — while the
    // canonical POST /employees required `employee:manage` (floor ADMIN).
    // No test on any hire route checked a MEMBER, which is how it survived.
    // 🔴 Lift to ENTERPRISE (unlimited seats) FIRST. Without this the test is a
    // false positive: earlier cases in this suite already hired sales-ai and
    // marketing-ai, exhausting STARTER's 2-role cap, so `checkSeatFor` throws
    // its own ForbiddenException and the assertion passes even with the
    // authorization guard removed — verified by mutation. Removing seats from
    // the picture makes authorization the only thing that can produce a 403.
    /** TEST SCAFFOLDING ONLY — a precondition, not the thing under test. */
    await prisma.subscription.updateMany({
      where: { companyId },
      data: { plan: 'ENTERPRISE' },
    });

    const memberEmail = `marketplace_member_${Date.now()}@example.com`;
    const memberPassword = 'password123';
    await request(app.getHttpServer())
      .post('/users')
      .set(auth())
      .send({
        email: memberEmail,
        name: 'Marketplace Member',
        role: 'MEMBER',
        password: memberPassword,
      })
      .expect(201);
    const memberLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password: memberPassword })
      .expect(201);
    const memberAuth = {
      Authorization: `Bearer ${memberLogin.body.tokens.accessToken}`,
    };

    // Browsing stays open — discovery is not a privileged action.
    await request(app.getHttpServer())
      .get('/marketplace')
      .set(memberAuth)
      .expect(200);

    // Hiring is.
    const refused = await request(app.getHttpServer())
      .post('/marketplace/employees/sales-ai/install')
      .set(memberAuth)
      .send({ name: 'Should Not Exist' })
      .expect(403);

    // Prove it is the AUTHORIZATION refusal, not a seat refusal wearing the
    // same status code — the distinction this test exists to make.
    expect(String(refused.body.message).toLowerCase()).not.toContain('seat');
    expect(String(refused.body.message).toLowerCase()).not.toContain('plan');

    // And nothing was created.
    const roster = await request(app.getHttpServer())
      .get('/employees')
      .set(auth())
      .expect(200);
    expect(
      (roster.body as { name: string }[]).some(
        (e) => e.name === 'Should Not Exist',
      ),
    ).toBe(false);
  });
});
