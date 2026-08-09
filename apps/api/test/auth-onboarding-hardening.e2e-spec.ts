import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Regression cover for the auth-flow + onboarding corrections:
 *  - a DISABLED account cannot refresh or read /auth/me (kill switch actually ends the session)
 *  - email is case-insensitive at register + login
 *  - login resolves the right tenant when one address exists in several companies
 *  - onboarding persists the chosen departments (previously silently dropped)
 *  - onboarding is idempotent (a retry must not hire everyone twice)
 *  - completing onboarding is OWNER/ADMIN only
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Auth + onboarding hardening', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const register = async (over: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Hardening Co ${ts}-${Math.random().toString(36).slice(2, 7)}`,
        name: 'Owner',
        email: `owner_${ts}_${Math.random().toString(36).slice(2, 8)}@ex.com`,
        password,
        ...over,
      })
      .expect(201);

  // --- DISABLED account kill switch -----------------------------------------

  it('stops a DISABLED account from refreshing or reading /auth/me', async () => {
    const email = `disabled_${ts}@ex.com`;
    const reg = await register({ email });
    const token: string = reg.body.tokens.accessToken;
    const cookie = reg.headers['set-cookie'];

    // Sanity: works while ACTIVE.
    await request(app.getHttpServer()).get('/auth/me').set(bearer(token)).expect(200);
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie).expect(201);

    await prisma.user.updateMany({ where: { email }, data: { status: 'DISABLED' } });

    // The refresh cookie is still cryptographically valid — the account state
    // is what must end the session now.
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie).expect(401);
    await request(app.getHttpServer()).get('/auth/me').set(bearer(token)).expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(401);
  });

  // --- Email casing ----------------------------------------------------------

  it('treats email as case-insensitive on register and login', async () => {
    const email = `MixedCase_${ts}@Example.com`;
    await register({ email });

    // Stored lowercased...
    const stored = await prisma.user.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(stored).not.toBeNull();

    // ...and login works with any casing the user happens to type.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: email.toUpperCase(), password })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: email.toLowerCase(), password })
      .expect(201);
  });

  // --- Same email in two tenants --------------------------------------------

  it('logs into the right tenant when one email exists in several companies', async () => {
    const email = `shared_${ts}@ex.com`;
    const first = await register({ email, companyName: `Shared A ${ts}` });
    const second = await register({
      email,
      companyName: `Shared B ${ts}`,
      password: 'differentpw456',
    });
    const companyA: string = first.body.company.id;
    const companyB: string = second.body.company.id;
    expect(companyA).not.toBe(companyB);

    // Each password must resolve to ITS OWN company. Previously the lookup took
    // an arbitrary row and checked only that one, so the second account could
    // not log in at all despite correct credentials.
    const asA = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    expect(asA.body.company.id).toBe(companyA);

    const asB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'differentpw456' })
      .expect(201);
    expect(asB.body.company.id).toBe(companyB);
  });

  // --- Onboarding: departments persisted + idempotent ------------------------

  it('persists chosen departments and stays idempotent on retry', async () => {
    const reg = await register();
    const token: string = reg.body.tokens.accessToken;
    const companyId: string = reg.body.company.id;

    const body = {
      business: { industry: 'SaaS', size: '11-50' },
      departments: ['HR', 'CUSTOMER_SUPPORT'],
      employees: [{ role: 'HR', name: 'Emma' }],
    };

    const first = await request(app.getHttpServer())
      .post('/onboarding/complete')
      .set(bearer(token))
      .send(body)
      .expect(201);

    // Departments are real rows now, returned for the client's org cache.
    // 'HR' stays an acronym, not naive-Title-Cased into 'Hr' (caught live by
    // browser-testing the wizard).
    expect(first.body.departments.map((d: { name: string }) => d.name).sort()).toEqual([
      'Customer Support',
      'HR',
    ]);
    expect(first.body.employees).toHaveLength(1);
    expect(first.body.company.onboardedAt).not.toBeNull();

    const inDb = await prisma.department.findMany({ where: { companyId } });
    expect(inDb).toHaveLength(2);

    // Retry the exact same call (double-click / client retry).
    const retry = await request(app.getHttpServer())
      .post('/onboarding/complete')
      .set(bearer(token))
      .send(body)
      .expect(201);
    expect(retry.body.employees).toHaveLength(0); // nothing hired twice

    // The decisive assertion: no duplicates anywhere.
    expect(await prisma.department.count({ where: { companyId } })).toBe(2);
    expect(await prisma.aiEmployee.count({ where: { companyId } })).toBe(1);
  });

  // --- Onboarding authorization ---------------------------------------------

  it('refuses onboarding completion for a plain MEMBER', async () => {
    const reg = await register();
    const ownerToken: string = reg.body.tokens.accessToken;
    const companyId: string = reg.body.company.id;

    const memberEmail = `member_${ts}_${Math.random().toString(36).slice(2, 7)}@ex.com`;
    await request(app.getHttpServer())
      .post('/users')
      .set(bearer(ownerToken))
      .send({ email: memberEmail, name: 'Member', password, role: 'MEMBER' })
      .expect(201);

    const memberLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password })
      .expect(201);

    await request(app.getHttpServer())
      .post('/onboarding/complete')
      .set(bearer(memberLogin.body.tokens.accessToken))
      .send({ departments: ['HR'], employees: [{ role: 'HR' }] })
      .expect(403);

    // Reads stay open to any member.
    await request(app.getHttpServer())
      .get('/onboarding/status')
      .set(bearer(memberLogin.body.tokens.accessToken))
      .expect(200);

    // And the refused call changed nothing.
    expect(await prisma.aiEmployee.count({ where: { companyId } })).toBe(0);
  });
});
