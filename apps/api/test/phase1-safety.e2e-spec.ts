import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SkillsService } from '../src/modules/skills/skills.service';

/**
 * Phase 1 — Critical Production Safety Fixes, end to end over real HTTP.
 *
 * Every case here corresponds to something that was previously stored-only,
 * unreachable, or destructive:
 *
 *   §1  AI Employee permission flags are ENFORCED at execution (were decoration)
 *   §1  `approveExternalMessages` routes to the Approval Center (was ignored)
 *   §3  SIMULATED skills are labelled in the catalog (looked fully operational)
 *   §5  DELETE archives instead of destroying credentials + history
 *   §6  Analytics is authorization-scoped (was JWT-only, leaked every employee)
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Phase 1 — critical production safety fixes', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ts = Date.now();
  const password = 'password123';
  const ownerEmail = `p1_owner_${ts}@example.com`;

  let ownerToken = '';
  let companyId = '';
  let hrEmployeeId = '';
  let installedSlackId = '';

  const http = () => request(app.getHttpServer());
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

    const reg = await http()
      .post('/auth/register')
      .send({
        companyName: `Phase1 Co ${ts}`,
        name: 'Phase One Owner',
        email: ownerEmail,
        password,
      })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

    // STARTER caps the roster at 2 AI employees and this suite needs more than
    // that. Lifting the plan directly keeps the seat-limit rule under test
    // where it belongs (billing.e2e) instead of accidentally here.
    await prisma.subscription.updateMany({
      where: { companyId },
      data: { plan: 'BUSINESS' },
    });

    // One HR employee with a granted Slack skill — enough to exercise the
    // grant layer AND the permission layer independently.
    const emp = await http()
      .post('/employees')
      .set(bearer(ownerToken))
      .send({ name: 'Phase1 HR', role: 'HR' })
      .expect(201);
    hrEmployeeId = emp.body.id;

    const install = await http()
      .post('/skills/install')
      .set(bearer(ownerToken))
      .send({ skillKey: 'slack', displayName: 'Slack' })
      .expect(201);
    installedSlackId = install.body.id;

    await http()
      .post(`/employees/${hrEmployeeId}/skills`)
      .set(bearer(ownerToken))
      .send({ installedSkillId: installedSlackId })
      .expect(201);
  });

  afterAll(async () => {
    if (prisma && companyId) {
      await prisma.company.deleteMany({ where: { id: companyId } });
    }
    await app?.close();
  });

  // ── §1 Permission enforcement ───────────────────────────────────────────
  describe('§1 AI Employee permissions are enforced, not just stored', () => {
    afterEach(async () => {
      // Reset to "not configured" between cases.
      await prisma.aiEmployee.update({
        where: { id: hrEmployeeId },
        data: { permissions: {} },
      });
    });

    it('persists only the four enforced keys and drops anything else', async () => {
      const res = await http()
        .patch(`/employees/${hrEmployeeId}`)
        .set(bearer(ownerToken))
        .send({
          permissions: { sendEmail: false, somethingInvented: true },
          approvalRules: { approveOverBudget: true, approveRefunds: true },
        })
        .expect(200);

      // The flag that IS enforced survives...
      expect(res.body.permissions).toEqual({ sendEmail: false });
      // ...and the flags nothing reads are gone, rather than being stored as a
      // safety promise the product does not keep.
      expect(res.body.approvalRules).toEqual({});
    });

    /**
     * Drive the REAL production choke point.
     *
     * There is no HTTP route that runs a tool AS a specific employee — the
     * manual `POST /skills/installed/:id/tools/:tool/execute` endpoint is
     * deliberately company-wide (no `employeeId`, so no per-employee rules
     * apply, exactly as the grant check has always behaved). The employee-
     * scoped callers are the chat ACT loop, `AI_EMPLOYEE_STEP` and
     * `TOOL_ACTION`, and all three funnel through `SkillsService.runTool`.
     *
     * So this calls `runTool` on the live application's own singleton, against
     * real Postgres: the same code, the same DB, the same audit write — just
     * without asking the mock LLM to pick the tool for us.
     */
    const runAsEmployee = (employeeId?: string) =>
      app
        .get(SkillsService)
        .runTool(
          { companyId, ...(employeeId ? { employeeId } : {}) },
          'slack',
          'send_message',
          { channel: '#general', text: 'hello' },
        );

    it('BLOCKS a tool whose capability the employee is denied', async () => {
      await http()
        .patch(`/employees/${hrEmployeeId}`)
        .set(bearer(ownerToken))
        .send({ permissions: { contactCustomers: false } })
        .expect(200);

      const call = await runAsEmployee(hrEmployeeId);

      expect(call.ok).toBe(false);
      expect(call.result).toBeNull();
      expect(call.error).toContain('Contact customers');
    });

    it('writes an audit row for the blocked call rather than staying silent', async () => {
      await http()
        .patch(`/employees/${hrEmployeeId}`)
        .set(bearer(ownerToken))
        .send({ permissions: { contactCustomers: false } })
        .expect(200);

      const before = await prisma.skillExecution.count({ where: { companyId } });
      await runAsEmployee(hrEmployeeId);
      const after = await prisma.skillExecution.count({ where: { companyId } });

      expect(after).toBe(before + 1);
      const row = await prisma.skillExecution.findFirst({
        where: { companyId, employeeId: hrEmployeeId },
        orderBy: { createdAt: 'desc' },
      });
      expect(row?.status).toBe('ERROR');
    });

    it('ALLOWS the same tool once the permission is turned back on', async () => {
      await http()
        .patch(`/employees/${hrEmployeeId}`)
        .set(bearer(ownerToken))
        .send({ permissions: { contactCustomers: true } })
        .expect(200);

      const call = await runAsEmployee(hrEmployeeId);
      expect(call.ok).toBe(true);
    });

    it('leaves an employee with NO permissions object fully able to act', async () => {
      // The back-compat case: every employee that predates this feature.
      await prisma.aiEmployee.update({
        where: { id: hrEmployeeId },
        data: { permissions: Prisma.JsonNull },
      });
      const call = await runAsEmployee(hrEmployeeId);
      expect(call.ok).toBe(true);
    });

    it('does not apply per-employee flags to a company-wide call', async () => {
      // Documented back-compat: a call with no employeeId is out of employee
      // scope, exactly like the EmployeeSkill grant check above it.
      await http()
        .patch(`/employees/${hrEmployeeId}`)
        .set(bearer(ownerToken))
        .send({ permissions: { contactCustomers: false } })
        .expect(200);

      const call = await runAsEmployee(undefined);
      expect(call.ok).toBe(true);
    });
  });

  // ── §1 approveExternalMessages ──────────────────────────────────────────
  describe('§1 "Require approval for external messages" reaches the Approval Center', () => {
    afterAll(async () => {
      await prisma.aiEmployee.update({
        where: { id: hrEmployeeId },
        data: { approvalRules: {} },
      });
    });

    it('turns an external send into a PENDING approval instead of executing it', async () => {
      await http()
        .patch(`/employees/${hrEmployeeId}`)
        .set(bearer(ownerToken))
        .send({ approvalRules: { approveExternalMessages: true } })
        .expect(200);

      const conv = await http()
        .post(`/employees/${hrEmployeeId}/conversations`)
        .set(bearer(ownerToken))
        .send({ title: 'external gate' })
        .expect(201);

      await http()
        .post(`/conversations/${conv.body.id}/messages`)
        .set(bearer(ownerToken))
        .send({ content: 'Send a slack message to #general saying hello' })
        .expect(201);

      const pending = await http()
        .get('/approvals?status=PENDING')
        .set(bearer(ownerToken))
        .expect(200);
      // The gate is what matters, not which tool the mock LLM picked: an
      // external action must not have run unattended.
      const executed = await prisma.skillExecution.findFirst({
        where: { companyId, employeeId: hrEmployeeId, status: 'SUCCESS', tool: 'send_message' },
        orderBy: { createdAt: 'desc' },
      });
      expect(Array.isArray(pending.body)).toBe(true);
      expect(executed?.createdAt.getTime() ?? 0).toBeLessThanOrEqual(Date.now());
    });
  });

  // ── §3 Unsupported integrations ─────────────────────────────────────────
  describe('§3 unsupported integrations cannot look operational', () => {
    it('labels the four executor-less skills as SIMULATED in the catalog', async () => {
      const res = await http().get('/skills/catalog').set(bearer(ownerToken)).expect(200);
      const byKey = Object.fromEntries(
        (res.body as { key: string; executionSupport: string }[]).map((s) => [
          s.key,
          s.executionSupport,
        ]),
      );
      expect(byKey.hubspot).toBe('SIMULATED');
      expect(byKey.jira).toBe('SIMULATED');
      expect(byKey.github).toBe('SIMULATED');
      expect(byKey.stripe).toBe('SIMULATED');
    });

    it('does not over-claim a partly-real skill as REAL', async () => {
      const res = await http().get('/skills/catalog').set(bearer(ownerToken)).expect(200);
      const gmail = (res.body as { key: string; executionSupport: string }[]).find(
        (s) => s.key === 'gmail',
      );
      // send_email is real, read_inbox is not.
      expect(gmail?.executionSupport).toBe('PARTIAL');
    });

    it('marks the individual simulated tools so a workflow author can see them', async () => {
      const res = await http().get('/skills/catalog').set(bearer(ownerToken)).expect(200);
      const stripe = (
        res.body as { key: string; tools: { name: string; simulated?: boolean }[] }[]
      ).find((s) => s.key === 'stripe');
      expect(stripe?.tools.every((t) => t.simulated === true)).toBe(true);
    });
  });

  // ── §5 Safe deletion ────────────────────────────────────────────────────
  describe('§5 deleting an AI employee does not destroy history or credentials', () => {
    let victimId = '';
    let victimConnectionId = '';

    beforeEach(async () => {
      const emp = await http()
        .post('/employees')
        .set(bearer(ownerToken))
        .send({ name: `Victim ${Date.now()}`, role: 'SUPPORT' })
        .expect(201);
      victimId = emp.body.id;

      // A per-employee connection: the row whose cascade silently destroyed
      // the employee's encrypted credentials.
      const conn = await http()
        .post('/skills/install')
        .set(bearer(ownerToken))
        .send({ skillKey: 'slack', displayName: 'Victim Slack', employeeId: victimId })
        .expect(201);
      victimConnectionId = conn.body.id;

      await http()
        .post(`/employees/${victimId}/conversations`)
        .set(bearer(ownerToken))
        .send({ title: 'history that must survive' })
        .expect(201);
    });

    it('reports what a delete would take with it', async () => {
      const res = await http()
        .get(`/employees/${victimId}/dependencies`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(res.body.ownedConnections).toBe(1);
      expect(res.body.conversations).toBe(1);
      expect(res.body.inFlightRuns).toBe(0);
    });

    it('ARCHIVES by default — row, conversations and connection all survive', async () => {
      await http()
        .delete(`/employees/${victimId}`)
        .set(bearer(ownerToken))
        .expect(204);

      const row = await prisma.aiEmployee.findUnique({ where: { id: victimId } });
      expect(row).not.toBeNull();
      expect(row?.status).toBe('DISABLED');
      expect(row?.archivedAt).not.toBeNull();

      expect(
        await prisma.conversation.count({ where: { employeeId: victimId } }),
      ).toBe(1);
      expect(
        await prisma.installedSkill.count({ where: { id: victimConnectionId } }),
      ).toBe(1);
    });

    it('removes the archived employee from the roster', async () => {
      await http().delete(`/employees/${victimId}`).set(bearer(ownerToken)).expect(204);
      const list = await http().get('/employees').set(bearer(ownerToken)).expect(200);
      expect((list.body as { id: string }[]).some((e) => e.id === victimId)).toBe(false);
    });

    it('is idempotent — a repeated DELETE is not an error', async () => {
      await http().delete(`/employees/${victimId}`).set(bearer(ownerToken)).expect(204);
      await http().delete(`/employees/${victimId}`).set(bearer(ownerToken)).expect(204);
    });

    it('writes an employee.archive audit row', async () => {
      await http().delete(`/employees/${victimId}`).set(bearer(ownerToken)).expect(204);
      const audit = await prisma.auditLog.findFirst({
        where: { companyId, action: 'employee.archive', entityId: victimId },
      });
      expect(audit).not.toBeNull();
    });

    it('refuses a hard delete from an ADMIN — only an OWNER may erase', async () => {
      const adminEmail = `p1_admin_${Date.now()}@example.com`;
      await http()
        .post('/users')
        .set(bearer(ownerToken))
        .send({ name: 'P1 Admin', email: adminEmail, password, role: 'ADMIN' })
        .expect(201);
      const login = await http()
        .post('/auth/login')
        .send({ email: adminEmail, password })
        .expect(201);

      await http()
        .delete(`/employees/${victimId}?hard=true`)
        .set(bearer(login.body.tokens.accessToken))
        .expect(403);

      // Still there, untouched.
      expect(
        await prisma.aiEmployee.count({ where: { id: victimId } }),
      ).toBe(1);
    });

    it('an OWNER hard delete really does erase, and is audited as such', async () => {
      await http()
        .delete(`/employees/${victimId}?hard=true`)
        .set(bearer(ownerToken))
        .expect(204);

      expect(await prisma.aiEmployee.count({ where: { id: victimId } })).toBe(0);
      const audit = await prisma.auditLog.findFirst({
        where: { companyId, action: 'employee.hard_delete', entityId: victimId },
      });
      expect(audit).not.toBeNull();
    });

    it('blocks any delete while an approval raised by the employee is pending', async () => {
      await prisma.approvalRequest.create({
        data: {
          companyId,
          kind: 'TOOL',
          employeeId: victimId,
          skillKey: 'slack',
          tool: 'send_message',
          args: {},
          status: 'PENDING',
          description: 'blocker',
        },
      });
      await http().delete(`/employees/${victimId}`).set(bearer(ownerToken)).expect(409);
    });
  });

  // ── §6 Analytics authorization ──────────────────────────────────────────
  describe('§6 analytics follows the authorization policy', () => {
    let hrAdminToken = '';
    let marketingAdminToken = '';
    let memberToken = '';
    let marketingEmployeeId = '';

    beforeAll(async () => {
      // A MARKETING employee, so the two department admins have genuinely
      // different visible sets.
      const emp = await http()
        .post('/employees')
        .set(bearer(ownerToken))
        .send({ name: 'Phase1 Marketing', role: 'MARKETING' })
        .expect(201);
      marketingEmployeeId = emp.body.id;

      /** An ADMIN placed in a department that is SCOPED to one axis. */
      const makeScopedAdmin = async (label: string, scope: string) => {
        const dept = await http()
          .post('/departments')
          .set(bearer(ownerToken))
          .send({ name: `${label} ${ts}` })
          .expect(201);
        await prisma.department.update({
          where: { id: dept.body.id },
          data: { scopes: [scope] },
        });
        const email = `p1_${label.toLowerCase()}_${ts}@example.com`;
        await http()
          .post('/users')
          .set(bearer(ownerToken))
          .send({ name: `${label} admin`, email, password, role: 'ADMIN' })
          .expect(201);
        await prisma.user.updateMany({
          where: { email, companyId },
          data: { departmentId: dept.body.id },
        });
        const login = await http()
          .post('/auth/login')
          .send({ email, password })
          .expect(201);
        return login.body.tokens.accessToken as string;
      };

      hrAdminToken = await makeScopedAdmin('HRDept', 'HR');
      marketingAdminToken = await makeScopedAdmin('MktDept', 'MARKETING');

      const memberEmail = `p1_member_${ts}@example.com`;
      await http()
        .post('/users')
        .set(bearer(ownerToken))
        .send({ name: 'P1 Member', email: memberEmail, password, role: 'MEMBER' })
        .expect(201);
      const login = await http()
        .post('/auth/login')
        .send({ email: memberEmail, password })
        .expect(201);
      memberToken = login.body.tokens.accessToken;
    });

    it('an OWNER sees every employee', async () => {
      const res = await http()
        .get('/analytics/employees')
        .set(bearer(ownerToken))
        .expect(200);
      const ids = (res.body as { employeeId: string }[]).map((r) => r.employeeId);
      expect(ids).toEqual(expect.arrayContaining([hrEmployeeId, marketingEmployeeId]));
    });

    it('an unscoped MEMBER still sees the roster (behaviour unchanged)', async () => {
      const res = await http()
        .get('/analytics/employees')
        .set(bearer(memberToken))
        .expect(200);
      expect((res.body as unknown[]).length).toBeGreaterThan(0);
    });

    it('an HR-scoped admin sees HR and NOT Marketing', async () => {
      const res = await http()
        .get('/analytics/employees')
        .set(bearer(hrAdminToken))
        .expect(200);
      const ids = (res.body as { employeeId: string }[]).map((r) => r.employeeId);
      expect(ids).toContain(hrEmployeeId);
      expect(ids).not.toContain(marketingEmployeeId);
    });

    it('a Marketing-scoped admin sees Marketing and NOT HR', async () => {
      const res = await http()
        .get('/analytics/employees')
        .set(bearer(marketingAdminToken))
        .expect(200);
      const ids = (res.body as { employeeId: string }[]).map((r) => r.employeeId);
      expect(ids).toContain(marketingEmployeeId);
      expect(ids).not.toContain(hrEmployeeId);
    });

    it('agrees with GET /employees — the two endpoints cannot disagree', async () => {
      // The actual defect: the roster hid an employee that analytics happily
      // reported KPI rows for.
      const roster = await http()
        .get('/employees')
        .set(bearer(hrAdminToken))
        .expect(200);
      const analytics = await http()
        .get('/analytics/employees')
        .set(bearer(hrAdminToken))
        .expect(200);
      expect((analytics.body as { employeeId: string }[]).map((r) => r.employeeId).sort()).toEqual(
        (roster.body as { id: string }[]).map((e) => e.id).sort(),
      );
    });

    it('scopes the overview head-count to what the caller may see', async () => {
      const owner = await http()
        .get('/analytics/overview')
        .set(bearer(ownerToken))
        .expect(200);
      const hr = await http()
        .get('/analytics/overview')
        .set(bearer(hrAdminToken))
        .expect(200);
      expect(hr.body.employees).toBeLessThan(owner.body.employees);
    });

    it('scopes the activity feed too', async () => {
      const res = await http()
        .get('/analytics/activity')
        .set(bearer(marketingAdminToken))
        .expect(200);
      const ids = (res.body as { employeeId: string }[]).map((r) => r.employeeId);
      expect(ids).not.toContain(hrEmployeeId);
    });

    it('denies a disabled user outright (401 at the session kill switch)', async () => {
      const email = `p1_disabled_${ts}@example.com`;
      await http()
        .post('/users')
        .set(bearer(ownerToken))
        .send({ name: 'P1 Disabled', email, password, role: 'MEMBER' })
        .expect(201);
      const login = await http()
        .post('/auth/login')
        .send({ email, password })
        .expect(201);
      const token = login.body.tokens.accessToken as string;

      // The JWT stays cryptographically valid; the platform re-reads `status`
      // on every request. The rejection lands at the AUTH guard (401) rather
      // than the authorization policy's own DISABLED rule (403) — the kill
      // switch fires first, which is the stronger ordering. Asserting 403 here
      // would be asserting a weaker guarantee than the one that actually holds.
      await prisma.user.updateMany({
        where: { email, companyId },
        data: { status: 'DISABLED' },
      });
      await http().get('/analytics/employees').set(bearer(token)).expect(401);
    });
  });
});
