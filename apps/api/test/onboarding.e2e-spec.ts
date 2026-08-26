import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Onboarding e2e: needs a live Postgres. Skipped when DATABASE_URL is unset so
// it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Onboarding e2e (register profile -> wizard -> employee config)', () => {
  let app: INestApplication;
  const email = `onb_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let employeeId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers with extra company profile fields + admin phone', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Onboard E2E Co',
        name: 'Onboard Owner',
        email,
        password,
        industry: 'SaaS',
        size: '11-50',
        country: 'UK',
        timezone: 'Europe/London',
        website: 'https://onboard.example',
        logoUrl: 'https://onboard.example/logo.png',
        description: 'We build things.',
        phone: '+44 20 1234 5678',
      })
      .expect(201);

    // Profile fields persisted + onboardedAt still null.
    expect(res.body.company.industry).toBe('SaaS');
    expect(res.body.company.size).toBe('11-50');
    expect(res.body.company.country).toBe('UK');
    expect(res.body.company.website).toBe('https://onboard.example');
    expect(res.body.company.onboardedAt).toBeNull();
    expect(res.body.user.phone).toBe('+44 20 1234 5678');
    accessToken = res.body.tokens.accessToken;
  });

  it('reports onboarding not completed', async () => {
    const res = await request(app.getHttpServer())
      .get('/onboarding/status')
      .set(auth())
      .expect(200);
    expect(res.body.completed).toBe(false);
  });

  it('returns the hire catalog of role templates', async () => {
    const res = await request(app.getHttpServer())
      .get('/onboarding/catalog')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    const recruiter = res.body.find(
      (t: { role: string }) => t.role === 'RECRUITER',
    );
    expect(recruiter).toBeTruthy();
    expect(recruiter.suggestedName).toBe('RecruitAI');
    expect(recruiter.departments).toEqual(
      expect.arrayContaining(['RECRUITMENT']),
    );
  });

  it('completes onboarding: creates employees + updates business + stamps onboardedAt', async () => {
    const res = await request(app.getHttpServer())
      .post('/onboarding/complete')
      .set(auth())
      .send({
        business: {
          industry: 'FinTech',
          size: '51-200',
          description: 'Payments for SMBs.',
        },
        departments: ['SALES', 'CUSTOMER_SUPPORT'],
        employees: [
          { role: 'SALES', name: 'Sable' },
          { role: 'SUPPORT' },
        ],
      })
      .expect(201);

    expect(res.body.employees.length).toBe(2);
    const sales = res.body.employees.find(
      (e: { role: string }) => e.role === 'SALES',
    );
    const support = res.body.employees.find(
      (e: { role: string }) => e.role === 'SUPPORT',
    );
    expect(sales.name).toBe('Sable');
    // No name provided → suggested name from the catalog.
    expect(support.name).toBe('SupportAI');
    employeeId = support.id;

    // Business fields updated + onboardedAt set.
    expect(res.body.company.industry).toBe('FinTech');
    expect(res.body.company.size).toBe('51-200');
    expect(res.body.company.description).toBe('Payments for SMBs.');
    expect(res.body.company.onboardedAt).toBeTruthy();
  });

  it('reports onboarding completed after finishing', async () => {
    const res = await request(app.getHttpServer())
      .get('/onboarding/status')
      .set(auth())
      .expect(200);
    expect(res.body.completed).toBe(true);
  });

  it('persists rich employee config via PATCH /employees/:id', async () => {
    const patch = await request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set(auth())
      .send({
        department: 'CUSTOMER_SUPPORT',
        managerName: 'Dana Lead',
        workingHoursStart: '09:00',
        workingHoursEnd: '17:00',
        timezone: 'Europe/London',
        language: 'English',
        knowledgeAccess: 'NONE',
        budgetLimit: 5000,
        permissions: { sendEmail: true, makePayments: false },
        // Phase 1: `approveOverBudget` is deliberately NOT accepted any more
        // (budgetLimit is a hard block, not an approval trigger — there was
        // nothing to enforce). Sent here on purpose to prove it is dropped
        // rather than stored as a rule nothing reads.
        approvalRules: { approveOverBudget: true, approveExternalMessages: true },
      })
      .expect(200);
    expect(patch.body.knowledgeAccess).toBe('NONE');

    const get = await request(app.getHttpServer())
      .get(`/employees/${employeeId}`)
      .set(auth())
      .expect(200);

    expect(get.body.department).toBe('CUSTOMER_SUPPORT');
    expect(get.body.managerName).toBe('Dana Lead');
    expect(get.body.workingHoursStart).toBe('09:00');
    expect(get.body.workingHoursEnd).toBe('17:00');
    expect(get.body.timezone).toBe('Europe/London');
    expect(get.body.language).toBe('English');
    expect(get.body.knowledgeAccess).toBe('NONE');
    expect(get.body.budgetLimit).toBe(5000);
    expect(get.body.permissions).toEqual({ sendEmail: true, makePayments: false });
    // Only the enforced flag survives; the unenforceable one is gone.
    expect(get.body.approvalRules).toEqual({ approveExternalMessages: true });
  });
});
