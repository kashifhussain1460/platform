import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

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

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Marketplace E2E Co',
        name: 'Marta Place',
        email,
        password,
      })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    accessToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /marketplace returns non-empty employees, workflows and skills', async () => {
    const res = await request(app.getHttpServer())
      .get('/marketplace')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body.employees)).toBe(true);
    expect(Array.isArray(res.body.workflows)).toBe(true);
    expect(Array.isArray(res.body.skills)).toBe(true);
    expect(res.body.employees.length).toBeGreaterThan(0);
    expect(res.body.workflows.length).toBeGreaterThan(0);
    expect(res.body.skills.length).toBeGreaterThan(0);
    // Employee templates carry role + persona; workflow templates a definition.
    const emp = res.body.employees[0];
    expect(typeof emp.key).toBe('string');
    expect(typeof emp.role).toBe('string');
    expect(typeof emp.persona).toBe('string');
    const wf = res.body.workflows[0];
    expect(Array.isArray(wf.definition.nodes)).toBe(true);
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

  it('POST /marketplace/workflows/:key/install installs a workflow that appears in /workflows', async () => {
    const res = await request(app.getHttpServer())
      .post('/marketplace/workflows/recruiting-resume-score-schedule/install')
      .set(auth())
      .expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.definition.nodes.length).toBeGreaterThan(1);
    expect(
      res.body.definition.nodes.some(
        (n: { type: string }) => n.type === 'TRIGGER',
      ),
    ).toBe(true);

    const list = await request(app.getHttpServer())
      .get('/workflows')
      .set(auth())
      .expect(200);
    const found = list.body.find((w: { id: string }) => w.id === res.body.id);
    expect(found).toBeTruthy();
    expect(found.definition.nodes.length).toBeGreaterThan(1);
    expect(
      found.definition.nodes.some((n: { type: string }) => n.type === 'TRIGGER'),
    ).toBe(true);
  });

  it('returns 404 for an unknown employee or workflow key', async () => {
    await request(app.getHttpServer())
      .post('/marketplace/employees/does-not-exist/install')
      .set(auth())
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post('/marketplace/workflows/does-not-exist/install')
      .set(auth())
      .expect(404);
  });

  it('rejects marketplace routes without a token (401)', async () => {
    await request(app.getHttpServer()).get('/marketplace').expect(401);
    await request(app.getHttpServer())
      .post('/marketplace/employees/sales-ai/install')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post('/marketplace/workflows/support-triage/install')
      .expect(401);
  });
});
