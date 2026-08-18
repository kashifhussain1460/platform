import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { WorkflowEngine } from '../src/modules/workflows/engine/workflow-engine.service';
import {
  SKILL_EXECUTOR_TOKEN,
  type ExecutorContext,
  type SkillExecutionResult,
  type SkillExecutor,
} from '../src/modules/skills/executors/skill-executor';

// Workflow builder e2e: needs a live Postgres + Redis (BullMQ). Skipped when
// DATABASE_URL is unset so it never blocks the build. Run it with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a run to settle, whichever engine is executing it.
 *
 * `WorkflowEngine.execute()` walks the graph inline on the legacy engine but
 * merely ENQUEUES an advance on the durable one, so a test that asserted
 * `COMPLETED` on the next line passed under `legacy_walk` and failed under
 * `state_machine` — while the product was behaving correctly on both. Waiting
 * for a terminal status is the contract every real client already follows.
 */
async function settle(
  prisma: PrismaService,
  runId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (run && ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING'].includes(run.status)) {
      return;
    }
    await sleep(150);
  }
}

const DOC_TEXT = [
  'Our refund policy lets customers request a full refund within 30 days of',
  'purchase. Refunds are processed to the original payment method within five',
  'business days. Digital goods are refundable only if unused.',
].join(' ');

describeIfDb('Workflows e2e (create -> run -> poll linear chain)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `wf_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let companyId = '';
  let documentId = '';
  let workflowId = '';
  let runId = '';

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
      .send({ companyName: 'WF E2E Co', name: 'WF Owner', email, password })
      .expect(201);
    accessToken = res.body.tokens.accessToken;
    companyId = res.body.company.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('uploads knowledge and ingests it to READY', async () => {
    const upload = await request(app.getHttpServer())
      .post('/knowledge/documents')
      .set(auth())
      .attach('file', Buffer.from(DOC_TEXT, 'utf8'), {
        filename: 'refunds.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    documentId = upload.body.id;

    const deadline = Date.now() + 20_000;
    let status = 'PENDING';
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/knowledge/documents/${documentId}`)
        .set(auth())
        .expect(200);
      status = res.body.status;
      if (status === 'READY' || status === 'FAILED') {
        break;
      }
      await sleep(500);
    }
    expect(status).toBe('READY');
  }, 30_000);

  it('installs the slack skill (tenant-scoped)', async () => {
    const res = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'slack' })
      .expect(201);
    expect(res.body.skillKey).toBe('slack');
  });

  it('creates a linear workflow (TRIGGER -> RETRIEVE -> AI_STEP -> TOOL_ACTION -> NOTIFY)', async () => {
    const definition = {
      nodes: [
        { id: 'n1', type: 'TRIGGER', config: {} },
        {
          id: 'n2',
          type: 'RETRIEVE',
          config: { query: '{{trigger.query}}', k: 5, outputKey: 'retrieved' },
        },
        {
          id: 'n3',
          type: 'AI_STEP',
          config: {
            prompt: 'Summarise our policy using this context: {{retrieved}}',
            outputKey: 'aiText',
          },
        },
        {
          id: 'n4',
          type: 'TOOL_ACTION',
          config: {
            skillKey: 'slack',
            tool: 'send_message',
            args: { channel: '#general', text: '{{aiText}}' },
            outputKey: 'slackResult',
          },
        },
        {
          id: 'n5',
          type: 'NOTIFY',
          config: { message: 'Posted to slack: {{aiText}}' },
        },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4' },
        { from: 'n4', to: 'n5' },
      ],
    };

    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name: 'Refund policy broadcast', definition })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.definition.nodes.length).toBe(5);
    workflowId = res.body.id;
  });

  it('runs the workflow with a trigger payload and reaches COMPLETED', async () => {
    const start = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { query: 'refund policy' } })
      .expect(201);

    expect(start.body.status).toBe('PENDING');
    runId = start.body.id;

    const deadline = Date.now() + 20_000;
    let run: any = start.body;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/workflows/runs/${runId}`)
        .set(auth())
        .expect(200);
      run = res.body;
      if (run.status === 'COMPLETED' || run.status === 'FAILED') {
        break;
      }
      await sleep(500);
    }

    // Run completed successfully.
    expect(run.status).toBe('COMPLETED');

    // One WorkflowStepRun per node, all COMPLETED.
    expect(Array.isArray(run.steps)).toBe(true);
    expect(run.steps.length).toBe(5);
    const types = run.steps.map((s: { type: string }) => s.type);
    expect(types).toEqual([
      'TRIGGER',
      'RETRIEVE',
      'AI_STEP',
      'TOOL_ACTION',
      'NOTIFY',
    ]);
    expect(
      run.steps.every((s: { status: string }) => s.status === 'COMPLETED'),
    ).toBe(true);

    // The AI_STEP produced non-empty output.
    const aiStep = run.steps.find((s: { type: string }) => s.type === 'AI_STEP');
    expect(typeof aiStep.output.text).toBe('string');
    expect(aiStep.output.text.length).toBeGreaterThan(0);

    // The TOOL_ACTION output shows the mock slack result.
    const toolStep = run.steps.find(
      (s: { type: string }) => s.type === 'TOOL_ACTION',
    );
    expect(toolStep.output.ok).toBe(true);
    expect(toolStep.output.skillKey).toBe('slack');
    expect(String(toolStep.output.result.id)).toMatch(/^mock_send_message_/);

    // Final context carries the outputKeys threaded through the run.
    expect(run.context).toBeTruthy();
    expect(run.context).toHaveProperty('retrieved');
    expect(run.context).toHaveProperty('aiText');
    expect(run.context).toHaveProperty('slackResult');
    expect(run.context.trigger.query).toBe('refund policy');
  }, 30_000);

  it('wrote a SkillExecution audit row for the slack tool action', async () => {
    const rows = await prisma.skillExecution.findMany({
      where: {
        companyId,
        skillKey: 'slack',
        tool: 'send_message',
        status: 'SUCCESS',
      },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('lists runs for the workflow', async () => {
    const res = await request(app.getHttpServer())
      .get(`/workflows/${workflowId}/runs`)
      .set(auth())
      .expect(200);
    expect(res.body.some((r: { id: string }) => r.id === runId)).toBe(true);
  });

  // Regression: a workflow created WITHOUT a definition is seeded with a TRIGGER
  // entry node and runs to COMPLETED — previously an empty definition FAILED the
  // run with "Workflow definition has no nodes to run".
  it('seeds a TRIGGER on create; a trigger-only workflow runs to COMPLETED', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name: 'Fresh workflow' })
      .expect(201);
    expect(created.body.definition.nodes).toHaveLength(1);
    expect(created.body.definition.nodes[0].type).toBe('TRIGGER');
    const freshId = created.body.id;

    const start = await request(app.getHttpServer())
      .post(`/workflows/${freshId}/run`)
      .set(auth())
      .send({})
      .expect(201);
    const freshRunId = start.body.id;

    const deadline = Date.now() + 15_000;
    let run: any = start.body;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/workflows/runs/${freshRunId}`)
        .set(auth())
        .expect(200);
      run = res.body;
      if (run.status === 'COMPLETED' || run.status === 'FAILED') break;
      await sleep(300);
    }
    expect(run.status).toBe('COMPLETED');
    expect(run.error).toBeFalsy();
  }, 20_000);

  it('dryRun: true previews a TOOL_ACTION instead of really calling it (no SkillExecution row)', async () => {
    const definition = {
      nodes: [
        { id: 'n1', type: 'TRIGGER', config: {} },
        {
          id: 'n2',
          type: 'TOOL_ACTION',
          config: {
            skillKey: 'slack',
            tool: 'send_message',
            args: { channel: '#general', text: 'dry run check' },
            outputKey: 'result',
          },
        },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name: 'Dry run check', definition })
      .expect(201);

    const before = await prisma.skillExecution.count({
      where: { companyId, skillKey: 'slack', tool: 'send_message' },
    });

    const start = await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/run`)
      .set(auth())
      .send({ dryRun: true })
      .expect(201);
    expect(start.body.dryRun).toBe(true);

    const deadline = Date.now() + 15_000;
    let run: any = start.body;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/workflows/runs/${run.id}`)
        .set(auth())
        .expect(200);
      run = res.body;
      if (run.status === 'COMPLETED' || run.status === 'FAILED') break;
      await sleep(300);
    }
    expect(run.status).toBe('COMPLETED');
    expect(run.dryRun).toBe(true);

    const toolStep = run.steps.find(
      (s: { type: string }) => s.type === 'TOOL_ACTION',
    );
    expect(toolStep.output.ok).toBe(true);
    expect(toolStep.output.dryRun).toBe(true);
    expect(String(toolStep.output.preview)).toContain('slack');
    // Never actually called the skill: no id in the mock's real-execution
    // shape, and no new SkillExecution audit row.
    expect(toolStep.output.result).toBeUndefined();
    const after = await prisma.skillExecution.count({
      where: { companyId, skillKey: 'slack', tool: 'send_message' },
    });
    expect(after).toBe(before);
  }, 20_000);

  it('dryRun: true still fails a TOOL_ACTION pointing at an unknown skill/tool (no false "ok:true")', async () => {
    const definition = {
      nodes: [
        { id: 'n1', type: 'TRIGGER', config: {} },
        {
          id: 'n2',
          type: 'TOOL_ACTION',
          config: {
            skillKey: 'not-a-real-skill',
            tool: 'not-a-real-tool',
            args: {},
            outputKey: 'result',
          },
        },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name: 'Dry run invalid skill check', definition })
      .expect(201);

    const start = await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/run`)
      .set(auth())
      .send({ dryRun: true })
      .expect(201);

    const deadline = Date.now() + 15_000;
    let run: any = start.body;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/workflows/runs/${run.id}`)
        .set(auth())
        .expect(200);
      run = res.body;
      if (run.status === 'COMPLETED' || run.status === 'FAILED') break;
      await sleep(300);
    }
    expect(run.status).toBe('FAILED');
    const toolStep = run.steps.find(
      (s: { type: string }) => s.type === 'TOOL_ACTION',
    );
    expect(toolStep.status).toBe('FAILED');
    expect(String(toolStep.error)).toContain(
      'Unknown skill/tool: not-a-real-skill/not-a-real-tool',
    );
  }, 20_000);

  it('rejects workflow routes without a token', async () => {
    await request(app.getHttpServer()).get('/workflows').expect(401);
  });

  it('two concurrent execute() calls on the same PENDING run only run the workflow once', async () => {
    // Regression test for the edge-case recheck (2026-07-19): execute() used
    // to check `status !== 'PENDING'` and only THEN write RUNNING as a
    // separate step -- two callers racing the same run (e.g. a
    // duplicate-delivered BullMQ job) could both pass the check before
    // either write landed, and both would go on to actually run the
    // workflow (real side effects twice). Bypass the queue and call
    // WorkflowEngine.execute() directly, twice, concurrently, on a run row
    // created directly via Prisma -- same bypass reasoning as the
    // "per-employee connection priority" suite below.
    const definition = {
      nodes: [
        { id: 'n1', type: 'TRIGGER', config: {} },
        { id: 'n2', type: 'NOTIFY', config: { message: 'concurrency check' } },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name: 'Concurrent execute check', definition })
      .expect(201);

    const run = await prisma.workflowRun.create({
      data: {
        companyId,
        workflowId: wf.body.id,
        status: 'PENDING',
      },
    });

    const engine = app.get(WorkflowEngine);
    await Promise.all([engine.execute(run.id), engine.execute(run.id)]);
    await settle(prisma, run.id);

    const finished = await request(app.getHttpServer())
      .get(`/workflows/runs/${run.id}`)
      .set(auth())
      .expect(200);
    expect(finished.body.status).toBe('COMPLETED');

    // The real proof: exactly one WorkflowStepRun per node -- if both racers
    // had gotten past the guard, the workflow would have run twice and this
    // would be 4, not 2.
    const stepCount = await prisma.workflowStepRun.count({
      where: { runId: run.id },
    });
    expect(stepCount).toBe(definition.nodes.length);
  }, 20_000);

  describe('per-employee connection priority (TOOL_ACTION)', () => {
    // Same reasoning as skills.e2e-spec.ts's "per-employee skill connection
    // priority (real chat path)" test: resolveInstalledForExecution only runs
    // for executors with usesInstalledCredentials=true, which this suite's
    // ambient SKILL_EXECUTOR=mock never sets. Give this one test its own app
    // with SKILL_EXECUTOR_TOKEN overridden to a tiny probe executor that
    // echoes back exactly which InstalledSkill row got resolved, so the
    // assertion is direct rather than inferred.
    //
    // Unlike the chat test, a workflow run is normally executed by a BullMQ
    // worker (WorkflowProcessor) — and the OUTER describe block's `app` is
    // still open here, so it has its own WorkflowProcessor registered on the
    // SAME queue/Redis, racing this app's worker for any enqueued job (and
    // using the ambient mock executor if it wins). Sidestep the queue
    // entirely: create the WorkflowRun row directly and call
    // WorkflowEngine.execute() in-process against THIS app's own container,
    // so the run is guaranteed to go through the overridden probe executor.
    let priorityApp: INestApplication;
    let priorityPrisma: PrismaService;
    let priorityEngine: WorkflowEngine;

    class ProbeSkillExecutor implements SkillExecutor {
      readonly name = 'probe';
      readonly usesInstalledCredentials = true;
      async execute(
        _skillKey: string,
        _tool: string,
        _args: Record<string, unknown>,
        ctx: ExecutorContext,
      ): Promise<SkillExecutionResult> {
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
      priorityPrisma = priorityApp.get(PrismaService);
      priorityEngine = priorityApp.get(WorkflowEngine);
    });

    afterAll(async () => {
      await priorityApp?.close();
    });

    it("a TOOL_ACTION step configured with an employeeId uses that employee's OWN gmail connection, not the company-wide one", async () => {
      const server = priorityApp.getHttpServer();
      const priorityEmail = `wf_priority_e2e_${Date.now()}@example.com`;

      const reg = await request(server)
        .post('/auth/register')
        .send({
          companyName: 'Workflow Priority Co',
          name: 'Priority Owner',
          email: priorityEmail,
          password: 'password123',
        })
        .expect(201);
      const priorityAuth = {
        Authorization: `Bearer ${reg.body.tokens.accessToken}`,
      };

      // Company-wide gmail connection — the row a buggy "TOOL_ACTION never
      // knows the acting employee" resolution would fall back to.
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

      // `connect` now runs the real gmail adapter's live verification
      // (oauth-provider-adapters-wave2 plan, Tasks 2/5) before marking a
      // connection CONNECTED, so these placeholder tokens need a mocked
      // fetch standing in for Google's profile API — this test is about
      // per-employee connection PRIORITY on a TOOL_ACTION step, not Gmail
      // OAuth verification.
      const realFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ emailAddress: 'some-test-address@example.com' }),
      }) as unknown as typeof fetch;

      await request(server)
        .post(`/skills/installed/${companyWide.body.id}/connect`)
        .set(priorityAuth)
        .send({ credentials: { accessToken: 'company-wide-token' } })
        .expect(201);

      // An employee with its OWN gmail connection for the same skillKey.
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

      // Restore before the rest of the test (a real workflow run) so an
      // unrelated call never sees this mock.
      global.fetch = realFetch;

      const definition = {
        nodes: [
          { id: 'n1', type: 'TRIGGER', config: {} },
          {
            id: 'n2',
            type: 'TOOL_ACTION',
            config: {
              skillKey: 'gmail',
              tool: 'read_inbox',
              args: {},
              employeeId: priorityEmployeeId,
              outputKey: 'inboxResult',
            },
          },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      };
      const wf = await request(server)
        .post('/workflows')
        .set(priorityAuth)
        .send({ name: 'Per-employee inbox check', definition })
        .expect(201);

      // Create the PENDING run directly (bypassing WorkflowsService.createRun,
      // which would enqueue it to the racy shared BullMQ queue — see the
      // comment on this describe block) and execute it in-process against
      // THIS app's own WorkflowEngine, so it's guaranteed to use the
      // overridden probe executor.
      const workflowRow = await priorityPrisma.workflow.findFirstOrThrow({
        where: { id: wf.body.id },
      });
      const createdRun = await priorityPrisma.workflowRun.create({
        data: {
          companyId: workflowRow.companyId,
          workflowId: workflowRow.id,
          status: 'PENDING',
          source: 'MANUAL',
        },
      });
      const runId = createdRun.id;
      await priorityEngine.execute(runId);
      // On the durable engine `execute()` only enqueues, so the run finishes on
      // this app's own worker a moment later rather than inline.
      await settle(priorityPrisma, runId);

      const res = await request(server)
        .get(`/workflows/runs/${runId}`)
        .set(priorityAuth)
        .expect(200);
      const run = res.body;
      expect(run.status).toBe('COMPLETED');

      const toolStep = run.steps.find(
        (s: { type: string }) => s.type === 'TOOL_ACTION',
      );
      expect(toolStep.output.ok).toBe(true);

      // Headline assertion: the EMPLOYEE-OWNED connection was resolved for
      // this TOOL_ACTION step — not the company-wide one — even though both
      // exist for this skill.
      expect(toolStep.output.result.installedSkillId).toBe(ownConn.body.id);
      expect(toolStep.output.result.installedSkillId).not.toBe(
        companyWide.body.id,
      );
      expect(toolStep.output.result.companyEmail).toBe(
        'inbox-ai-own@acme.example',
      );
    }, 25_000);
  });
});
