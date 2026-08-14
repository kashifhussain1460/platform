import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * WAVE 2 — department isolation, the security policy, and OAuth hardening,
 * end to end over real HTTP against real Postgres.
 *
 * The plan's §7.2 security journey is the spine of this file:
 *
 *   Marketing Admin -> Marketing = ALLOW
 *   Marketing Admin -> HR        = DENY
 *   HR Admin        -> HR        = ALLOW
 *   HR Admin        -> Marketing = DENY
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('WAVE 2 — authorization scope + security policy', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerToken = '';
  let companyId = '';
  let marketingAdminToken = '';
  let hrAdminToken = '';
  let hrWorkflowId = '';
  let marketingWorkflowId = '';
  let hrEmployeeId = '';

  const http = () => request(app.getHttpServer());

  /** Create an ADMIN placed in `departmentId`, and log them in. */
  const makeAdmin = async (
    label: string,
    departmentId: string,
  ): Promise<string> => {
    const email = `w2_${label}_${ts}@example.com`;
    await http()
      .post('/users')
      .set(bearer(ownerToken))
      .send({ name: `${label} admin`, email, password, role: 'ADMIN' })
      .expect(201);
    await prisma.user.updateMany({
      where: { email, companyId },
      data: { departmentId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return login.body.tokens.accessToken as string;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const reg = await http()
      .post('/auth/register')
      .send({
        companyName: `Wave2 Co ${ts}`,
        name: 'Wave2 Owner',
        email: `w2_owner_${ts}@example.com`,
        password,
      })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

    // Two scoped departments, created through the real API.
    const mkt = await http()
      .post('/departments')
      .set(bearer(ownerToken))
      .send({ name: 'Marketing', scopes: ['MARKETING'] })
      .expect(201);
    const people = await http()
      .post('/departments')
      .set(bearer(ownerToken))
      .send({ name: 'People', scopes: ['HR', 'RECRUITMENT'] })
      .expect(201);

    marketingAdminToken = await makeAdmin('mkt', mkt.body.id);
    hrAdminToken = await makeAdmin('hr', people.body.id);

    const wf = async (name: string, category: string | null) => {
      const res = await http()
        .post('/workflows')
        .set(bearer(ownerToken))
        .send({
          name,
          ...(category ? { category } : {}),
          definition: {
            nodes: [
              { id: 't', type: 'TRIGGER', config: {} },
              { id: 'n', type: 'NOTIFY', config: { message: name } },
            ],
            edges: [{ from: 't', to: 'n' }],
          },
        })
        .expect(201);
      return res.body.id as string;
    };
    hrWorkflowId = await wf('HR — offboarding', 'HR');
    marketingWorkflowId = await wf('Marketing — launch', 'MARKETING');
    // Created for realism — an UNSCOPED workflow must exist for the scoped
    // assertions below to mean anything (they prove scoping, not emptiness).
    // Its id is never asserted on, so it is deliberately not captured.
    await wf('Company announcement', null);

    const emp = await http()
      .post('/employees')
      .set(bearer(ownerToken))
      .send({ name: 'Hazel', role: 'HR' })
      .expect(201);
    hrEmployeeId = emp.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── §7.2 the security journey ───────────────────────────────────────────────

  it('Marketing Admin → Marketing = ALLOW', async () => {
    await http()
      .get(`/workflows/${marketingWorkflowId}`)
      .set(bearer(marketingAdminToken))
      .expect(200);
  });

  it('Marketing Admin → HR = DENY, with a reason that names both sides', async () => {
    const res = await http()
      .get(`/workflows/${hrWorkflowId}`)
      .set(bearer(marketingAdminToken))
      .expect(403);
    expect(res.body.message).toContain('Marketing');
    expect(res.body.message).toContain('HR');
  });

  it('HR Admin → HR = ALLOW, HR Admin → Marketing = DENY', async () => {
    await http()
      .get(`/workflows/${hrWorkflowId}`)
      .set(bearer(hrAdminToken))
      .expect(200);
    await http()
      .get(`/workflows/${marketingWorkflowId}`)
      .set(bearer(hrAdminToken))
      .expect(403);
  });

  it('denies RUNNING an out-of-scope workflow, not just reading it', async () => {
    // Running is the side-effecting action. Knowing the id must not be enough.
    await http()
      .post(`/workflows/${hrWorkflowId}/run`)
      .set(bearer(marketingAdminToken))
      .send({})
      .expect(403);
  });

  it('hides out-of-scope workflows from the LIST, not only the detail read', async () => {
    // A list that shows "HR — offboarding" and then 403s on open is still a
    // leak: the title alone tells a Marketing admin what they should not know.
    const res = await http()
      .get('/workflows')
      .set(bearer(marketingAdminToken))
      .expect(200);
    const names = (res.body as { name: string }[]).map((w) => w.name);
    expect(names).toContain('Marketing — launch');
    expect(names).not.toContain('HR — offboarding');
    // Company-wide resources belong to no department, so they stay visible.
    expect(names).toContain('Company announcement');
  });

  it('scopes the AI Employee roster by the employee’s role', async () => {
    await http()
      .get(`/employees/${hrEmployeeId}`)
      .set(bearer(hrAdminToken))
      .expect(200);
    await http()
      .get(`/employees/${hrEmployeeId}`)
      .set(bearer(marketingAdminToken))
      .expect(403);

    const list = await http()
      .get('/employees')
      .set(bearer(marketingAdminToken))
      .expect(200);
    expect((list.body as { id: string }[]).map((e) => e.id)).not.toContain(
      hrEmployeeId,
    );
  });

  it('never department-scopes the OWNER', async () => {
    await http()
      .get(`/workflows/${hrWorkflowId}`)
      .set(bearer(ownerToken))
      .expect(200);
    await http()
      .get(`/workflows/${marketingWorkflowId}`)
      .set(bearer(ownerToken))
      .expect(200);
  });

  it('leaves an unscoped department unrestricted — the layer ships inert', async () => {
    // THE safety property. Every pre-WAVE-2 tenant looks like this.
    const general = await http()
      .post('/departments')
      .set(bearer(ownerToken))
      .send({ name: 'General' })
      .expect(201);
    expect(general.body.scopes).toEqual([]);
    const token = await makeAdmin('general', general.body.id);

    await http().get(`/workflows/${hrWorkflowId}`).set(bearer(token)).expect(200);
    await http()
      .get(`/workflows/${marketingWorkflowId}`)
      .set(bearer(token))
      .expect(200);
  });

  it('re-reads the role from the database, so a demotion takes effect at once', async () => {
    // The JWT still says ADMIN. Authorization must not believe it.
    const email = `w2_demote_${ts}@example.com`;
    await http()
      .post('/users')
      .set(bearer(ownerToken))
      .send({ name: 'Demoted', email, password, role: 'ADMIN' })
      .expect(201);
    const login = await http()
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const token = login.body.tokens.accessToken as string;

    await http().get('/hr/staff').set(bearer(token)).expect(200);

    await prisma.user.updateMany({
      where: { email, companyId },
      data: { role: 'MEMBER' },
    });
    await http().get('/hr/staff').set(bearer(token)).expect(403);
  });

  // ── §2.4 security policy, finally executable ────────────────────────────────

  it('refuses to store mfaRequired, because nothing enforces it', async () => {
    // A settings screen that reports a protection the runtime does not apply is
    // worse than no setting: it turns an open risk into one believed closed.
    const res = await http()
      .patch('/security-policy')
      .set(bearer(ownerToken))
      .send({ mfaRequired: true })
      .expect(400);
    expect(res.body.message).toMatch(/not implemented/i);

    // Turning it OFF is always allowed.
    await http()
      .patch('/security-policy')
      .set(bearer(ownerToken))
      .send({ mfaRequired: false })
      .expect(200);
  });

  it('applies passwordMinLength to a password RESET, not only to invites', async () => {
    await http()
      .patch('/security-policy')
      .set(bearer(ownerToken))
      .send({ passwordMinLength: 16 })
      .expect(200);

    const email = `w2_reset_${ts}@example.com`;
    await http()
      .post('/users')
      .set(bearer(ownerToken))
      .send({
        name: 'Reset Me',
        email,
        password: 'a-very-long-password-1',
        role: 'MEMBER',
      })
      .expect(201);

    const user = await prisma.user.findFirstOrThrow({
      where: { email, companyId },
    });
    // Mint a reset token the way the forgot-password flow does.
    const { createHash, randomBytes } = await import('node:crypto');
    const raw = randomBytes(24).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    // 12 characters: long enough for the DTO's own floor (8, with a letter and
    // a number) but short of the COMPANY's 16, so this isolates the policy
    // check. Before WAVE 2 it succeeded — the minimum was only ever applied
    // when an admin invited a user.
    const denied = await http()
      .post('/auth/reset-password')
      .send({ token: raw, password: 'twelvechars1' })
      .expect(400);
    expect(String(denied.body.message)).toContain('16');

    await http()
      .post('/auth/reset-password')
      .send({ token: raw, password: 'sixteen-plus-chars-1' })
      .expect(201);

    await http()
      .patch('/security-policy')
      .set(bearer(ownerToken))
      .send({ passwordMinLength: 8 })
      .expect(200);
  });

  it('expires an idle session once sessionTimeoutMinutes is set', async () => {
    const email = `w2_session_${ts}@example.com`;
    await http()
      .post('/users')
      .set(bearer(ownerToken))
      .send({ name: 'Idle', email, password, role: 'MEMBER' })
      .expect(201);
    const login = await http()
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toBeDefined();

    // Refresh works while the session is fresh.
    await http().post('/auth/refresh').set('Cookie', cookie).expect(201);

    await http()
      .patch('/security-policy')
      .set(bearer(ownerToken))
      .send({ sessionTimeoutMinutes: 15 })
      .expect(200);

    // Age the CURRENT (rotated) token past the limit. Rotation is what makes
    // this an inactivity timeout rather than a hard cap.
    await prisma.refreshToken.updateMany({
      where: { user: { email, companyId }, revokedAt: null },
      data: { createdAt: new Date(Date.now() - 60 * 60_000) },
    });

    const res = await http().post('/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(401);

    await http()
      .patch('/security-policy')
      .set(bearer(ownerToken))
      .send({ sessionTimeoutMinutes: 0 })
      .expect(200);
  });
});
