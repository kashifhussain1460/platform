import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Regression e2e for gap **G25** (SAFETY BYPASS).
 *
 * Before the fix, a `TOOL_ACTION` node called `SkillsService.runTool()`
 * directly with no approval check, so a `highRisk` catalog tool (here
 * `stripe.create_payment_link` — the exact example G25 cites) executed from a
 * workflow with no human gate, even though the chat path gated it. A customer
 * who configured "all tool calls need approval" did not have that control once
 * a workflow was involved.
 *
 * Needs a live Postgres + Redis (BullMQ). Skipped when DATABASE_URL is unset.
 * Run with:
 *   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
 *   SKILL_EXECUTOR=mock BILLING_PROVIDER=mock \
 *   DATABASE_URL=... REDIS_URL=... JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StepRow {
  type: string;
  status: string;
}
interface RunBody {
  id: string;
  status: string;
  error: string | null;
  steps?: StepRow[];
}

describeIfDb('G25 — workflow TOOL_ACTION approval gate', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `wf_toolgate_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let companyId = '';
  let gatedWorkflowId = '';
  let plainWorkflowId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  const getRun = async (runId: string): Promise<RunBody> => {
    const res = await request(app.getHttpServer())
      .get(`/workflows/runs/${runId}`)
      .set(auth())
      .expect(200);
    return res.body as RunBody;
  };

  const startRun = async (workflowId: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { amount: 4200 } })
      .expect(201);
    return res.body.id as string;
  };

  const pollUntil = async (
    runId: string,
    stop: (r: RunBody) => boolean,
  ): Promise<RunBody> => {
    const deadline = Date.now() + 20_000;
    let run = await getRun(runId);
    while (Date.now() < deadline) {
      run = await getRun(runId);
      if (stop(run)) break;
      await sleep(300);
    }
    return run;
  };

  const isSettled = (r: RunBody) =>
    r.status === 'WAITING' || r.status === 'COMPLETED' || r.status === 'FAILED';
  const isTerminal = (r: RunBody) =>
    r.status === 'COMPLETED' || r.status === 'FAILED';

  /** Count real executions of the gated tool — the proof it did/didn't run. */
  const stripeExecutions = () =>
    prisma.skillExecution.count({
      where: { companyId, skillKey: 'stripe', tool: 'create_payment_link' },
    });

  const makeWorkflow = async (
    name: string,
    skillKey: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const definition = {
      nodes: [
        { id: 'n1', type: 'TRIGGER', config: {} },
        {
          id: 'n2',
          type: 'TOOL_ACTION',
          config: { skillKey, tool, args, outputKey: 'toolResult' },
        },
        { id: 'n3', type: 'NOTIFY', config: { message: 'done' } },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
      ],
    };
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name, definition })
      .expect(201);
    return res.body.id as string;
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

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'WF Tool Gate E2E Co',
        name: 'Gate Owner',
        email,
        password,
      })
      .expect(201);
    accessToken = res.body.tokens.accessToken;
    companyId = res.body.company.id;

    gatedWorkflowId = await makeWorkflow(
      'Gated payment link',
      'stripe',
      'create_payment_link',
      { amount: '{{trigger.amount}}', currency: 'usd' },
    );
    plainWorkflowId = await makeWorkflow(
      'Ungated slack post',
      'slack',
      'send_message',
      { channel: '#general', text: 'hello' },
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('PAUSES a highRisk TOOL_ACTION (WAITING) and does NOT execute the tool', async () => {
    const before = await stripeExecutions();

    const runId = await startRun(gatedWorkflowId);
    const run = await pollUntil(runId, isSettled);

    // The whole point of G25: the run must stop, not sail through.
    expect(run.status).toBe('WAITING');

    // A PENDING approval was opened, carrying the gated tool's identity.
    const approval = await prisma.approvalRequest.findFirst({
      where: { companyId, workflowRunId: runId, status: 'PENDING' },
    });
    expect(approval).toBeTruthy();
    expect(approval!.skillKey).toBe('stripe');
    expect(approval!.tool).toBe('create_payment_link');

    // And the side effect never happened.
    expect(await stripeExecutions()).toBe(before);
  });

  it('executes the tool exactly once after approval, then COMPLETES', async () => {
    const before = await stripeExecutions();

    const approval = await prisma.approvalRequest.findFirst({
      where: { companyId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    expect(approval).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/approvals/${approval!.id}/approve`)
      .set(auth())
      .send({})
      .expect(201);

    const run = await pollUntil(approval!.workflowRunId!, isTerminal);
    expect(run.status).toBe('COMPLETED');

    // Ran once — not zero (gate stuck), not twice (re-entry double-fire).
    expect(await stripeExecutions()).toBe(before + 1);
  });

  it('does NOT gate an ordinary tool — normal workflows still run straight through', async () => {
    const runId = await startRun(plainWorkflowId);
    const run = await pollUntil(runId, isTerminal);

    expect(run.status).toBe('COMPLETED');
    const pending = await prisma.approvalRequest.count({
      where: { companyId, workflowRunId: runId },
    });
    expect(pending).toBe(0);
  });
});
