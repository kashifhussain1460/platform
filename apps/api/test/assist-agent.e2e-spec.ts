import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { WorkflowDefinition } from '@vaep/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { FROZEN_NODE_TYPES } from '../src/modules/assist/agent/frozen-node-types';

/**
 * Orlixa AI Assist — the agent loop (doc 30 wave A2).
 *
 * The wave's exit criterion, stated as tests: a plain-language prompt goes in, a
 * VALID frozen-17 graph comes out, and **no `Workflow` row is created** — the
 * draft stays on the session until a human accepts it (AD-30-05).
 *
 * Runs offline against `MockLlmProvider`'s scripted assist branch, which walks
 * the real multi-step shape (read → read → propose → finish) rather than
 * returning one canned answer.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Assist agent loop (doc 30 A2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let companyId = '';

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
      .send({
        companyName: 'Agent Co',
        name: 'Ann Owner',
        email: `agent_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;

    // BUSINESS plan (the feature is gated) — set directly because the test env's
    // billing provider is the mock and plan changes go through it.
    await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(token))
      .send({ plan: 'BUSINESS' })
      .expect(201);

    // Give the agent something real to ground on: one ACTIVE employee and one
    // connected skill. Without these it can only produce a placeholder.
    await request(app.getHttpServer())
      .post('/employees')
      .set(bearer(token))
      .send({ name: 'Emma', role: 'HR' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'slack' })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  const startSession = async (prompt: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(token))
      .send({ prompt })
      .expect(201);
    return res.body.id;
  };

  it('turns a plain-language prompt into a valid frozen-17 draft, creating NO workflow', async () => {
    const workflowsBefore = await prisma.workflow.count({ where: { companyId } });

    const sessionId = await startSession(
      'When a CV arrives, have HR look at it and post the result to Slack.',
    );

    const res = await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: 'Go ahead and build it.' })
      .expect(201);

    // A draft exists and it is structurally real.
    const definition = res.body.draftDefinition as WorkflowDefinition;
    expect(definition).toBeTruthy();
    expect(definition.nodes.length).toBeGreaterThan(1);
    expect(res.body.draftVersion).toBeGreaterThan(0);

    // Exactly one TRIGGER, and it is the root.
    const triggers = definition.nodes.filter((n) => n.type === 'TRIGGER');
    expect(triggers).toHaveLength(1);
    expect(definition.edges.some((e) => e.to === triggers[0].id)).toBe(false);

    // EVERY node type is in the frozen 17 — the G32 regression guard.
    for (const node of definition.nodes) {
      expect(FROZEN_NODE_TYPES).toContain(node.type);
    }
    // And specifically not the two retired ones the old generator writes.
    const types = definition.nodes.map((n) => n.type);
    expect(types).not.toContain('AI_STEP');
    expect(types).not.toContain('NOTIFY');

    // Grounded in real tenant resources, not invented.
    const employeeStep = definition.nodes.find((n) => n.type === 'AI_EMPLOYEE_STEP');
    expect(employeeStep).toBeDefined();
    const employee = await prisma.aiEmployee.findFirst({
      where: { id: String(employeeStep?.config.employeeId), companyId },
    });
    expect(employee).not.toBeNull();

    const toolStep = definition.nodes.find((n) => n.type === 'TOOL_ACTION');
    expect(toolStep?.config.skillKey).toBe('slack');

    // 🔑 The exit criterion: still zero workflows. A conversation is not a
    // workflow until a human says so.
    expect(await prisma.workflow.count({ where: { companyId } })).toBe(
      workflowsBefore,
    );
  }, 40_000);

  it('records the assistant turn with a tool trace showing the steps it took', async () => {
    const sessionId = await startSession('Build me something simple.');
    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: 'Yes please.' })
      .expect(201);

    const messages = await prisma.assistMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    const assistant = messages.find((m) => m.role === 'ASSISTANT');
    expect(assistant).toBeDefined();
    expect(assistant?.content.length).toBeGreaterThan(0);

    const meta = assistant?.metadata as {
      toolTrace: { name: string; ok: boolean }[];
      graphChanged: boolean;
      finished: boolean;
    };
    // It looked things up BEFORE proposing — the grounding discipline.
    const names = meta.toolTrace.map((t) => t.name);
    expect(names).toContain('list_employees');
    expect(names).toContain('list_skills');
    expect(names.indexOf('list_skills')).toBeLessThan(names.indexOf('propose_graph'));
    expect(names).toContain('finish');
    expect(meta.toolTrace.every((t) => t.ok)).toBe(true);
    expect(meta.graphChanged).toBe(true);
    expect(meta.finished).toBe(true);
  }, 40_000);

  it('meters its token spend onto the session and under its own usage source', async () => {
    const sessionId = await startSession('Something to measure.');
    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: 'Build it.' })
      .expect(201);

    const session = await prisma.assistSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { promptTokens: true, completionTokens: true },
    });
    expect(session.promptTokens).toBeGreaterThan(0);

    // Separable from AI-Employee chat spend, so assist cost can be reasoned about.
    const events = await prisma.usageEvent.count({
      where: { companyId, source: 'assist' },
    });
    expect(events).toBeGreaterThan(0);
  }, 40_000);

  it('stops honestly when the session token budget is already spent', async () => {
    const sessionId = await startSession('Budget test.');
    await prisma.assistSession.update({
      where: { id: sessionId },
      data: { promptTokens: 400_000, completionTokens: 1 },
    });

    const res = await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: 'Keep going.' })
      .expect(201);

    // Reported plainly, the draft preserved, and the session marked so the UI
    // can offer a fresh start instead of failing silently.
    expect(res.body.status).toBe('EXHAUSTED');
    const assistant = (res.body.messages as { role: string; content: string }[])
      .reverse()
      .find((m) => m.role === 'ASSISTANT');
    expect(assistant?.content).toMatch(/budget/i);

    // A second attempt is refused rather than silently retried.
    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: 'Please?' })
      .expect(403);
  }, 40_000);

  it('accepts the agent-built draft into a real workflow that runs the same as any other', async () => {
    const sessionId = await startSession('Build then accept.');
    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: 'Build it.' })
      .expect(201);

    const accepted = await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/accept`)
      .set(bearer(token))
      .send({ name: `From the agent ${ts}` })
      .expect(201);

    // It went through the ORDINARY create path, so it validated like any other.
    expect(accepted.body.status).toBe('DRAFT');
    expect(accepted.body.definition.nodes.length).toBeGreaterThan(1);

    const row = await prisma.workflow.findUnique({
      where: { id: accepted.body.id },
      select: { assistSessionId: true },
    });
    expect(row?.assistSessionId).toBe(sessionId);
  }, 40_000);

  it('cannot be driven by another tenant', async () => {
    const sessionId = await startSession('Private build.');
    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Other Agent Co',
        name: 'Otto',
        email: `agent_other_${ts}@ex.com`,
        password,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(other.body.tokens.accessToken))
      .send({ plan: 'BUSINESS' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(other.body.tokens.accessToken))
      .send({ text: 'Let me in.' })
      .expect(404);
  }, 40_000);

  it('does not store the opening prompt twice when it is sent again unanswered', async () => {
    // The client is meant to open the stream with EMPTY text when a session was
    // created with a prompt. When it sends the words again instead, the customer
    // saw their own question twice in the thread — and it cost them one of their
    // limited turns for a message the agent was already going to read.
    const prompt = 'When a CV arrives, acknowledge it by email.';
    const sessionId = await startSession(prompt);

    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: prompt })
      .expect(201);

    const asked = await prisma.assistMessage.count({
      where: { sessionId, role: 'USER' },
    });
    expect(asked).toBe(1);
  });

  it('still stores a genuinely new question', async () => {
    // The guard must only collapse a REPEAT of the unanswered turn — a real
    // follow-up has to land, or the conversation stops working.
    const sessionId = await startSession('Acknowledge new CVs by email.');

    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: 'Also tell the hiring manager on Slack.' })
      .expect(201);

    const asked = await prisma.assistMessage.count({
      where: { sessionId, role: 'USER' },
    });
    expect(asked).toBe(2);
  });
});
