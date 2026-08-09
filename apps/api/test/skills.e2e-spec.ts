import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  SKILL_EXECUTOR_TOKEN,
  type ExecutorContext,
  type SkillExecutionResult,
  type SkillExecutor,
} from '../src/modules/skills/executors/skill-executor';

// Skills + tool-execution e2e: needs a live Postgres + Redis. Skipped when
// DATABASE_URL is unset so it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Skills e2e (catalog -> install -> assign -> tool-calling run)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `skill_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let companyId = '';
  let installedSkillId = '';
  let employeeId = '';
  let conversationId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Skill E2E Co', name: 'Skill Owner', email, password })
      .expect(201);
    accessToken = res.body.tokens.accessToken;
    companyId = res.body.company.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('exposes the built-in catalog with tools', async () => {
    const res = await request(app.getHttpServer())
      .get('/skills/catalog')
      .set(auth())
      .expect(200);

    const keys = res.body.map((s: { key: string }) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining(['slack', 'email', 'stripe', 'github', 'http']),
    );
    const slack = res.body.find((s: { key: string }) => s.key === 'slack');
    expect(slack.tools[0].name).toBe('send_message');
    expect(slack.tools[0].parameters.required).toEqual(
      expect.arrayContaining(['channel', 'text']),
    );
  });

  it('installs the slack skill (tenant-scoped)', async () => {
    const res = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'slack' })
      .expect(201);
    expect(res.body.skillKey).toBe('slack');
    expect(res.body.enabled).toBe(true);
    installedSkillId = res.body.id;

    const list = await request(app.getHttpServer())
      .get('/skills/installed')
      .set(auth())
      .expect(200);
    expect(list.body.some((s: { id: string }) => s.id === installedSkillId)).toBe(
      true,
    );
  });

  it('rejects installing an unknown skill (404) and a duplicate (409)', async () => {
    await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'nope' })
      .expect(404);

    await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'slack' })
      .expect(409);
  });

  it('manually executes a tool (mock/sandbox, logged)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/skills/installed/${installedSkillId}/tools/send_message/execute`)
      .set(auth())
      .send({ args: { channel: '#test', text: 'hello' } })
      .expect(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.skillKey).toBe('slack');
    expect(res.body.tool).toBe('send_message');
    expect(String(res.body.result.id)).toMatch(/^mock_send_message_/);
  });

  it('creates an employee and assigns the installed skill', async () => {
    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Sky', role: 'SUPPORT', persona: 'Ops assistant.' })
      .expect(201);
    employeeId = emp.body.id;

    const assign = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/skills`)
      .set(auth())
      .send({ installedSkillId })
      .expect(201);
    expect(assign.body.employeeId).toBe(employeeId);
    expect(assign.body.installedSkillId).toBe(installedSkillId);

    const list = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/skills`)
      .set(auth())
      .expect(200);
    expect(list.body.length).toBe(1);
  });

  it('routes an external-action tool call from chat to approval, not autonomous execution', async () => {
    const conv = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/conversations`)
      .set(auth())
      .send({ title: 'Slack it' })
      .expect(201);
    conversationId = conv.body.id;

    const res = await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth())
      .send({
        content: 'Send a slack message to #general about our refund policy',
      })
      .expect(201);

    const result = res.body;

    // At least one tool call: slack / send_message — a person-facing external
    // action, so in chat it is PROPOSED and routed to a human approval, NOT
    // executed autonomously (guards against prompt-injected pasted content
    // driving an unapproved send). It appears in toolCalls with pendingApproval.
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
    const call = result.toolCalls.find(
      (c: { skillKey: string; tool: string }) =>
        c.skillKey === 'slack' && c.tool === 'send_message',
    );
    expect(call).toBeTruthy();
    expect(call.ok).toBe(false);
    expect(call.pendingApproval).toBe(true);
    expect(typeof call.approvalId).toBe('string');

    // A non-empty final assistant answer.
    expect(result.message.role).toBe('ASSISTANT');
    expect(typeof result.message.content).toBe('string');
    expect(result.message.content.length).toBeGreaterThan(0);

    // Metadata mirrors the tool calls.
    expect(result.message.metadata.toolCalls.length).toBeGreaterThanOrEqual(1);

    // Because the send was routed to approval (not executed), there is NO
    // successful SkillExecution row — instead a PENDING approval awaits a human.
    const executed = await prisma.skillExecution.findMany({
      where: { companyId, employeeId, skillKey: 'slack', status: 'SUCCESS' },
    });
    expect(executed.length).toBe(0);
    const pending = await prisma.approvalRequest.findMany({
      where: { companyId, employeeId, skillKey: 'slack', status: 'PENDING' },
    });
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  describe('per-employee skill connection priority (real chat path)', () => {
    // resolveInstalledForExecution (skills.service.ts) — the priority logic
    // under test — only runs for executors that set usesInstalledCredentials
    // (real/auto). This whole suite's ambient SKILL_EXECUTOR=mock leaves that
    // falsy on MockSkillExecutor, so a chat call through the SHARED `app` above
    // would never reach it (see runTool: `usesInstalledCredentials ? resolve...
    // : ctx`). Give this one test its own app with SKILL_EXECUTOR_TOKEN
    // overridden to a tiny probe executor (usesInstalledCredentials=true) that
    // echoes back exactly which InstalledSkill row got resolved — the same
    // .overrideProvider(SKILL_EXECUTOR_TOKEN) technique integrations.e2e-spec.ts
    // already uses to force a non-default executor for one dedicated app. This
    // stays fully offline/deterministic: the probe never makes a network call,
    // unlike routing through the real gmail executor would.
    let priorityApp: INestApplication;

    class ProbeSkillExecutor implements SkillExecutor {
      readonly name = 'probe';
      readonly usesInstalledCredentials = true;
      async execute(
        _skillKey: string,
        _tool: string,
        _args: Record<string, unknown>,
        ctx: ExecutorContext,
      ): Promise<SkillExecutionResult> {
        // Echo back connection-specific state so the test can assert DIRECTLY
        // on which InstalledSkill row resolveExecutorContext resolved, instead
        // of inferring it indirectly from ok:true/false.
        return {
          ok: true,
          result: {
            installedSkillId: ctx.installedSkillId ?? null,
            companyEmail:
              (ctx.config as { companyEmail?: string } | null)?.companyEmail ??
              null,
          },
        };
      }
    }

    beforeAll(async () => {
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(SKILL_EXECUTOR_TOKEN)
        .useValue(new ProbeSkillExecutor())
        .compile();
      priorityApp = moduleRef.createNestApplication();
      priorityApp.use(cookieParser());
      priorityApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, transform: true }),
      );
      await priorityApp.init();
    });

    afterAll(async () => {
      await priorityApp?.close();
    });

    it("uses the acting employee's OWN gmail connection, not the company-wide one, when both exist", async () => {
      const server = priorityApp.getHttpServer();
      const priorityEmail = `skill_priority_e2e_${Date.now()}@example.com`;

      // A dedicated, self-contained company (fresh STARTER seat cap of 2, only
      // 1 employee created below) so this test never depends on run order or
      // the shared company's BUSINESS-plan bump above still being in effect.
      const reg = await request(server)
        .post('/auth/register')
        .send({
          companyName: 'Skill Priority Co',
          name: 'Priority Owner',
          email: priorityEmail,
          password,
        })
        .expect(201);
      const priorityAuth = {
        Authorization: `Bearer ${reg.body.tokens.accessToken}`,
      };

      // Company-wide gmail connection (employeeId: null), CONNECTED with its
      // own companyEmail — the row a buggy "always company-wide" resolution
      // would pick.
      const companyWide = await request(server)
        .post('/skills/install')
        .set(priorityAuth)
        .send({ skillKey: 'gmail' })
        .expect(201);
      await request(server)
        .patch(`/skills/installed/${companyWide.body.id}/config`)
        .set(priorityAuth)
        .send({ config: { companyEmail: 'company-wide@acme.example' } })
        .expect(200);
      await request(server)
        .post(`/skills/installed/${companyWide.body.id}/connect`)
        .set(priorityAuth)
        .send({ credentials: { accessToken: 'company-wide-token' } })
        .expect(201);

      // An employee with its OWN gmail connection for the SAME skillKey,
      // CONNECTED with a DIFFERENT companyEmail (install() auto-assigns it).
      const emp = await request(server)
        .post('/employees')
        .set(priorityAuth)
        .send({ name: 'Inbox AI', role: 'SUPPORT', persona: 'Inbox assistant.' })
        .expect(201);
      const priorityEmployeeId = emp.body.id;

      const ownConn = await request(server)
        .post('/skills/install')
        .set(priorityAuth)
        .send({ skillKey: 'gmail', employeeId: priorityEmployeeId })
        .expect(201);
      await request(server)
        .patch(`/skills/installed/${ownConn.body.id}/config`)
        .set(priorityAuth)
        .send({ config: { companyEmail: 'inbox-ai-own@acme.example' } })
        .expect(200);
      await request(server)
        .post(`/skills/installed/${ownConn.body.id}/connect`)
        .set(priorityAuth)
        .send({ credentials: { accessToken: 'employee-owned-token' } })
        .expect(201);

      // Drive a REAL chat turn (NOT the manual-execute endpoint, which calls
      // runTool({ companyId }, ...) with no employeeId and so can never
      // exercise this priority logic) so resolveExecutorContext runs with a
      // real employeeId and must choose between the two InstalledSkill rows.
      const conv = await request(server)
        .post(`/employees/${priorityEmployeeId}/conversations`)
        .set(priorityAuth)
        .send({ title: 'Inbox check' })
        .expect(201);

      const res = await request(server)
        .post(`/conversations/${conv.body.id}/messages`)
        .set(priorityAuth)
        .send({ content: 'Please read my gmail inbox for anything urgent' })
        .expect(201);

      const result = res.body;
      expect(Array.isArray(result.toolCalls)).toBe(true);
      const call = result.toolCalls.find(
        (c: { skillKey: string; tool: string }) =>
          c.skillKey === 'gmail' && c.tool === 'read_inbox',
      );
      expect(call).toBeTruthy();
      expect(call.ok).toBe(true);

      // Headline assertion: the EMPLOYEE-OWNED connection was resolved — not
      // the company-wide one — even though both exist for this skill.
      expect(call.result.installedSkillId).toBe(ownConn.body.id);
      expect(call.result.installedSkillId).not.toBe(companyWide.body.id);
      expect(call.result.companyEmail).toBe('inbox-ai-own@acme.example');
    });
  });

  it('unassigns the skill from the employee', async () => {
    await request(app.getHttpServer())
      .delete(`/employees/${employeeId}/skills/${installedSkillId}`)
      .set(auth())
      .expect(204);

    const list = await request(app.getHttpServer())
      .get(`/employees/${employeeId}/skills`)
      .set(auth())
      .expect(200);
    expect(list.body.length).toBe(0);
  });

  it('uninstalls the skill', async () => {
    await request(app.getHttpServer())
      .delete(`/skills/installed/${installedSkillId}`)
      .set(auth())
      .expect(204);

    const list = await request(app.getHttpServer())
      .get('/skills/installed')
      .set(auth())
      .expect(200);
    expect(list.body.some((s: { id: string }) => s.id === installedSkillId)).toBe(
      false,
    );
  });

  it('rejects skills routes without a token', async () => {
    await request(app.getHttpServer()).get('/skills/installed').expect(401);
  });

  it('installs a skill owned by a specific employee, auto-assigning it', async () => {
    // This suite's shared company defaults to STARTER (max 2 AI employees —
    // see EmployeesService.create/maxEmployeesFor) and already has 1 ('Sky').
    // The employee-owned-connection tests below hire several more in this
    // SAME company, so lift the seat cap first (a plan with maxEmployees:
    // null) rather than restructure every test to spin up its own company.
    await prisma.subscription.update({
      where: { companyId },
      data: { plan: 'BUSINESS' },
    });

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'HR AI', role: 'HR', persona: 'HR assistant.' })
      .expect(201);
    const hrEmployeeId = emp.body.id;

    const res = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'gmail', employeeId: hrEmployeeId })
      .expect(201);
    expect(res.body.employeeId).toBe(hrEmployeeId);
    expect(res.body.displayName).toContain('HR AI');

    const assigned = await request(app.getHttpServer())
      .get(`/employees/${hrEmployeeId}/skills`)
      .set(auth())
      .expect(200);
    expect(
      assigned.body.some((a: { installedSkillId: string }) => a.installedSkillId === res.body.id),
    ).toBe(true);
  });

  it('allows a second, company-wide gmail connection alongside an employee-owned one', async () => {
    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Support AI', role: 'SUPPORT', persona: 'Support assistant.' })
      .expect(201);
    const supportEmployeeId = emp.body.id;

    await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'gmail', employeeId: supportEmployeeId })
      .expect(201);

    // A second employee-owned gmail connection (different employee) must NOT
    // collide with the first — the unique constraint is (companyId, skillKey,
    // employeeId), not (companyId, skillKey).
    const list = await request(app.getHttpServer())
      .get('/skills/installed')
      .set(auth())
      .expect(200);
    const gmailRows = list.body.filter((s: { skillKey: string }) => s.skillKey === 'gmail');
    expect(gmailRows.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects installing the same skill for the same employee twice (409)', async () => {
    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Sales AI', role: 'SALES', persona: 'Sales assistant.' })
      .expect(201);
    const salesEmployeeId = emp.body.id;

    await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'gmail', employeeId: salesEmployeeId })
      .expect(201);

    await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'gmail', employeeId: salesEmployeeId })
      .expect(409);
  });

  it('rejects installing a skill for an employee from a different company (404)', async () => {
    const otherCompany = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Other Co',
        name: 'Other Owner',
        email: `other_${Date.now()}@example.com`,
        password: 'password123',
      })
      .expect(201);
    const otherEmployee = await request(app.getHttpServer())
      .post('/employees')
      .set({ Authorization: `Bearer ${otherCompany.body.tokens.accessToken}` })
      .send({ name: 'Other Employee', role: 'SUPPORT', persona: 'x' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'gmail', employeeId: otherEmployee.body.id })
      .expect(404);
  });
});
