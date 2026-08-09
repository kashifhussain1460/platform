import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Minimal resumable onboarding: company → AI employees → goals, persisted
 * server-side (survives re-login), with deterministic goal reconciliation when
 * the AI-employee selection changes. Real DB.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Onboarding — resumable 3-step + goal reconciliation', () => {
  let app: INestApplication;
  const ts = Date.now();
  const email = `onb_${ts}@ex.com`;
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: `Onb Co ${ts}`, name: 'Owner', email, password })
      .expect(201);
    token = reg.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  const status = async (t = token) =>
    (await request(app.getHttpServer()).get('/onboarding/status').set(bearer(t)).expect(200)).body;

  it('walks the 3 steps, reconciles goals on selection change, and resumes after re-login', async () => {
    // Fresh: not started.
    let s = await status();
    expect(s.completed).toBe(false);
    expect(s.step).toBe('NOT_STARTED');
    expect(s.selectedRoles).toEqual([]);

    // Step 1 — company.
    s = (
      await request(app.getHttpServer())
        .patch('/onboarding/company')
        .set(bearer(token))
        .send({ name: 'Acme', industry: 'Technology', size: '11-50' })
        .expect(200)
    ).body;
    expect(s.step).toBe('AI_EMPLOYEE_SELECTION');
    expect(s.company.name).toBe('Acme');

    // Step 2 — both AI employees.
    s = (
      await request(app.getHttpServer())
        .patch('/onboarding/ai-employees')
        .set(bearer(token))
        .send({ roles: ['HR', 'MARKETING'] })
        .expect(200)
    ).body;
    expect(s.selectedRoles.sort()).toEqual(['HR', 'MARKETING']);
    expect(s.step).toBe('BUSINESS_GOALS');

    // Step 3 — goals across both roles.
    s = (
      await request(app.getHttpServer())
        .patch('/onboarding/goals')
        .set(bearer(token))
        .send({ goals: ['Recruitment', 'Content Creation', 'SEO'] })
        .expect(200)
    ).body;
    expect(s.goals.sort()).toEqual(['Content Creation', 'Recruitment', 'SEO']);

    // Change selection to HR only → Marketing-only goals must be pruned.
    s = (
      await request(app.getHttpServer())
        .patch('/onboarding/ai-employees')
        .set(bearer(token))
        .send({ roles: ['HR'] })
        .expect(200)
    ).body;
    expect(s.selectedRoles).toEqual(['HR']);
    expect(s.goals).toEqual(['Recruitment']); // Content Creation + SEO dropped

    // A goal not allowed for the current roles is rejected (filtered out).
    s = (
      await request(app.getHttpServer())
        .patch('/onboarding/goals')
        .set(bearer(token))
        .send({ goals: ['Recruitment', 'SEO'] })
        .expect(200)
    ).body;
    expect(s.goals).toEqual(['Recruitment']); // SEO (Marketing) filtered

    // Resume after a fresh login (different token) — state persisted server-side.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const resumed = await status(login.body.tokens.accessToken);
    expect(resumed.step).toBe('BUSINESS_GOALS');
    expect(resumed.selectedRoles).toEqual(['HR']);
    expect(resumed.goals).toEqual(['Recruitment']);
    expect(resumed.company.name).toBe('Acme');
    expect(resumed.completed).toBe(false);
  }, 30_000);
});
