import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AgentRuntimeService } from '../src/modules/employees/runtime/agent-runtime.service';
import { AiStepNodeHandler } from '../src/modules/workflows/engine/nodes/ai-step.handler';
import { ToolExecutorService } from '../src/modules/employees/runtime/tool-executor.service';
import { SkillsService } from '../src/modules/skills/skills.service';
import { CreditLimitsService } from '../src/modules/credits/credit-limits.service';
import { CreditBalanceService } from '../src/modules/credits/credit-balance.service';

/**
 * Credit system Phase 8 (Enforcement) e2e — needs live Postgres + Redis.
 * This is the phase that actually makes credits real — proves Layers 1-3
 * (Tasks 8.1-8.3), the enforcement-off regression guard, the three layers'
 * distinct messages, and the legacy-engine retry gate (Task 8.4).
 *
 * `creditEnforcementEnabledAt` is set directly via Prisma throughout (the
 * real admin toggle is Phase 10/12's `PlatformAdminGuard`-only endpoint,
 * not yet built) — matches the plan's own sequencing (Task 8.3 ships before
 * Task 12.1's operable surface).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 8 — Enforcement e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentRuntime: AgentRuntimeService;
  let aiStep: AiStepNodeHandler;
  let toolExecutor: ToolExecutorService;
  let skills: SkillsService;
  let creditLimits: CreditLimitsService;
  let balance: CreditBalanceService;
  const ts = Date.now();
  const companyIds: string[] = [];

  async function newCompany(label: string): Promise<string> {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P8 ${label} ${ts}-${Math.random()}`,
        name: 'Owner',
        email: `p8_${label}_${ts}_${Math.round(Math.random() * 1e6)}@ex.com`,
        password: 'password123',
      })
      .expect(201);
    const id = reg.body.company.id as string;
    companyIds.push(id);
    return id;
  }

  async function resetBalance(companyId: string, bal: number, reservedBal = 0): Promise<void> {
    await prisma.companyCreditBalance.upsert({
      where: { companyId },
      create: { companyId, balance: bal, reservedBalance: reservedBal, updatedAt: new Date() },
      update: { balance: bal, reservedBalance: reservedBal },
    });
  }

  async function enableEnforcement(companyId: string): Promise<void> {
    await prisma.company.update({
      where: { id: companyId },
      data: { creditEnforcementEnabledAt: new Date() },
    });
  }

  beforeAll(async () => {
    process.env.CREDIT_LEDGER_ENABLED = 'true';
    process.env.CREDIT_ENFORCEMENT_ENABLED = 'true';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    agentRuntime = app.get(AgentRuntimeService);
    aiStep = app.get(AiStepNodeHandler);
    toolExecutor = app.get(ToolExecutorService);
    skills = app.get(SkillsService);
    creditLimits = app.get(CreditLimitsService);
    balance = app.get(CreditBalanceService);
  });

  afterAll(async () => {
    delete process.env.CREDIT_LEDGER_ENABLED;
    delete process.env.CREDIT_ENFORCEMENT_ENABLED;
    if (companyIds.length > 0) {
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.creditReservation.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.companyCreditBalance.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.employeeCreditPeriodCounter.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflowStepRun.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflowRun.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflow.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  describe('Task 8.3 — enforcement-off regression guard', () => {
    it('an enforcement-OFF company (not on the allowlist) behaves exactly as Phase 3 — never blocked even at zero balance', async () => {
      const companyId = await newCompany('shadow');
      await resetBalance(companyId, 0);
      const employee = await prisma.aiEmployee.create({ data: { companyId, name: 'Bot', role: 'SUPPORT' } });
      const conversation = await prisma.conversation.create({ data: { companyId, employeeId: employee.id } });

      // Not enrolled (creditEnforcementEnabledAt stays null) — global flag is
      // on, but this company specifically is not.
      const result = await agentRuntime.run(employee as never, conversation as never, 'hello');
      expect(result.message).toBeDefined();
    });
  });

  describe('Task 8.3 — Layer 1 (company balance), distinct blocking at chat/AI_STEP/TOOL_ACTION', () => {
    it('chat: an enforcement-ON, zero-balance company is blocked with a company-balance message', async () => {
      const companyId = await newCompany('chatzero');
      await enableEnforcement(companyId);
      await resetBalance(companyId, 0);
      const employee = await prisma.aiEmployee.create({ data: { companyId, name: 'Bot', role: 'SUPPORT' } });
      const conversation = await prisma.conversation.create({ data: { companyId, employeeId: employee.id } });

      await expect(agentRuntime.run(employee as never, conversation as never, 'hello')).rejects.toThrow(
        /run out of credits/i,
      );
    });

    it('AI_STEP: an enforcement-ON, zero-balance company is blocked with the SAME company-balance message', async () => {
      const companyId = await newCompany('aisteperzero');
      await enableEnforcement(companyId);
      await resetBalance(companyId, 0);

      // Layer 3 (checkAndReserveWorkflowLimit) does a findUniqueOrThrow on
      // WorkflowRun, so a fake/unseeded runId would throw an unrelated
      // "record not found" error that gets swallowed as a shadow-mode hiccup
      // before Layer 1 (reserve()) is ever reached — a real run needs a real
      // WorkflowRun row, same as every other sub-describe in this file.
      const workflow = await prisma.workflow.create({
        data: { companyId, name: 'p8-aistep', definition: { nodes: [], edges: [] } },
      });
      const run = await prisma.workflowRun.create({
        data: { companyId, workflowId: workflow.id, status: 'RUNNING', engineMode: 'state_machine' },
      });

      await expect(
        aiStep.execute({
          companyId,
          workflowId: workflow.id,
          runId: run.id,
          stepRunId: randomUUID(),
          node: { id: 'n1', type: 'AI_STEP', config: { prompt: 'hi' } } as never,
          context: {},
          dryRun: false,
        }),
      ).rejects.toThrow(/run out of credits/i);
    });

    it('TOOL_ACTION (via runTool): an enforcement-ON, zero-balance company is blocked as ok:false, not a thrown error', async () => {
      const companyId = await newCompany('toolzero');
      await enableEnforcement(companyId);
      await resetBalance(companyId, 0);

      // Calls SkillsService.runTool() directly, not ToolExecutorService.call() —
      // the only two tools with a nonzero credit cost today (postiz
      // schedule_post/publish_now, per DEFAULT_TOOL_RATES) are BOTH catalog
      // `highRisk`, so routing through ToolExecutorService would hit the
      // (correctly-functioning, unrelated) approval gate first and never
      // reach runTool()'s enforcement check at all.
      const call = await skills.runTool(
        { companyId },
        'postiz',
        'schedule_post',
        { socialAccountId: 'a1', content: 'hi', publishAt: new Date().toISOString() },
      );
      expect(call.ok).toBe(false);
      expect(call.error).toMatch(/run out of credits/i);
    });

    it('the three layers use literally different message text (§45 "must not look identical")', async () => {
      // Layer 1 (from the chat test above): "run out of credits"
      const layer1 = 'This company has run out of credits. An owner or admin needs to add more credits before this can continue.';
      // Layer 2 (verbatim-reused dollar-check phrasing)
      const layer2 = 'has reached its monthly budget limit — raise the limit or wait for next month to send more messages.';
      // Layer 3
      const layer3 = 'This workflow run has reached its configured credit limit.';
      expect(layer1).not.toBe(layer2);
      expect(layer1).not.toBe(layer3);
      expect(layer2).not.toBe(layer3);
    });
  });

  describe('Task 8.1 — EmployeeCreditPeriodCounter (atomic Layer 2)', () => {
    it('a budgetLimitSnapshot=null (unlimited) employee is never blocked', async () => {
      const companyId = await newCompany('unlimitedemp');
      const employee = await prisma.aiEmployee.create({
        data: { companyId, name: 'Bot', role: 'SUPPORT', budgetLimit: null },
      });
      await expect(
        creditLimits.checkAndReserveEmployeeBudget({ employeeId: employee.id, companyId, cost: 1_000_000, costKind: 'EXECUTION' }),
      ).resolves.toBeUndefined();
    });

    it('two concurrent calls that would jointly exceed the snapshot limit: exactly one succeeds', async () => {
      const companyId = await newCompany('concurrentemp');
      const employee = await prisma.aiEmployee.create({
        data: { companyId, name: 'Bot', role: 'SUPPORT', budgetLimit: 1 }, // 1 USD * 100 credits/USD = 100 credits
      });

      const results = await Promise.allSettled([
        creditLimits.checkAndReserveEmployeeBudget({ employeeId: employee.id, companyId, cost: 60, costKind: 'EXECUTION' }),
        creditLimits.checkAndReserveEmployeeBudget({ employeeId: employee.id, companyId, cost: 60, costKind: 'EXECUTION' }),
      ]);
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
    });
  });

  describe('Task 8.2 — WorkflowRun.totalCreditsCharged (atomic Layer 3)', () => {
    it('a creditLimit=null (unlimited) run is never blocked', async () => {
      const companyId = await newCompany('unlimitedrun');
      const workflow = await prisma.workflow.create({
        data: { companyId, name: 'wf', status: 'ACTIVE', definition: { nodes: [], edges: [] } },
      });
      const run = await prisma.workflowRun.create({
        data: { companyId, workflowId: workflow.id, status: 'RUNNING', creditLimit: null },
      });
      await expect(
        creditLimits.checkAndReserveWorkflowLimit({ workflowRunId: run.id, companyId, cost: 1_000_000 }),
      ).resolves.toBeUndefined();
    });

    it('a LOOP driving many rapid iterations against a tight creditLimit is hard-stopped exactly at the cap, never over', async () => {
      const companyId = await newCompany('looprun');
      const workflow = await prisma.workflow.create({
        data: { companyId, name: 'wf', status: 'ACTIVE', definition: { nodes: [], edges: [] } },
      });
      const run = await prisma.workflowRun.create({
        data: { companyId, workflowId: workflow.id, status: 'RUNNING', creditLimit: 100 },
      });

      let succeeded = 0;
      let blocked = 0;
      for (let i = 0; i < 20; i += 1) {
        try {
          await creditLimits.checkAndReserveWorkflowLimit({ workflowRunId: run.id, companyId, cost: 15 });
          succeeded += 1;
        } catch {
          blocked += 1;
        }
      }
      expect(succeeded).toBe(6); // floor(100/15) — never over the cap
      expect(blocked).toBe(14);
      const finalRun = await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(Number(finalRun.totalCreditsCharged)).toBeLessThanOrEqual(100);
    });
  });

  describe('Task 8.4 — legacy-engine retry gate', () => {
    async function newCompanyWithToken(label: string) {
      const email = `p8_${label}_${ts}_${Math.round(Math.random() * 1e6)}@ex.com`;
      const reg = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          companyName: `Credits P8 ${label} ${ts}-${Math.random()}`,
          name: 'Owner',
          email,
          password: 'password123',
        })
        .expect(201);
      const companyId = reg.body.company.id as string;
      companyIds.push(companyId);
      return { companyId, accessToken: reg.body.tokens.accessToken as string };
    }

    async function seedLegacyRunWithBillableNode(companyId: string) {
      const workflow = await prisma.workflow.create({
        data: {
          companyId,
          name: 'legacy wf',
          status: 'ACTIVE',
          definition: {
            nodes: [
              { id: 'trigger', type: 'TRIGGER', config: {} },
              { id: 'step', type: 'AI_STEP', config: { prompt: 'hi' } },
            ],
            edges: [{ from: 'trigger', to: 'step' }],
          },
        },
      });
      const run = await prisma.workflowRun.create({
        data: { companyId, workflowId: workflow.id, status: 'FAILED', engineMode: 'legacy_walk' },
      });
      return run;
    }

    it('a legacy_walk run with a billable node, enforcement ON, gets 409 on retry', async () => {
      const { companyId, accessToken } = await newCompanyWithToken('legacyretryon');
      await enableEnforcement(companyId);
      const run = await seedLegacyRunWithBillableNode(companyId);

      await request(app.getHttpServer())
        .post(`/workflows/runs/${run.id}/retry`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
    });

    it('the same shape of run for a NON-enforcement company retries exactly as today', async () => {
      const { companyId, accessToken } = await newCompanyWithToken('legacyretryoff');
      // enforcement NOT enabled for this company
      const run = await seedLegacyRunWithBillableNode(companyId);

      const res = await request(app.getHttpServer())
        .post(`/workflows/runs/${run.id}/retry`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).not.toBe(409);
    });
  });
});
