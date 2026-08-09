import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Audit log e2e: needs a live Postgres + Redis. Skipped when DATABASE_URL is
// unset so it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Audit log e2e (who-did-what trail)', () => {
  let app: INestApplication;
  const email = `audit_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let ownerAuth: { Authorization: string };
  let ownerUserId = '';

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
      .send({ companyName: 'Audit E2E Co', name: 'Audit Owner', email, password })
      .expect(201);
    ownerAuth = { Authorization: `Bearer ${reg.body.tokens.accessToken}` };
    ownerUserId = reg.body.user.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('records workflow.create, workflow.update, workflow.archive, and skill.install', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(ownerAuth)
      .send({ name: 'Audit Test Workflow' })
      .expect(201);
    const workflowId = created.body.id;

    await request(app.getHttpServer())
      .patch(`/workflows/${workflowId}`)
      .set(ownerAuth)
      .send({ description: 'updated for the audit test' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/skills/install')
      .set(ownerAuth)
      .send({ skillKey: 'slack' })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/workflows/${workflowId}`)
      .set(ownerAuth)
      .expect(204);

    const res = await request(app.getHttpServer())
      .get('/audit-log')
      .set(ownerAuth)
      .expect(200);

    const actions = res.body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'workflow.create',
        'workflow.update',
        'skill.install',
        // DELETE is now a SOFT delete (gap G29): it archives the workflow and
        // keeps every run, so the audited action is `workflow.archive`.
        // `workflow.hard_delete` is a separate, OWNER-only escape hatch.
        'workflow.archive',
      ]),
    );

    // Every entry attributes back to the acting owner by id and by resolved name.
    for (const entry of res.body) {
      expect(entry.actorUserId).toBe(ownerUserId);
      expect(entry.actorName).toBe('Audit Owner');
      expect(entry.companyId).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
    }

    const createEntry = res.body.find(
      (e: { action: string }) => e.action === 'workflow.create',
    );
    expect(createEntry.entityType).toBe('Workflow');
    expect(createEntry.entityId).toBe(workflowId);
    expect(createEntry.metadata).toEqual({ name: 'Audit Test Workflow' });
  });

  it('filters by entityType', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-log')
      .query({ entityType: 'InstalledSkill' })
      .set(ownerAuth)
      .expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(
      res.body.every((e: { entityType: string }) => e.entityType === 'InstalledSkill'),
    ).toBe(true);
  });

  it('rejects a MEMBER from reading the audit log (OWNER/ADMIN only)', async () => {
    const memberEmail = `audit_member_${Date.now()}@example.com`;
    const createdMember = await request(app.getHttpServer())
      .post('/users')
      .set(ownerAuth)
      .send({
        email: memberEmail,
        name: 'Audit Member',
        role: 'MEMBER',
        password: 'password123',
      })
      .expect(201);
    const memberUserId = createdMember.body.id;

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password: 'password123' })
      .expect(201);
    const memberAuth = { Authorization: `Bearer ${login.body.tokens.accessToken}` };

    await request(app.getHttpServer())
      .get('/audit-log')
      .set(memberAuth)
      .expect(403);

    // Also proves user.role_changed and security_policy.update get recorded.
    await request(app.getHttpServer())
      .patch(`/users/${memberUserId}`)
      .set(ownerAuth)
      .send({ role: 'ADMIN' })
      .expect(200);
    await request(app.getHttpServer())
      .patch('/security-policy')
      .set(ownerAuth)
      .send({ passwordMinLength: 10 })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/audit-log')
      .set(ownerAuth)
      .expect(200);
    const actions = res.body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.role_changed', 'security_policy.update']),
    );
    const roleChange = res.body.find(
      (e: { action: string }) => e.action === 'user.role_changed',
    );
    expect(roleChange.entityId).toBe(memberUserId);
    expect(roleChange.metadata).toEqual({ from: 'MEMBER', to: 'ADMIN' });
  });

  it('rejects audit-log routes without a token', async () => {
    await request(app.getHttpServer()).get('/audit-log').expect(401);
  });
});
