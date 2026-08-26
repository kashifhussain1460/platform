import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Workflow templates e2e (Wave P3-02): needs a live Postgres + Redis. Skipped
// when DATABASE_URL is unset. Run with the same env as the other suites.
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Workflow templates e2e — install / prereqs / idempotency (P3-02)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerToken = '';
  let memberToken = '';
  let otherToken = ''; // a second company with NO prerequisites
  let companyId = '';
  let hrEmployeeId = '';
  let otherEmployeeId = ''; // a valid employee in company B (so binds passes there)
  let hrTemplateId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const ownerEmail = `wt_owner_${ts}@example.com`;
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'WT Co', name: 'WT Owner', email: ownerEmail, password })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;

    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'WT Other', name: 'Other', email: `wt_other_${ts}@example.com`, password })
      .expect(201);
    otherToken = other.body.tokens.accessToken;

    const memberEmail = `wt_member_${ts}@example.com`;
    await request(app.getHttpServer())
      .post('/users')
      .set(bearer(ownerToken))
      .send({ email: memberEmail, name: 'WT Member', role: 'MEMBER', password })
      .expect(201);
    memberToken = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: memberEmail, password })
        .expect(201)
    ).body.tokens.accessToken;

    const user = await prisma.user.findFirstOrThrow({
      where: { email: ownerEmail },
      select: { companyId: true },
    });
    companyId = user.companyId;

    // Seed the install prerequisites for company A: BUSINESS plan + slack skill +
    // an HR AI Employee. (Register already created a default STARTER subscription.)
    await prisma.subscription.update({ where: { companyId }, data: { plan: 'BUSINESS' } });
    await prisma.installedSkill.create({
      data: { companyId, skillKey: 'slack', displayName: 'Slack' },
    });
    const emp = await prisma.aiEmployee.create({
      data: { companyId, name: 'HR Bot', role: 'HR' },
    });
    hrEmployeeId = emp.id;

    // Company B gets an employee (any role) so a binds:employee param resolves
    // there — its install still fails later on the missing skill/plan prereqs.
    const otherCompany = await prisma.user.findFirstOrThrow({
      where: { email: `wt_other_${ts}@example.com` },
      select: { companyId: true },
    });
    const otherEmp = await prisma.aiEmployee.create({
      data: { companyId: otherCompany.companyId, name: 'B Bot', role: 'SALES' },
    });
    otherEmployeeId = otherEmp.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists the full first-party catalog (11 HR + 11 Marketing, seeded on boot)', async () => {
    const res = await request(app.getHttpServer())
      .get('/workflow-templates')
      .set(bearer(ownerToken))
      .expect(200);
    const keys: string[] = res.body.map((t: { key: string }) => t.key);
    // Spot-check across both domains.
    expect(keys).toEqual(
      expect.arrayContaining([
        'hr.recruitment-intake',
        'hr.candidate-screening',
        'hr.leave-request',
        'hr.offboarding',
        'mkt.content-approval',
        'mkt.social-publish',
        'mkt.brand-audit',
      ]),
    );
    const firstParty = res.body.filter((t: { companyId: string | null }) => t.companyId === null);
    expect(firstParty.length).toBeGreaterThanOrEqual(22);

    const hr = res.body.find((t: { key: string }) => t.key === 'hr.leave-request');
    expect(hr).toBeTruthy();
    expect(hr.status).toBe('PUBLISHED');
    expect(hr.companyId).toBeNull();
    hrTemplateId = hr.id;
  });

  it('Gap fix: GET ?category=MARKETING returns only Marketing templates, none from HR', async () => {
    const res = await request(app.getHttpServer())
      .get('/workflow-templates')
      .query({ category: 'MARKETING' })
      .set(bearer(ownerToken))
      .expect(200);
    const categories: string[] = res.body.map((t: { category: string }) => t.category);
    expect(categories.length).toBeGreaterThanOrEqual(11);
    expect(new Set(categories)).toEqual(new Set(['MARKETING']));
  });

  it('Gap fix: an invalid/unknown category value is ignored (falls back to unfiltered), not a 400 or empty list', async () => {
    const res = await request(app.getHttpServer())
      .get('/workflow-templates')
      .query({ category: 'not-a-real-category' })
      .set(bearer(ownerToken))
      .expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(22);
  });

  it('GET /:id/parameters returns the declared parameters', async () => {
    const res = await request(app.getHttpServer())
      .get(`/workflow-templates/${hrTemplateId}/parameters`)
      .set(bearer(ownerToken))
      .expect(200);
    const keys = res.body.parameters.map((p: { key: string }) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['hrEmployee', 'notifyChannel']));
    expect(res.body.requires.skills).toContain('slack');
  });

  it('install with all params ⇒ DRAFT workflow + v1 PUBLISHED version + provenance (deep copy)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .set(bearer(ownerToken))
      .send({ parameters: { hrEmployee: hrEmployeeId, notifyChannel: '#leave' } })
      .expect(201);
    const wf = res.body;
    expect(wf.status).toBe('DRAFT');

    // v1 PUBLISHED version exists and is the active version.
    const versions = await prisma.workflowVersion.findMany({ where: { workflowId: wf.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].status).toBe('PUBLISHED');

    const row = await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id } });
    expect(row.activeVersionId).toBe(versions[0].id);
    expect(row.sourceTemplateId).toBe(hrTemplateId);
    expect(row.sourceTemplateVersion).toBe(1);
    // Deep copy: placeholders were resolved to concrete values (no live link).
    const defJson = JSON.stringify(row.definition);
    expect(defJson).toContain(hrEmployeeId);
    expect(defJson).toContain('#leave');
    expect(defJson).not.toContain('{{param.');
  });

  it('missing prerequisites ⇒ 422 naming them; nothing persisted', async () => {
    const before = await prisma.workflow.count({
      where: { sourceTemplateId: hrTemplateId },
    });
    const res = await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .set(bearer(otherToken)) // company B: no slack, no HR employee, STARTER plan
      .send({ parameters: { hrEmployee: otherEmployeeId, notifyChannel: '#x' } })
      .expect(422);
    expect(res.body.message).toMatch(/slack|HR|BUSINESS/);
    // Company B created nothing.
    const after = await prisma.workflow.count({
      where: { sourceTemplateId: hrTemplateId },
    });
    expect(after).toBe(before);
  });

  it('missing required parameter ⇒ 422', async () => {
    await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .set(bearer(ownerToken))
      .send({ parameters: { notifyChannel: '#leave' } }) // hrEmployee missing
      .expect(422);
  });

  it('duplicate Idempotency-Key ⇒ exactly one workflow', async () => {
    const key = `idem-${ts}`;
    const first = await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .set({ ...bearer(ownerToken), 'Idempotency-Key': key })
      .send({ parameters: { hrEmployee: hrEmployeeId, notifyChannel: '#leave' } })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .set({ ...bearer(ownerToken), 'Idempotency-Key': key })
      .send({ parameters: { hrEmployee: hrEmployeeId, notifyChannel: '#leave' } })
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
    const count = await prisma.workflow.count({
      where: { companyId, installIdempotencyKey: key },
    });
    expect(count).toBe(1);
  });

  it('authoring a third-party template with a DB_QUERY node ⇒ rejected (400)', async () => {
    await request(app.getHttpServer())
      .post('/workflow-templates')
      .set(bearer(ownerToken))
      .send({
        key: `tenant.bad-${ts}`,
        name: 'Bad template',
        category: 'CUSTOM',
        definition: {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', name: 'Start', config: {} },
            { id: 'q', type: 'DB_QUERY', name: 'Query', config: {} },
          ],
          edges: [{ from: 'trigger', to: 'q' }],
        },
      })
      .expect(400);
  });

  it('a binds:employee param must reference a real AI Employee (422)', async () => {
    await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .set(bearer(ownerToken))
      .send({ parameters: { hrEmployee: 'does-not-exist', notifyChannel: '#leave' } })
      .expect(422);
  });

  it('template keys are unique per OWNER, not globally (no cross-tenant coupling)', async () => {
    const body = {
      key: `shared.tpl-${ts}`,
      name: 'Shared key',
      category: 'CUSTOM',
      definition: {
        nodes: [
          { id: 'trigger', type: 'TRIGGER', name: 'Start', config: {} },
          { id: 'noop', type: 'NOOP', name: 'Noop', config: {} },
        ],
        edges: [{ from: 'trigger', to: 'noop' }],
      },
    };
    // Company A authors the key.
    await request(app.getHttpServer())
      .post('/workflow-templates')
      .set(bearer(ownerToken))
      .send(body)
      .expect(201);
    // Company B authors the SAME key — must NOT collide with A's.
    await request(app.getHttpServer())
      .post('/workflow-templates')
      .set(bearer(otherToken))
      .send(body)
      .expect(201);
    // Company A re-authoring its own key+version → 409 (per-owner uniqueness).
    await request(app.getHttpServer())
      .post('/workflow-templates')
      .set(bearer(ownerToken))
      .send(body)
      .expect(409);
  });

  it('RBAC: a MEMBER cannot install (403)', async () => {
    await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .set(bearer(memberToken))
      .send({ parameters: { hrEmployee: hrEmployeeId, notifyChannel: '#leave' } })
      .expect(403);
  });

  it('rejects install without a token (401)', async () => {
    await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .send({})
      .expect(401);
  });
});
