import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Analytics/KPI dashboard e2e: needs a live Postgres + Redis. Skipped when
// DATABASE_URL is unset so it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Analytics e2e (read-only KPI aggregation over existing data)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `analytics_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let companyId = '';
  let installedSkillId = '';
  let employeeId = '';
  let conversationId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  /**
   * Send a message that drives the slack tool.
   *
   * `slack:send_message` is an EXTERNAL_ACTION_TOOL, so the autonomous chat loop
   * deliberately does NOT execute it — it opens an ApprovalRequest instead
   * (`tool-approval-policy.ts`: untrusted content, e.g. a pasted email, must not
   * be able to drive an unapproved external send). This helper therefore
   * approves the gate, which is what actually runs the tool and writes the
   * `SkillExecution` rows these KPI assertions measure.
   *
   * The test used to assume the tool ran unattended. That assumption became
   * wrong when the external-action gate shipped, and the suite has been red ever
   * since — asserting behaviour the platform intentionally removed.
   */
  const sendMessage = async (text: string) => {
    const res = await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth())
      .send({ content: text })
      .expect(201);
    await approveAllPending();
    return res.body;
  };

  /** Approve every PENDING request, executing the gated tool for real. */
  const approveAllPending = async () => {
    const pending = await request(app.getHttpServer())
      .get('/approvals?status=PENDING')
      .set(auth())
      .expect(200);
    for (const req of pending.body as { id: string; status: string }[]) {
      if (req.status !== 'PENDING') continue;
      await request(app.getHttpServer())
        .post(`/approvals/${req.id}/approve`)
        .set(auth())
        .send({});
    }
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

    // register → login (use the login token, per spec).
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Analytics E2E Co',
        name: 'Ana Lytics',
        email,
        password,
      })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    accessToken = login.body.tokens.accessToken;
    companyId = login.body.company.id;

    // install slack → create employee → assign the skill.
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'slack' })
      .expect(201);
    installedSkillId = installed.body.id;

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Metric Mike', role: 'SUPPORT', persona: 'Ops assistant.' })
      .expect(201);
    employeeId = emp.body.id;

    await request(app.getHttpServer())
      .post(`/employees/${employeeId}/skills`)
      .set(auth())
      .send({ installedSkillId })
      .expect(201);

    const conv = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/conversations`)
      .set(auth())
      .send({ title: 'Analytics' })
      .expect(201);
    conversationId = conv.body.id;

    // Two messages that drive the slack tool → SkillExecution rows + assistant
    // messages. No approvalRules, so the tool executes (not held for approval).
    await sendMessage('Send a slack message to #general about our refund policy');
    await sendMessage('Send a slack message to #general with a status update');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /analytics/overview returns company KPIs with derived estimates', async () => {
    // Sanity: the setup actually produced at least one skill execution.
    const execCount = await prisma.skillExecution.count({
      where: { companyId, skillKey: 'slack' },
    });
    expect(execCount).toBeGreaterThanOrEqual(1);

    const res = await request(app.getHttpServer())
      .get('/analytics/overview?range=all')
      .set(auth())
      .expect(200);
    const o = res.body;

    expect(o.range).toBe('all');
    expect(o.toolActions).toBeGreaterThanOrEqual(1);
    expect(o.toolSuccess + o.toolErrors).toBe(o.toolActions);
    expect(o.tasksCompleted).toBeGreaterThanOrEqual(1);
    expect(o.hoursSaved).toBeGreaterThan(0);
    expect(o.costSavings).toBeGreaterThan(0);
    expect(o.employees).toBeGreaterThanOrEqual(1);
    expect(o.activeEmployees).toBeGreaterThanOrEqual(1);
    // successRate is a number or null (never NaN/undefined).
    expect(o.successRate === null || typeof o.successRate === 'number').toBe(true);
    expect(typeof o.utilization).toBe('number');
  });

  it('GET /analytics/employees returns a row for the employee with its counts', async () => {
    const res = await request(app.getHttpServer())
      .get('/analytics/employees?range=all')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);

    const row = res.body.find(
      (r: { employeeId: string }) => r.employeeId === employeeId,
    );
    expect(row).toBeTruthy();
    expect(row.name).toBe('Metric Mike');
    expect(row.role).toBe('SUPPORT');
    expect(row.toolActions).toBeGreaterThanOrEqual(1);
    expect(row.assistantMessages).toBeGreaterThanOrEqual(1);
    expect(row.tasksCompleted).toBe(row.toolSuccess + row.assistantMessages);
    expect(row.hoursSaved).toBeGreaterThan(0);
  });

  it('GET /analytics/activity returns a per-employee feed', async () => {
    const res = await request(app.getHttpServer())
      .get('/analytics/activity?range=all')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);

    const entry = res.body.find(
      (e: { employeeId: string }) => e.employeeId === employeeId,
    );
    expect(entry).toBeTruthy();
    expect(entry.employee).toBe('Metric Mike');
    expect(Array.isArray(entry.items)).toBe(true);
    expect(entry.items.length).toBeGreaterThanOrEqual(1);
    // Each item is a {label, count} with a positive count.
    for (const item of entry.items) {
      expect(typeof item.label).toBe('string');
      expect(item.count).toBeGreaterThan(0);
    }
    // The slack tool action should surface as a grouped label.
    expect(
      entry.items.some((i: { label: string }) => i.label.startsWith('slack')),
    ).toBe(true);
  });

  it('defaults range to 7d and rejects analytics routes without a token', async () => {
    const res = await request(app.getHttpServer())
      .get('/analytics/overview')
      .set(auth())
      .expect(200);
    expect(res.body.range).toBe('7d');

    await request(app.getHttpServer()).get('/analytics/overview').expect(401);
  });
});
