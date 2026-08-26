import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CreditRollupService } from '../src/modules/credits/credit-rollup.service';
import { PlatformAdminAuthService } from '../src/modules/billing/platform-admin/platform-admin-auth.service';

/** Credit system Phase 10, Task 10.4 — the nightly finance rollup. */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 10 — finance rollup e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rollup: CreditRollupService;
  let platformAdminAuth: PlatformAdminAuthService;
  const ts = Date.now();
  const companyIds: string[] = [];
  const operatorIds: string[] = [];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    rollup = app.get(CreditRollupService);
    platformAdminAuth = app.get(PlatformAdminAuthService);
  });

  afterAll(async () => {
    if (companyIds.length > 0) {
      await prisma.creditUsageDailyRollup.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    if (operatorIds.length > 0) {
      await prisma.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
    }
    await app?.close();
  });

  it('rollup sums match a raw ledger sum for a seeded day', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P10 rollup ${ts}`,
        name: 'Owner',
        email: `p10rollup_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    const companyId = reg.body.company.id as string;
    companyIds.push(companyId);

    const day = new Date();
    await prisma.creditLedger.createMany({
      data: [
        {
          companyId,
          transactionType: 'CREDIT',
          grantKind: 'PROMOTIONAL',
          amount: 1000,
          balanceBefore: 0,
          balanceAfter: 1000,
          reason: 'seed grant',
          source: 'SYSTEM',
          idempotencyKey: `rollup-credit-${ts}`,
        },
        {
          companyId,
          transactionType: 'DEBIT',
          amount: -300,
          balanceBefore: 1000,
          balanceAfter: 700,
          reason: 'seed spend',
          source: 'SYSTEM',
          idempotencyKey: `rollup-debit-${ts}`,
        },
        {
          companyId,
          transactionType: 'REFUND',
          amount: 50,
          balanceBefore: 700,
          balanceAfter: 750,
          reason: 'seed refund',
          source: 'SYSTEM',
          idempotencyKey: `rollup-refund-${ts}`,
        },
        {
          companyId,
          transactionType: 'ADJUSTMENT',
          grantKind: 'MANUAL_ADMIN',
          amount: -20,
          balanceBefore: 750,
          balanceAfter: 730,
          reason: 'seed manual adjustment (gap fix regression)',
          source: 'ADMIN',
          idempotencyKey: `rollup-adjustment-${ts}`,
        },
      ],
    });

    await rollup.runNightly(day);

    const rows = await rollup.query({ companyId });
    const companyRow = rows.find((r) => r.employeeId === null);
    expect(companyRow?.creditsGranted).toBe(1000);
    expect(companyRow?.creditsConsumed).toBe(300);
    expect(companyRow?.creditsRefunded).toBe(50);
    // Gap fix regression: a manual ADJUSTMENT must appear in the rollup
    // (previously silently dropped), signed since a correction can go
    // either direction.
    expect(companyRow?.creditsAdjusted).toBe(-20);

    // Cross-check directly against the raw ledger sum.
    const rawSum = await prisma.creditLedger.aggregate({
      where: { companyId, transactionType: 'DEBIT' },
      _sum: { amount: true },
    });
    expect(Math.abs(Number(rawSum._sum.amount))).toBe(companyRow?.creditsConsumed);
  });

  it('FinanceReportingController is PlatformAdminGuard-only and labels the response', async () => {
    const operator = await prisma.platformOperator.create({
      data: { email: `p10financeop_${ts}@orlixa.internal`, name: 'Finance Operator' },
    });
    operatorIds.push(operator.id);
    const token = await platformAdminAuth.issueToken(operator.id);

    await request(app.getHttpServer()).get('/internal/platform-admin/finance/rollup').expect(401);

    const res = await request(app.getHttpServer())
      .get('/internal/platform-admin/finance/rollup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.note).toMatch(/estimated/i);
  });
});
