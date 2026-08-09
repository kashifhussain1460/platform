import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Workflow permissions e2e (P3-06): needs a live Postgres + Redis.
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Workflow permissions e2e — RUN authz at enqueue (P3-06)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerToken = '';
  let otherToken = '';
  let member1Token = '';
  let member2Token = '';
  let member1Id = '';
  let member2Id = '';
  let deptId = '';

  const run = (token: string, id: string) =>
    request(app.getHttpServer()).post(`/workflows/${id}/run`).set(bearer(token)).send({ trigger: {} });

  /** Fresh, unrestricted TRIGGER → NOOP workflow (created by the owner). */
  const newWorkflow = async (): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(ownerToken))
      .send({
        name: `perm-wf-${Math.round(Date.now())}-${Math.random()}`,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(201);
    return res.body.id;
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

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Perm E2E', name: 'Owner', email: `perm_owner_${ts}@ex.com`, password })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;

    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Perm Other', name: 'Other', email: `perm_other_${ts}@ex.com`, password })
      .expect(201);
    otherToken = other.body.tokens.accessToken;

    const mkMember = async (n: number) => {
      const email = `perm_m${n}_${ts}@ex.com`;
      const created = await request(app.getHttpServer())
        .post('/users')
        .set(bearer(ownerToken))
        .send({ email, name: `Member ${n}`, role: 'MEMBER', password })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(201);
      return { token: login.body.tokens.accessToken, id: created.body.id };
    };
    const m1 = await mkMember(1);
    const m2 = await mkMember(2);
    member1Token = m1.token;
    member1Id = m1.id;
    member2Token = m2.token;
    member2Id = m2.id;

    // A department, with member1 in it (member2 is not).
    const dept = await request(app.getHttpServer())
      .post('/departments')
      .set(bearer(ownerToken))
      .send({ name: `Screening ${ts}` })
      .expect(201);
    deptId = dept.body.id;
    await prisma.user.update({ where: { id: member1Id }, data: { departmentId: deptId } });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('an unrestricted workflow (no grants) is runnable by any member', async () => {
    const wf = await newWorkflow();
    await run(member1Token, wf).expect(201);
    await run(member2Token, wf).expect(201);
  });

  it('managing permissions requires owner/admin; a plain MEMBER is 403', async () => {
    const wf = await newWorkflow();
    await request(app.getHttpServer())
      .post(`/workflows/${wf}/permissions`)
      .set(bearer(member2Token))
      .send({ subjectType: 'USER', subjectId: member1Id, action: 'RUN' })
      .expect(403);
    // Owner can.
    const granted = await request(app.getHttpServer())
      .post(`/workflows/${wf}/permissions`)
      .set(bearer(ownerToken))
      .send({ subjectType: 'USER', subjectId: member1Id, action: 'RUN' })
      .expect(201);
    expect(granted.body.action).toBe('RUN');
    const list = await request(app.getHttpServer())
      .get(`/workflows/${wf}/permissions`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(list.body.some((p: { id: string }) => p.id === granted.body.id)).toBe(true);
  });

  it('a USER RUN grant restricts the workflow to that user (+ admins); revoking re-opens it', async () => {
    const wf = await newWorkflow();
    const grant = await request(app.getHttpServer())
      .post(`/workflows/${wf}/permissions`)
      .set(bearer(ownerToken))
      .send({ subjectType: 'USER', subjectId: member2Id, action: 'RUN' })
      .expect(201);

    await run(member1Token, wf).expect(403); // not granted
    await run(member2Token, wf).expect(201); // the granted user
    await run(ownerToken, wf).expect(201); // owner/admin bypass

    // Revoke → unrestricted again.
    await request(app.getHttpServer())
      .delete(`/workflows/${wf}/permissions/${grant.body.id}`)
      .set(bearer(ownerToken))
      .expect(204);
    await run(member1Token, wf).expect(201);
  });

  it('a DEPARTMENT RUN grant scopes the workflow to that department', async () => {
    const wf = await newWorkflow();
    await request(app.getHttpServer())
      .post(`/workflows/${wf}/permissions`)
      .set(bearer(ownerToken))
      .send({ subjectType: 'DEPARTMENT', subjectId: deptId, action: 'RUN' })
      .expect(201);

    await run(member1Token, wf).expect(201); // in the department
    await run(member2Token, wf).expect(403); // not in the department
  });

  it('tenant isolation: another company cannot see or manage our workflow permissions', async () => {
    const wf = await newWorkflow();
    await request(app.getHttpServer())
      .get(`/workflows/${wf}/permissions`)
      .set(bearer(otherToken))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/workflows/${wf}/permissions`)
      .set(bearer(otherToken))
      .send({ subjectType: 'ROLE', subjectId: 'MEMBER', action: 'RUN' })
      .expect(404);
  });

  it('company kill-switch: a DISABLED user loses run access to a restricted workflow (doc 09 §9.C.5)', async () => {
    // A throwaway user so this doesn't affect member1/member2 used above.
    const email = `perm_kill_${ts}@ex.com`;
    const created = await request(app.getHttpServer())
      .post('/users')
      .set(bearer(ownerToken))
      .send({ email, name: 'Kill Switch', role: 'MEMBER', password })
      .expect(201);
    const killId = created.body.id;
    const killToken = (
      await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(201)
    ).body.tokens.accessToken;

    const wf = await newWorkflow();
    await request(app.getHttpServer())
      .post(`/workflows/${wf}/permissions`)
      .set(bearer(ownerToken))
      .send({ subjectType: 'USER', subjectId: killId, action: 'RUN' })
      .expect(201);
    // ACTIVE + granted → allowed.
    await run(killToken, wf).expect(201);

    // Disable the user → their run of the RESTRICTED workflow is no longer authorised.
    await prisma.user.update({ where: { id: killId }, data: { status: 'DISABLED' } });
    const denied = await run(killToken, wf);
    expect([401, 403]).toContain(denied.status);
  });

  it('rejects permission routes without a token (401)', async () => {
    const wf = await newWorkflow();
    await request(app.getHttpServer()).get(`/workflows/${wf}/permissions`).expect(401);
  });
});
