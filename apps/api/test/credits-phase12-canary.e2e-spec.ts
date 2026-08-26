import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CreditReconciliationService } from '../src/modules/credits/credit-reconciliation.service';

/**
 * Credit system Phase 12, Task 12.3 (§36.3) — the canary comparison report:
 * every real INSUFFICIENT_CREDITS block for the canary company must agree
 * with what the ledger balance actually was at block time.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 12 — canary comparison e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reconciliation: CreditReconciliationService;
  const ts = Date.now();
  const companyIds: string[] = [];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    reconciliation = app.get(CreditReconciliationService);
  });

  afterAll(async () => {
    if (companyIds.length > 0) {
      await prisma.workflowRun.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.workflow.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.companyCreditBalance.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  async function newCompany(label: string): Promise<string> {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P12 canary ${label} ${ts}`,
        name: 'Owner',
        email: `p12canary_${label}_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    const id = reg.body.company.id as string;
    companyIds.push(id);
    return id;
  }

  it('a real INSUFFICIENT_CREDITS block whose ledger balance was actually zero has zero discrepancies', async () => {
    const companyId = await newCompany('agree');
    const workflow = await prisma.workflow.create({
      data: { companyId, name: 'canary wf', definition: { nodes: [], edges: [] } },
    });

    // Ledger balance genuinely at zero at the moment of the block.
    await prisma.creditLedger.create({
      data: {
        companyId,
        transactionType: 'DEBIT',
        reservationId: null,
        amount: -10,
        balanceBefore: 10,
        balanceAfter: 0,
        reason: 'seed spend down to zero',
        source: 'SYSTEM',
        idempotencyKey: `canary-agree-${ts}`,
      },
    });
    const run = await prisma.workflowRun.create({
      data: {
        companyId,
        workflowId: workflow.id,
        status: 'FAILED',
        failureClass: 'INSUFFICIENT_CREDITS',
      },
    });

    const report = await reconciliation.canaryComparisonReport(
      companyId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    expect(report.blockedRunsChecked).toBeGreaterThanOrEqual(1);
    expect(report.discrepancies).toHaveLength(0);
    void run; // seeded for the report to find
  });

  it('a block recorded against a POSITIVE ledger balance is flagged as a discrepancy', async () => {
    const companyId = await newCompany('disagree');
    const workflow = await prisma.workflow.create({
      data: { companyId, name: 'canary wf disagree', definition: { nodes: [], edges: [] } },
    });

    // Ledger says the company still had a healthy balance...
    await prisma.creditLedger.create({
      data: {
        companyId,
        transactionType: 'CREDIT',
        grantKind: 'PROMOTIONAL',
        amount: 500,
        balanceBefore: 0,
        balanceAfter: 500,
        reason: 'seed a healthy balance',
        source: 'SYSTEM',
        idempotencyKey: `canary-disagree-${ts}`,
      },
    });
    // ...yet a run was recorded as blocked for insufficient credits anyway.
    await prisma.workflowRun.create({
      data: {
        companyId,
        workflowId: workflow.id,
        status: 'FAILED',
        failureClass: 'INSUFFICIENT_CREDITS',
      },
    });

    const report = await reconciliation.canaryComparisonReport(
      companyId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    expect(report.discrepancies.length).toBeGreaterThanOrEqual(1);
  });

  it('a company with no blocked runs in the window reports zero discrepancies', async () => {
    const companyId = await newCompany('clean');
    const report = await reconciliation.canaryComparisonReport(
      companyId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    expect(report.blockedRunsChecked).toBe(0);
    expect(report.discrepancies).toHaveLength(0);
  });
});
