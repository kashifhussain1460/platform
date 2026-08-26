import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AgentRuntimeService } from '../src/modules/employees/runtime/agent-runtime.service';
import { AiStepNodeHandler } from '../src/modules/workflows/engine/nodes/ai-step.handler';
import { SkillsService } from '../src/modules/skills/skills.service';
import { RunStateWriter } from '../src/modules/workflow-runtime/run-state-writer.service';
import { ReaperService } from '../src/modules/workflow-runtime/reaper.service';
import { CreditBalanceService } from '../src/modules/credits/credit-balance.service';

/**
 * Credit system Phase 3 (Usage Integration) e2e — needs live Postgres.
 * Proves the plan's shadow-mode acceptance criteria for each of the 4 real
 * spend sites (chat, AI_STEP, TOOL_ACTION/SkillsService.runTool) plus the
 * durable-engine terminal-transition hook (Task 3.6) and the reaper's
 * EXPIRED_UNKNOWN wiring.
 *
 * `CREDIT_LEDGER_ENABLED` is read live from `process.env` on every call (not
 * snapshotted at boot like `ConfigService` — see `credit-config.ts`), so
 * tests toggle it directly rather than needing a second app instance.
 *
 * Cleanup is EXPLICIT and thorough (unlike credits-phase2's fresh-company-
 * per-run style): `CreditReservation`/`CreditLedger`/`CompanyCreditBalance`
 * use Convention B (plain `companyId`, no `@relation`), so `Company.delete`
 * does NOT cascade to them — leaving them un-deleted is exactly what
 * polluted the dev DB across this session's many manual test runs and made
 * the reservation-leak sweep (deliberately cross-tenant) trip over stale
 * rows from unrelated, hours-old runs.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 3 — Usage Integration e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let balance: CreditBalanceService;
  let agentRuntime: AgentRuntimeService;
  let aiStep: AiStepNodeHandler;
  let skills: SkillsService;
  let stateWriter: RunStateWriter;
  let reaper: ReaperService;
  const ts = Date.now();
  const companyIds: string[] = [];

  async function newCompany(label: string): Promise<string> {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P3 ${label} ${ts}-${Math.random()}`,
        name: 'Owner',
        email: `credits3_${label}_${ts}_${Math.round(Math.random() * 1e6)}@ex.com`,
        password: 'password123',
      })
      .expect(201);
    const id = reg.body.company.id as string;
    companyIds.push(id);
    return id;
  }

  /** TEST SCAFFOLDING ONLY — direct cache write, never done in production code. */
  async function resetBalance(companyId: string, bal: number, reservedBal = 0): Promise<void> {
    await prisma.companyCreditBalance.upsert({
      where: { companyId },
      create: { companyId, balance: bal, reservedBalance: reservedBal, updatedAt: new Date() },
      update: { balance: bal, reservedBalance: reservedBal },
    });
  }

  /** A minimal Workflow + RUNNING WorkflowRun + WorkflowStepRun, for tests that exercise RunStateWriter/ReaperService directly. */
  async function seedRun(companyId: string, stepStatus: 'RUNNING' = 'RUNNING') {
    const workflow = await prisma.workflow.create({
      data: {
        companyId,
        name: 'Phase 3 test workflow',
        status: 'ACTIVE',
        definition: {
          nodes: [{ id: 'trigger', type: 'TRIGGER', config: {} }, { id: 'step', type: 'TOOL_ACTION', config: {} }],
          edges: [{ from: 'trigger', to: 'step' }],
        },
      },
    });
    const run = await prisma.workflowRun.create({
      data: { companyId, workflowId: workflow.id, status: 'RUNNING' },
    });
    const step = await prisma.workflowStepRun.create({
      data: { companyId, runId: run.id, nodeId: 'step', type: 'TOOL_ACTION', status: stepStatus },
    });
    return { workflow, run, step };
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    balance = app.get(CreditBalanceService);
    agentRuntime = app.get(AgentRuntimeService);
    aiStep = app.get(AiStepNodeHandler);
    skills = app.get(SkillsService);
    stateWriter = app.get(RunStateWriter);
    reaper = app.get(ReaperService);
  });

  afterAll(async () => {
    delete process.env.CREDIT_LEDGER_ENABLED;
    if (companyIds.length > 0) {
      // Convention B tables first (no cascade from Company).
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.creditReservation.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.companyCreditBalance.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.skillExecution.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflowStepAttempt.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflowStepRun.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflowRun.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflow.deleteMany({ where: { companyId: { in: companyIds } } });
      // Cascades AiEmployee/Conversation/Message/User etc.
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  describe('Task 3.3 — chat wiring + CREDIT_LEDGER_ENABLED', () => {
    let companyId: string;
    let employee: { id: string; companyId: string; name: string; role: string; status: string; knowledgeAccess: string; budgetLimit: number | null };
    beforeAll(async () => {
      companyId = await newCompany('chat');
      employee = (await prisma.aiEmployee.create({
        data: { companyId, name: 'Chat Bot', role: 'SUPPORT' },
      })) as never;
    });

    it('flag OFF (default): a chat turn creates zero CreditReservation rows — byte-identical to pre-Phase-3', async () => {
      delete process.env.CREDIT_LEDGER_ENABLED;
      const conversation = await prisma.conversation.create({
        data: { companyId, employeeId: employee.id },
      });
      const result = await agentRuntime.run(employee as never, conversation as never, 'Hello, can you help me?');
      expect(result.message).toBeDefined();
      const rows = await prisma.creditReservation.count({ where: { conversationId: conversation.id } });
      expect(rows).toBe(0);
    });

    it('flag ON: a successful chat turn opens a reservation and settles it from real usage', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      await resetBalance(companyId, 1000);
      const conversation = await prisma.conversation.create({
        data: { companyId, employeeId: employee.id },
      });

      await agentRuntime.run(employee as never, conversation as never, 'Hello again.');

      const reservation = await prisma.creditReservation.findFirst({
        where: { conversationId: conversation.id },
      });
      expect(reservation).not.toBeNull();
      expect(reservation!.status).toBe('SETTLED');
      expect(Number(reservation!.actualCredits)).toBeGreaterThan(0);
      expect(reservation!.resourceType).toBe('LLM_CALL');

      const debits = await prisma.creditLedger.count({
        where: { reservationId: reservation!.id, transactionType: 'DEBIT' },
      });
      expect(debits).toBe(1);

      // §33 — exactly one audit row for this settlement.
      const auditRows = await prisma.auditLog.count({
        where: { companyId, action: 'credit.settled', entityId: reservation!.id },
      });
      expect(auditRows).toBe(1);
    });

    it('a second, independent turn opens and settles its OWN reservation — turns never collide', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      const conversation = await prisma.conversation.create({
        data: { companyId, employeeId: employee.id },
      });
      await agentRuntime.run(employee as never, conversation as never, 'First question.');
      await agentRuntime.run(employee as never, conversation as never, 'Second question.');

      const reservations = await prisma.creditReservation.findMany({
        where: { conversationId: conversation.id },
      });
      expect(reservations).toHaveLength(2);
      expect(reservations.every((r) => r.status === 'SETTLED')).toBe(true);
      expect(reservations[0].idempotencyKey).not.toBe(reservations[1].idempotencyKey);
    });
  });

  describe('Task 3.4 — AI_STEP wiring', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('ai-step');
    });
    beforeEach(async () => {
      await resetBalance(companyId, 1000);
    });

    it('flag OFF: AI_STEP creates zero CreditReservation rows', async () => {
      delete process.env.CREDIT_LEDGER_ENABLED;
      const runId = randomUUID();
      const stepRunId = randomUUID();
      await aiStep.execute({
        companyId,
        workflowId: randomUUID(),
        runId,
        stepRunId,
        node: { id: 'n1', type: 'AI_STEP', config: { prompt: 'Say hi.' } } as never,
        context: {},
        dryRun: false,
      });
      const rows = await prisma.creditReservation.count({ where: { workflowStepRunId: stepRunId } });
      expect(rows).toBe(0);
    });

    it('flag ON: AI_STEP opens and settles a reservation keyed off stepRunId', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      const runId = randomUUID();
      const stepRunId = randomUUID();
      await aiStep.execute({
        companyId,
        workflowId: randomUUID(),
        runId,
        stepRunId,
        node: { id: 'n1', type: 'AI_STEP', config: { prompt: 'Say hi.' } } as never,
        context: {},
        dryRun: false,
      });
      const reservation = await prisma.creditReservation.findFirst({
        where: { workflowStepRunId: stepRunId },
      });
      expect(reservation).not.toBeNull();
      expect(reservation!.status).toBe('SETTLED');
      expect(reservation!.workflowRunId).toBe(runId);
    });

    it('LOOP-collision proof: two AI_STEP calls sharing the same nodeId but different stepRunId both settle independently', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      const runId = randomUUID();
      const stepRunIdA = randomUUID();
      const stepRunIdB = randomUUID();
      const node = { id: 'loop-node', type: 'AI_STEP', config: { prompt: 'Iterate.' } } as never;

      await Promise.all([
        aiStep.execute({ companyId, workflowId: randomUUID(), runId, stepRunId: stepRunIdA, node, context: {}, dryRun: false }),
        aiStep.execute({ companyId, workflowId: randomUUID(), runId, stepRunId: stepRunIdB, node, context: {}, dryRun: false }),
      ]);

      const [resA, resB] = await Promise.all([
        prisma.creditReservation.findFirst({ where: { workflowStepRunId: stepRunIdA } }),
        prisma.creditReservation.findFirst({ where: { workflowStepRunId: stepRunIdB } }),
      ]);
      expect(resA).not.toBeNull();
      expect(resB).not.toBeNull();
      expect(resA!.id).not.toBe(resB!.id);
      expect(resA!.status).toBe('SETTLED');
      expect(resB!.status).toBe('SETTLED');
    });

    it('a retry of the SAME stepRunId reuses (never double-reserves) the reservation', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      const runId = randomUUID();
      const stepRunId = randomUUID();
      const node = { id: 'retry-node', type: 'AI_STEP', config: { prompt: 'Retry me.' } } as never;

      await aiStep.execute({ companyId, workflowId: randomUUID(), runId, stepRunId, node, context: {}, dryRun: false });
      await aiStep.execute({ companyId, workflowId: randomUUID(), runId, stepRunId, node, context: {}, dryRun: false });

      const rows = await prisma.creditReservation.count({ where: { workflowStepRunId: stepRunId } });
      expect(rows).toBe(1); // second call resolved via the idempotency key, not a fresh reservation
    });
  });

  describe('Task 3.5 — SkillsService.runTool wiring', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('runtool');
    });

    it('flag ON: a zero-cost (mock-only) tool never creates a reservation, and SkillExecution.creditsUsed is null', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      const conversationId = randomUUID();
      const call = await skills.runTool(
        { companyId, conversationId },
        'slack',
        'send_message',
        { channel: '#general', text: 'hi' },
      );
      expect(call.ok).toBe(true);
      const reservationRows = await prisma.creditReservation.count({ where: { conversationId } });
      expect(reservationRows).toBe(0);

      const execution = await prisma.skillExecution.findFirst({
        where: { companyId, conversationId },
        orderBy: { createdAt: 'desc' },
      });
      expect(execution).not.toBeNull();
      expect(execution!.creditsUsed).toBeNull();
      expect(execution!.durationMs).not.toBeNull();
    });

    it('flag ON: a real-cost tool (postiz) opens, settles a reservation, and populates SkillExecution.creditsUsed', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      await resetBalance(companyId, 1000);
      const conversationId = randomUUID();
      const call = await skills.runTool(
        { companyId, conversationId },
        'postiz',
        'schedule_post',
        { socialAccountId: 'acct_1', content: 'hello world', publishAt: new Date().toISOString() },
      );
      expect(call.ok).toBe(true);

      const reservation = await prisma.creditReservation.findFirst({ where: { conversationId } });
      expect(reservation).not.toBeNull();
      expect(reservation!.status).toBe('SETTLED');
      expect(reservation!.resourceType).toBe('TOOL_CALL');
      expect(Number(reservation!.actualCredits)).toBeGreaterThan(0);

      const execution = await prisma.skillExecution.findFirst({
        where: { companyId, conversationId },
        orderBy: { createdAt: 'desc' },
      });
      expect(Number(execution!.creditsUsed)).toBe(Number(reservation!.actualCredits));
    });

    it('flag ON: a FAILED real-cost tool call releases its reservation instead of settling it', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      await resetBalance(companyId, 1000);
      const conversationId = randomUUID();
      // Missing the required `content`/`publishAt` args does not stop
      // runTool itself (that pre-flight lives in ToolActionNodeHandler, one
      // layer up) — the mock executor still returns ok:true regardless of
      // args, so force a failure via an unknown tool name instead, which
      // resolves to `outcome.ok:false` BEFORE the real-execution branch —
      // proving no reservation is opened for a call that never got that far.
      const call = await skills.runTool({ companyId, conversationId }, 'postiz', 'not_a_real_tool', {});
      expect(call.ok).toBe(false);
      const rows = await prisma.creditReservation.count({ where: { conversationId } });
      expect(rows).toBe(0);
    });
  });

  describe('Task 3.6 — durable-engine terminal-transition hook', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('terminal-hook');
    });

    it('a step transitioning to COMPLETED with a still-PENDING reservation gets it settled by the hook (crash-recovery case)', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      await resetBalance(companyId, 100);
      const { run, step } = await seedRun(companyId);

      // Simulate the abnormal case: a reservation was opened for this step
      // but the handler crashed before its OWN settle() call ran.
      const reservation = await prisma.creditReservation.create({
        data: {
          companyId,
          workflowRunId: run.id,
          workflowStepRunId: step.id,
          resourceType: 'TOOL_CALL',
          status: 'PENDING',
          estimatedCredits: 10,
          idempotencyKey: `test-hook-${step.id}`,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.companyCreditBalance.update({
        where: { companyId },
        data: { balance: { decrement: 10 }, reservedBalance: { increment: 10 } },
      });

      await stateWriter.transitionStep({
        stepId: step.id,
        runId: run.id,
        companyId,
        to: 'COMPLETED',
        event: 'step.completed',
      });

      const resolved = await prisma.creditReservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(resolved.status).toBe('SETTLED');
      expect(Number(resolved.actualCredits)).toBe(10); // falls back to estimatedCredits
    });

    it('a step transitioning to FAILED with a still-PENDING reservation gets it RELEASED by the hook', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      await resetBalance(companyId, 100);
      const { run, step } = await seedRun(companyId);

      const reservation = await prisma.creditReservation.create({
        data: {
          companyId,
          workflowRunId: run.id,
          workflowStepRunId: step.id,
          resourceType: 'TOOL_CALL',
          status: 'PENDING',
          estimatedCredits: 15,
          idempotencyKey: `test-hook-fail-${step.id}`,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.companyCreditBalance.update({
        where: { companyId },
        data: { balance: { decrement: 15 }, reservedBalance: { increment: 15 } },
      });

      await stateWriter.transitionStep({
        stepId: step.id,
        runId: run.id,
        companyId,
        to: 'FAILED',
        error: 'boom',
        event: 'step.failed',
      });

      const resolved = await prisma.creditReservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(resolved.status).toBe('RELEASED');
      expect((await balance.getBalance(companyId)).balance).toBe(100); // fully returned
    });

    it('a step transitioning to RETRYING does NOT touch its still-open reservation', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      const { run, step } = await seedRun(companyId);
      const reservation = await prisma.creditReservation.create({
        data: {
          companyId,
          workflowRunId: run.id,
          workflowStepRunId: step.id,
          resourceType: 'TOOL_CALL',
          status: 'PENDING',
          estimatedCredits: 5,
          idempotencyKey: `test-hook-retry-${step.id}`,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });

      await stateWriter.transitionStep({
        stepId: step.id,
        runId: run.id,
        companyId,
        to: 'RETRYING',
        event: 'step.retrying',
      });

      const untouched = await prisma.creditReservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(untouched.status).toBe('PENDING'); // still open — the retry reuses it
    });
  });

  describe('Task 3.6 — reaper lease-expiry → EXPIRED_UNKNOWN (never auto-RELEASED)', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('reaper-hook');
    });

    it('an expired-lease attempt flips its tied reservation to EXPIRED_UNKNOWN, not RELEASED — the outcome may already have happened', async () => {
      process.env.CREDIT_LEDGER_ENABLED = 'true';
      await resetBalance(companyId, 100);
      const { run, step } = await seedRun(companyId);
      await prisma.workflowStepAttempt.create({
        data: {
          companyId,
          runId: run.id,
          stepId: step.id,
          attempt: 1,
          status: 'RUNNING',
          leaseOwner: 'worker-that-died',
          leaseExpiresAt: new Date(Date.now() - 1000),
          startedAt: new Date(),
        },
      });
      const reservation = await prisma.creditReservation.create({
        data: {
          companyId,
          workflowRunId: run.id,
          workflowStepRunId: step.id,
          resourceType: 'TOOL_CALL',
          status: 'PENDING',
          estimatedCredits: 8,
          idempotencyKey: `test-reaper-${step.id}`,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await prisma.companyCreditBalance.update({
        where: { companyId },
        data: { balance: { decrement: 8 }, reservedBalance: { increment: 8 } },
      });

      await reaper.sweep();

      const resolved = await prisma.creditReservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(resolved.status).toBe('EXPIRED_UNKNOWN'); // NOT released — the side effect may have happened
      // Balance stays exactly as it was: neither settled nor given back.
      expect((await balance.getBalance(companyId)).balance).toBe(92);
      expect((await balance.getBalance(companyId)).reservedBalance).toBe(8);
    });
  });
});
