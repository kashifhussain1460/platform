import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * P0-03 — cross-tenant isolation.
 *
 * The single highest-value security suite in this codebase: for every route
 * that takes a resource id, a token from a DIFFERENT company must not reach it.
 *
 * Asserts **404, not 403**. A 403 confirms the resource exists, which is itself
 * a cross-tenant information leak (an attacker can enumerate ids and learn
 * which ones are real). "Not found" is the only safe answer to "may I see
 * someone else's row?".
 *
 * The table below is deliberately data-driven so that adding a resource without
 * adding a case here is a visible omission rather than a silent gap.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

interface Probe {
  /** Human label for the test name. */
  name: string;
  method: 'get' | 'patch' | 'delete' | 'post';
  /** `{id}` is substituted with company A's resource id. */
  path: string;
  body?: Record<string, unknown>;
  /**
   * Most routes must answer 404. A few legitimately answer 400 first because a
   * DTO/param check runs before the ownership lookup — still not a leak, since
   * the response is identical for a non-existent id.
   */
  expected?: number[];
}

describeIfDb('Cross-tenant isolation (P0-03)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = Date.now();
  let tokenA = '';
  let tokenB = '';
  let companyA = '';

  // Company A's resources — company B must not be able to touch any of them.
  const ids: Record<string, string> = {};

  const authA = () => ({ Authorization: `Bearer ${tokenA}` });
  const authB = () => ({ Authorization: `Bearer ${tokenB}` });

  const register = async (slug: string) => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Isolation ${slug} ${stamp}`,
        name: `Owner ${slug}`,
        email: `isolation_${slug}_${stamp}@example.com`,
        password: 'password123',
      })
      .expect(201);
    return {
      token: res.body.tokens.accessToken as string,
      companyId: res.body.company.id as string,
    };
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

    const a = await register('a');
    const b = await register('b');
    tokenA = a.token;
    companyA = a.companyId;
    tokenB = b.token;

    // ── Company A's resources, created through the real API where possible ──
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(authA())
      .send({
        name: 'A private workflow',
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOTIFY', config: { message: 'private' } },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(201);
    ids.workflow = wf.body.id;

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(authA())
      .send({ name: 'A private employee', role: 'SUPPORT' })
      .expect(201);
    ids.employee = emp.body.id;

    const skill = await request(app.getHttpServer())
      .post('/skills/install')
      .set(authA())
      .send({ skillKey: 'slack' })
      .expect(201);
    ids.installedSkill = skill.body.id;

    // Rows without a convenient create endpoint are seeded directly — the point
    // is the READ path's tenant scoping, not how the row got there.
    const run = await prisma.workflowRun.create({
      data: {
        companyId: companyA,
        workflowId: ids.workflow,
        status: 'COMPLETED',
        source: 'MANUAL',
      },
    });
    ids.run = run.id;

    const doc = await prisma.knowledgeDocument.create({
      data: {
        companyId: companyA,
        filename: 'a-private.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        storageKey: `isolation/${stamp}/a-private.txt`,
        status: 'READY',
      },
    });
    ids.document = doc.id;

    const approval = await prisma.approvalRequest.create({
      data: {
        companyId: companyA,
        kind: 'TOOL',
        skillKey: 'slack',
        tool: 'send_message',
        args: {},
        status: 'PENDING',
      },
    });
    ids.approval = approval.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const probes: Probe[] = [
    { name: 'GET    /workflows/:id', method: 'get', path: '/workflows/{workflow}' },
    { name: 'PATCH  /workflows/:id', method: 'patch', path: '/workflows/{workflow}', body: { name: 'hijacked' } },
    { name: 'DELETE /workflows/:id', method: 'delete', path: '/workflows/{workflow}' },
    { name: 'GET    /workflows/:id/runs', method: 'get', path: '/workflows/{workflow}/runs' },
    { name: 'POST   /workflows/:id/run', method: 'post', path: '/workflows/{workflow}/run', body: {} },
    { name: 'POST   /workflows/:id/activate', method: 'post', path: '/workflows/{workflow}/activate' },
    { name: 'GET    /workflows/runs/:runId', method: 'get', path: '/workflows/runs/{run}' },
    { name: 'GET    /employees/:id', method: 'get', path: '/employees/{employee}' },
    { name: 'PATCH  /employees/:id', method: 'patch', path: '/employees/{employee}', body: { name: 'hijacked' } },
    { name: 'DELETE /employees/:id', method: 'delete', path: '/employees/{employee}' },
    { name: 'GET    /skills/installed/:id', method: 'get', path: '/skills/installed/{installedSkill}' },
    { name: 'POST   /approvals/:id/approve', method: 'post', path: '/approvals/{approval}/approve', body: {} },
    { name: 'POST   /approvals/:id/reject', method: 'post', path: '/approvals/{approval}/reject', body: {} },
  ];

  describe("company B cannot reach company A's resources", () => {
    it.each(probes)('$name → 404', async (probe) => {
      const path = probe.path.replace(/\{(\w+)\}/g, (_, key: string) => {
        const id = ids[key];
        if (!id) throw new Error(`fixture id "${key}" was not created`);
        return id;
      });

      // Bound to a local first: `request(...)\n[probe.method]` would be parsed
      // as an index into the returned object, not a new statement.
      const agent = request(app.getHttpServer());
      const res = await agent[probe.method](path)
        .set(authB())
        .send(probe.body ?? {});

      const allowed = probe.expected ?? [404];
      // 403 would confirm the row exists — an enumeration leak. 200/201/204
      // would be an outright cross-tenant breach.
      expect({ path, status: res.status }).toEqual({
        path,
        status: allowed.includes(res.status) ? res.status : allowed[0],
      });
    });
  });

  it("company A's resources are untouched after every probe", async () => {
    const wf = await prisma.workflow.findUnique({ where: { id: ids.workflow } });
    expect(wf).not.toBeNull();
    expect(wf!.name).toBe('A private workflow');
    expect(wf!.status).not.toBe('ARCHIVED');

    const emp = await prisma.aiEmployee.findUnique({ where: { id: ids.employee } });
    expect(emp).not.toBeNull();
    expect(emp!.name).toBe('A private employee');

    const approval = await prisma.approvalRequest.findUnique({
      where: { id: ids.approval },
    });
    expect(approval!.status).toBe('PENDING');
  });

  it('list endpoints never return another company rows', async () => {
    const workflows = await request(app.getHttpServer())
      .get('/workflows')
      .set(authB())
      .expect(200);
    expect(
      (workflows.body as Array<{ id: string }>).some((w) => w.id === ids.workflow),
    ).toBe(false);

    const employees = await request(app.getHttpServer())
      .get('/employees')
      .set(authB())
      .expect(200);
    expect(
      (employees.body as Array<{ id: string }>).some((e) => e.id === ids.employee),
    ).toBe(false);

    const docs = await request(app.getHttpServer())
      .get('/knowledge/documents')
      .set(authB())
      .expect(200);
    expect(
      (docs.body as Array<{ id: string }>).some((d) => d.id === ids.document),
    ).toBe(false);
  });
});
