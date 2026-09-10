import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * GET /employees/:id/readiness e2e.
 *
 * The gap: a hired employee lands ACTIVE the instant it's created, with zero
 * skills, connections, knowledge or workflows — and the UI showed the exact
 * same green ACTIVE pill as a fully configured one. This proves the derived
 * readiness surface actually reflects real state through the real API, not
 * just that the pure evaluator's unit tests pass in isolation.
 *
 * Needs a live Postgres + Redis; skipped when DATABASE_URL is unset. Run with:
 *   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
 *   SKILL_EXECUTOR=mock BILLING_PROVIDER=mock ENCRYPTION_KEY=<64 hex> \
 *   npx jest --config ./test/jest-e2e.json employee-readiness --forceExit
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

interface ReadinessBody {
  employeeId: string;
  ready: boolean;
  setupState: 'READY' | 'NEEDS_SETUP' | 'BLOCKED';
  checks: { key: string; status: string }[];
  issues: { code: string; severity: string; skillKey: string | null }[];
  summary: {
    skillKeys: string[];
    unreadySkillKeys: string[];
    workflowCount: number;
    activeWorkflowCount: number;
  };
}

describeIfDb('Employee readiness e2e (derived, not stored)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `emp_readiness_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  const readiness = (id: string) =>
    request(app.getHttpServer())
      .get(`/employees/${id}/readiness`)
      .set(auth())
      .expect(200)
      .then((r) => r.body as ReadinessBody);

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
        companyName: 'Employee Readiness E2E Co',
        name: 'Readiness Owner',
        email,
        password,
      })
      .expect(201);
    accessToken = res.body.tokens.accessToken;

    // ENTERPRISE: this suite hires several employees and connects skills.
    await prisma.subscription.updateMany({
      where: { companyId: res.body.company.id },
      data: { plan: 'ENTERPRISE' },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('a freshly hired employee NEEDS_SETUP — zero skills, zero workflows', async () => {
    const hired = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Bare Emma', role: 'HR' })
      .expect(201);

    const body = await readiness(hired.body.id);

    expect(body.ready).toBe(true); // no BLOCKER — just advisory gaps
    expect(body.setupState).toBe('NEEDS_SETUP');
    expect(body.issues.map((i) => i.code).sort()).toEqual(
      ['NO_KNOWLEDGE', 'NO_SKILLS_ASSIGNED', 'NO_WORKFLOWS'].sort(),
    );
    expect(body.checks.find((c) => c.key === 'STATUS')?.status).toBe('PASS');
    expect(body.checks.find((c) => c.key === 'SKILLS')?.status).toBe('WARN');
  });

  it('assigning a CONNECTED skill clears the skills gap and NO_SKILLS_ASSIGNED', async () => {
    const hired = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Skilled Sam', role: 'SUPPORT' })
      .expect(201);

    // github: api_key, no provider adapter registered, so connect() writes
    // CONNECTED unconditionally — the simplest deterministic path to a
    // genuinely-connected skill without mocking an OAuth adapter.
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'github' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/skills/installed/${installed.body.id}/connect`)
      .set(auth())
      .send({ credentials: { apiKey: 'ghp_example' } })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/employees/${hired.body.id}/skills`)
      .set(auth())
      .send({ installedSkillId: installed.body.id })
      .expect(201);

    const body = await readiness(hired.body.id);

    expect(body.summary.skillKeys).toEqual(['github']);
    expect(body.summary.unreadySkillKeys).toEqual([]);
    expect(body.issues.some((i) => i.code === 'NO_SKILLS_ASSIGNED')).toBe(false);
    expect(body.issues.some((i) => i.code === 'SKILL_NOT_CONNECTED')).toBe(false);
    // Still NEEDS_SETUP: no workflows, and NO_KNOWLEDGE if access is on.
    expect(body.setupState).toBe('NEEDS_SETUP');
  });

  it('an assigned but NOT_CONNECTED skill is a real BLOCKER, naming the skill', async () => {
    const hired = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Waiting Wendy', role: 'MARKETING' })
      .expect(201);

    // Installed, never connected — the default state after POST /skills/install.
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'slack' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/employees/${hired.body.id}/skills`)
      .set(auth())
      .send({ installedSkillId: installed.body.id })
      .expect(201);

    const body = await readiness(hired.body.id);

    expect(body.ready).toBe(false);
    expect(body.setupState).toBe('NEEDS_SETUP');
    expect(body.summary.unreadySkillKeys).toEqual(['slack']);
    expect(body.issues).toContainEqual(
      expect.objectContaining({ code: 'SKILL_NOT_CONNECTED', skillKey: 'slack' }),
    );
    expect(body.checks.find((c) => c.key === 'CONNECTIONS')?.status).toBe('FAIL');
  });

  it('BLOCKED for a paused employee, regardless of how well configured it is', async () => {
    const hired = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Paused Pat', role: 'ACCOUNTANT' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/employees/${hired.body.id}`)
      .set(auth())
      .send({ status: 'PAUSED' })
      .expect(200);

    const body = await readiness(hired.body.id);

    expect(body.setupState).toBe('BLOCKED');
    expect(body.ready).toBe(false);
    expect(body.issues).toContainEqual(
      expect.objectContaining({ code: 'EMPLOYEE_PAUSED', severity: 'BLOCKER' }),
    );
  });

  it('a live workflow clears NO_WORKFLOWS', async () => {
    const hired = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Working Wanda', role: 'PROJECT_MANAGER' })
      .expect(201);

    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'Readiness workflow',
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            {
              id: 'n2',
              type: 'AI_EMPLOYEE_STEP',
              config: {
                employeeId: hired.body.id,
                instruction: 'Say hi',
                outputKey: 'out',
              },
            },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/workflows/${wf.body.id}/draft`)
      .set(auth())
      .send({ definition: wf.body.definition })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/publish`)
      .set(auth())
      .send({ activate: true })
      .expect(200);

    const body = await readiness(hired.body.id);

    expect(body.summary.workflowCount).toBe(1);
    expect(body.summary.activeWorkflowCount).toBe(1);
    expect(body.issues.some((i) => i.code === 'NO_WORKFLOWS')).toBe(false);
    expect(body.issues.some((i) => i.code === 'NO_ACTIVE_WORKFLOWS')).toBe(false);
  });

  it('404s for another tenant\'s employee id — no cross-tenant leak', async () => {
    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Other Tenant Co',
        name: 'Other Owner',
        email: `other_readiness_${Date.now()}@example.com`,
        password,
      })
      .expect(201);
    const otherAuth = { Authorization: `Bearer ${other.body.tokens.accessToken}` };
    const otherEmployee = await request(app.getHttpServer())
      .post('/employees')
      .set(otherAuth)
      .send({ name: 'Not Yours', role: 'HR' })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/employees/${otherEmployee.body.id}/readiness`)
      .set(auth())
      .expect(404);
  });
});
