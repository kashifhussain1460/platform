import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// RBAC + User Management e2e: needs a live Postgres + Redis. Skipped when
// DATABASE_URL is unset so it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   BILLING_PROVIDER=mock \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('RBAC + User Management e2e', () => {
  let app: INestApplication;
  const ts = Date.now();
  const ownerEmail = `rbac_owner_${ts}@example.com`;
  const memberEmail = `rbac_member_${ts}@example.com`;
  const password = 'password123';
  const memberPassword = 'memberpass123';

  let ownerToken = '';
  let ownerId = '';
  let memberToken = '';
  let memberId = '';

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

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
      .send({ companyName: 'RBAC E2E Co', name: 'RBAC Owner', email: ownerEmail, password })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('register sets the first user (company creator) to OWNER (via /auth/me)', async () => {
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer(ownerToken))
      .expect(200);
    expect(me.body.user.role).toBe('OWNER');
    expect(me.body.user.status).toBe('ACTIVE');
    expect(me.body.user.passwordHash).toBeUndefined();
    ownerId = me.body.user.id;
  });

  it('OWNER can create a MEMBER via POST /users (no passwordHash leaked)', async () => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set(bearer(ownerToken))
      .send({ email: memberEmail, name: 'RBAC Member', role: 'MEMBER', password: memberPassword })
      .expect(201);
    expect(res.body.role).toBe('MEMBER');
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.email).toBe(memberEmail);
    expect(res.body.passwordHash).toBeUndefined();
    memberId = res.body.id;

    // The new user shows up in the company roster.
    const list = await request(app.getHttpServer())
      .get('/users')
      .set(bearer(ownerToken))
      .expect(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.some((u: { id: string }) => u.id === memberId)).toBe(true);
    expect(list.body.every((u: { passwordHash?: unknown }) => u.passwordHash === undefined)).toBe(true);
  });

  it('the MEMBER can log in and read open routes', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password: memberPassword })
      .expect(201);
    memberToken = login.body.tokens.accessToken;
    expect(login.body.user.role).toBe('MEMBER');

    // GET /users is open to any authenticated member (read-only roster).
    await request(app.getHttpServer())
      .get('/users')
      .set(bearer(memberToken))
      .expect(200);
  });

  it('MEMBER is 403 on ADMIN-only routes while OWNER succeeds', async () => {
    // POST /users (user management) — denied for MEMBER.
    await request(app.getHttpServer())
      .post('/users')
      .set(bearer(memberToken))
      .send({ email: `nope_${ts}@example.com`, name: 'Nope', role: 'MEMBER', password: 'password123' })
      .expect(403);

    // POST /billing/subscription (ADMIN-level mutation) — denied for MEMBER.
    await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(memberToken))
      .send({ plan: 'PRO' })
      .expect(403);

    // The OWNER passes the same billing mutation (owner outranks everything).
    const owner = await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(ownerToken))
      .send({ plan: 'PRO' })
      .expect(201);
    expect(owner.body.plan).toBe('PRO');
  });

  it('OWNER can disable the MEMBER, and a disabled user cannot log in', async () => {
    const patched = await request(app.getHttpServer())
      .patch(`/users/${memberId}`)
      .set(bearer(ownerToken))
      .send({ status: 'DISABLED' })
      .expect(200);
    expect(patched.body.status).toBe('DISABLED');

    // A DISABLED account is rejected at login even with valid credentials.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password: memberPassword })
      .expect(401);

    // P1-5: a status-only disable (the kill-switch) is audited.
    const audit = await request(app.getHttpServer())
      .get('/audit-log')
      .set(bearer(ownerToken))
      .expect(200);
    const rows = Array.isArray(audit.body) ? audit.body : audit.body.items;
    expect(
      rows.some(
        (r: { action: string; entityId: string }) =>
          r.action === 'user.disabled' && r.entityId === memberId,
      ),
    ).toBe(true);
  });

  it('cannot delete the last OWNER', async () => {
    await request(app.getHttpServer())
      .delete(`/users/${ownerId}`)
      .set(bearer(ownerToken))
      .expect((res) => {
        if (![400, 403].includes(res.status)) {
          throw new Error(`expected 400/403 deleting last owner, got ${res.status}`);
        }
      });

    // The owner still exists afterwards.
    const list = await request(app.getHttpServer())
      .get('/users')
      .set(bearer(ownerToken))
      .expect(200);
    expect(list.body.some((u: { id: string }) => u.id === ownerId)).toBe(true);
  });

  it('rejects /users without a token (401)', async () => {
    await request(app.getHttpServer()).get('/users').expect(401);
    await request(app.getHttpServer()).post('/users').send({}).expect(401);
  });
});
