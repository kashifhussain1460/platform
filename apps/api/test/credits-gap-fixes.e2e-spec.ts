import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AgentRuntimeService } from '../src/modules/employees/runtime/agent-runtime.service';
import { CreditReconciliationService } from '../src/modules/credits/credit-reconciliation.service';
import { CompanyConcurrencyGuardService } from '../src/modules/credits/company-concurrency-guard.service';

/**
 * Regression coverage for the 5 cross-phase gaps found in the post-Phase-13
 * audit (2026-08-20):
 *   1. Layer 3 (workflow credit limit) bypassed entirely by AI_EMPLOYEE_STEP.
 *   2. TOOL_ACTION's Layer 1/3 blocks misclassified as retryable NODE_ERROR
 *      (covered separately, at the unit level, in retry-policy.service.spec.ts).
 *   3. Manual ADJUSTMENT entries missing from the finance rollup (covered
 *      separately in credits-phase10-rollup.e2e-spec.ts).
 *   4. CompanyConcurrencyGuardService built but never wired anywhere.
 *   5. Canary comparison report only checking Layer 1.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system gap fixes (post-Phase-13 audit) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentRuntime: AgentRuntimeService;
  let reconciliation: CreditReconciliationService;
  let concurrencyGuard: CompanyConcurrencyGuardService;
  const ts = Date.now();
  const companyIds: string[] = [];

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
    reconciliation = app.get(CreditReconciliationService);
    concurrencyGuard = app.get(CompanyConcurrencyGuardService);
  });

  afterAll(async () => {
    delete process.env.CREDIT_LEDGER_ENABLED;
    delete process.env.CREDIT_ENFORCEMENT_ENABLED;
    if (companyIds.length > 0) {
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.companyCreditBalance.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflowRun.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflow.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  async function newCompany(label: string): Promise<string> {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits gapfix ${label} ${ts}`,
        name: 'Owner',
        email: `gapfix_${label}_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    const id = reg.body.company.id as string;
    companyIds.push(id);
    return id;
  }

  async function enableEnforcement(companyId: string): Promise<void> {
    await prisma.company.update({ where: { id: companyId }, data: { creditEnforcementEnabledAt: new Date() } });
  }

  async function resetBalance(companyId: string, balance: number): Promise<void> {
    await prisma.companyCreditBalance.upsert({
      where: { companyId },
      create: { companyId, balance, reservedBalance: 0, updatedAt: new Date() },
      update: { balance, reservedBalance: 0 },
    });
  }

  describe('Gap fix 1 — Layer 3 via AI_EMPLOYEE_STEP', () => {
    it('a workflow run with a tight creditLimit blocks a chat-runtime turn driven by AI_EMPLOYEE_STEP, not just AI_STEP/TOOL_ACTION', async () => {
      const companyId = await newCompany('layer3');
      await enableEnforcement(companyId);
      await resetBalance(companyId, 1_000_000); // plenty of company balance — this must fail on Layer 3, not Layer 1

      const workflow = await prisma.workflow.create({
        data: { companyId, name: 'gapfix wf', definition: { nodes: [], edges: [] } },
      });
      const run = await prisma.workflowRun.create({
        data: { companyId, workflowId: workflow.id, status: 'RUNNING', engineMode: 'state_machine', creditLimit: 1 },
      });
      const employee = await prisma.aiEmployee.create({
        data: { companyId, name: 'Bot', role: 'SUPPORT' },
      });
      const conversation = await prisma.conversation.create({
        data: { companyId, employeeId: employee.id },
      });

      await expect(
        agentRuntime.run(employee as never, conversation as never, 'hello', {
          workflowRunId: run.id,
        } as never),
      ).rejects.toThrow(/configured credit limit/i);
    });
  });

  describe('Gap fix 4 — per-company concurrency guard is actually wired', () => {
    it('acquiring beyond the configured cap is rejected, and releasing frees a slot again', async () => {
      // Exercises the real service (same one injected into agent-runtime,
      // ai-step, and skills.service) directly, at its configured default —
      // the full end-to-end "Nth concurrent chat send is rejected" scenario
      // is covered at the unit level in company-concurrency-guard.service.spec.ts;
      // this proves the SAME instance the app actually wired in is reachable
      // and behaves the same way under real DI.
      const testCompanyId = `gapfix-concurrency-${ts}`;
      const max = concurrencyGuard.maxConcurrent;
      const acquisitions = await Promise.all(
        Array.from({ length: max + 5 }, () => concurrencyGuard.tryAcquire(testCompanyId)),
      );
      const accepted = acquisitions.filter(Boolean).length;
      expect(accepted).toBe(max);

      // Clean up so this doesn't leak into other tests sharing the same guard instance.
      await Promise.all(Array.from({ length: max }, () => concurrencyGuard.release(testCompanyId)));
      expect(await concurrencyGuard.current(testCompanyId)).toBe(0);
    });
  });

  describe('Gap fix 5 — canary comparison also checks Layer 3', () => {
    it('flags a WORKFLOW_LIMIT_EXCEEDED block recorded against a null creditLimit', async () => {
      const companyId = await newCompany('canaryl3');
      const workflow = await prisma.workflow.create({
        data: { companyId, name: 'canary l3 wf', definition: { nodes: [], edges: [] } },
      });
      await prisma.workflowRun.create({
        data: {
          companyId,
          workflowId: workflow.id,
          status: 'FAILED',
          failureClass: 'WORKFLOW_LIMIT_EXCEEDED',
          creditLimit: null,
        },
      });

      const report = await reconciliation.canaryComparisonReport(
        companyId,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );
      expect(report.discrepancies.length).toBeGreaterThanOrEqual(1);
      expect(report.discrepancies[0].reason).toMatch(/no creditLimit set/i);
    });

    it('does not flag a WORKFLOW_LIMIT_EXCEEDED block that had a real creditLimit', async () => {
      const companyId = await newCompany('canaryl3clean');
      const workflow = await prisma.workflow.create({
        data: { companyId, name: 'canary l3 clean wf', definition: { nodes: [], edges: [] } },
      });
      await prisma.workflowRun.create({
        data: {
          companyId,
          workflowId: workflow.id,
          status: 'FAILED',
          failureClass: 'WORKFLOW_LIMIT_EXCEEDED',
          creditLimit: 100,
          totalCreditsCharged: 100,
        },
      });

      const report = await reconciliation.canaryComparisonReport(
        companyId,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );
      expect(report.discrepancies).toHaveLength(0);
    });
  });
});
