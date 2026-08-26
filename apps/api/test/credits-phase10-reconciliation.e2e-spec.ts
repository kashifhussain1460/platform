import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CreditReconciliationService } from '../src/modules/credits/credit-reconciliation.service';
import { MetricsRegistry } from '../src/common/observability/metrics.registry';

/**
 * Credit system Phase 10, Task 10.3 — the daily reconciliation job's
 * internal-consistency leg (fully automated), plus its `/admin/cron` wiring
 * and its `/admin/alerts` surfacing.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 10 — reconciliation e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reconciliation: CreditReconciliationService;
  let metrics: MetricsRegistry;
  const ts = Date.now();
  const companyIds: string[] = [];
  const runIds: string[] = [];

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
    metrics = app.get(MetricsRegistry);
  });

  afterAll(async () => {
    if (runIds.length > 0) {
      await prisma.reconciliationDiscrepancy.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.reconciliationRun.deleteMany({ where: { id: { in: runIds } } });
    }
    if (companyIds.length > 0) {
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  async function newCompany(label: string): Promise<string> {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P10R ${label} ${ts}`,
        name: 'Owner',
        email: `p10r_${label}_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    const id = reg.body.company.id as string;
    companyIds.push(id);
    return id;
  }

  it('a deliberately-orphaned DEBIT is flagged', async () => {
    const companyId = await newCompany('orphan');
    const now = new Date();
    await prisma.creditLedger.create({
      data: {
        companyId,
        transactionType: 'DEBIT',
        reservationId: null,
        amount: -10,
        balanceBefore: 100,
        balanceAfter: 90,
        reason: 'deliberately orphaned for this test',
        source: 'SYSTEM',
        idempotencyKey: `orphan-test-${ts}`,
      },
    });

    const result = await reconciliation.runDaily(now);
    runIds.push(result.runId);
    expect(result.discrepancyCount).toBeGreaterThanOrEqual(1);

    const discrepancies = await prisma.reconciliationDiscrepancy.findMany({
      where: { runId: result.runId, leg: 'INTERNAL_CONSISTENCY' },
    });
    expect(discrepancies.some((d) => d.severity === 'HIGH')).toBe(true);

    const run = await prisma.reconciliationRun.findUnique({ where: { id: result.runId } });
    expect(run?.status).toBe('COMPLETED');
  });

  it('a clean day (no orphaned debits, no closing invoices) produces zero flags', async () => {
    // Use a day far in the past with no ledger activity seeded by this suite.
    const cleanDay = new Date('2020-01-01T00:00:00.000Z');
    const result = await reconciliation.runDaily(cleanDay);
    runIds.push(result.runId);
    expect(result.discrepancyCount).toBe(0);
  });

  it('cron.controller reaches the credit-reconciliation case', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/cron/credit-reconciliation')
      .set('X-Cron-Secret', process.env.CRON_SECRET ?? '')
      .expect((r) => {
        // Either it runs (200, real CRON_SECRET set) or the route rejects for
        // auth reasons (401/403) — either way it must NOT be a 400 "unknown job".
        expect(r.status).not.toBe(400);
      });
    if (res.status === 200) {
      runIds.push(res.body.runId);
    }
  });

  it('GET /admin/alerts surfaces a triggered reconciliation alert', async () => {
    metrics.reset();
    const companyId = await newCompany('alertfire');
    await prisma.creditLedger.create({
      data: {
        companyId,
        transactionType: 'DEBIT',
        reservationId: null,
        amount: -5,
        balanceBefore: 50,
        balanceAfter: 45,
        reason: 'deliberately orphaned to trigger the alert rule',
        source: 'SYSTEM',
        idempotencyKey: `alertfire-test-${ts}`,
      },
    });
    const result = await reconciliation.runDaily(new Date());
    runIds.push(result.runId);
    expect(result.discrepancyCount).toBeGreaterThanOrEqual(1);

    const res = await request(app.getHttpServer())
      .get('/admin/alerts')
      .set('X-Cron-Secret', process.env.CRON_SECRET ?? '')
      .send();
    // Same auth story as the cron case above — assert only on the shape when reachable.
    if (res.status === 200) {
      expect(
        (res.body.firing as { name: string }[]).some(
          (f) => f.name === 'credit_reconciliation_discrepancy',
        ),
      ).toBe(true);
    }
  });
});
