import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CreditReservationService } from '../../src/modules/credits/credit-reservation.service';
import { CreditCostCalculatorService } from '../../src/modules/credits/credit-cost-calculator.service';

/**
 * Credit system Phase 13, Task 13.3 (§27) — validates the guarded `updateMany`
 * balance mutation under REALISTIC concurrency (50-way fan-out against one
 * balance), a much higher fan-out than the unit-level 2-way race tests
 * elsewhere in this suite. A single, isolated, throwaway company — no
 * cross-tenant concern, unlike the sweep chaos test.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 13 — balance concurrency perf', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reservations: CreditReservationService;
  let costCalculator: CreditCostCalculatorService;
  const ts = Date.now();
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
    reservations = app.get(CreditReservationService);
    costCalculator = app.get(CreditCostCalculatorService);

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P13 perf ${ts}`,
        name: 'Owner',
        email: `p13perf_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    companyId = reg.body.company.id as string;
  });

  afterAll(async () => {
    await prisma.creditReservation.deleteMany({ where: { companyId } });
    await prisma.creditLedger.deleteMany({ where: { companyId } });
    await prisma.companyCreditBalance.deleteMany({ where: { companyId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  });

  it('50 concurrent reservation attempts against a 1000-credit balance never go negative and never lose an update', async () => {
    const STARTING_BALANCE = 1000;
    const PER_RESERVATION = 25;
    const FANOUT = 50; // 50 * 25 = 1250 > 1000, so some MUST be rejected

    await prisma.companyCreditBalance.upsert({
      where: { companyId },
      create: { companyId, balance: STARTING_BALANCE, reservedBalance: 0, updatedAt: new Date() },
      update: { balance: STARTING_BALANCE, reservedBalance: 0 },
    });

    const priced = await costCalculator.priceLlmCall({
      provider: 'mock',
      model: 'mock',
      promptTokens: 1,
      completionTokens: 1,
    });

    const attempts = Array.from({ length: FANOUT }, () =>
      reservations
        .reserve({
          companyId,
          resourceType: 'LLM_CALL',
          estimatedCredits: PER_RESERVATION,
          modelCostRateId: priced.modelCostRateId,
          reason: 'Phase 13 concurrency perf test',
          messageIdempotencyKey: randomUUID(),
        })
        .then(() => 'succeeded' as const)
        .catch(() => 'rejected' as const),
    );

    const outcomes = await Promise.all(attempts);
    const succeeded = outcomes.filter((o) => o === 'succeeded').length;
    const rejected = outcomes.filter((o) => o === 'rejected').length;

    expect(succeeded + rejected).toBe(FANOUT);
    // At 25 credits each against 1000, at most 40 can succeed — never more.
    expect(succeeded).toBeLessThanOrEqual(Math.floor(STARTING_BALANCE / PER_RESERVATION));

    const finalBalance = await prisma.companyCreditBalance.findUnique({ where: { companyId } });
    expect(Number(finalBalance?.balance)).toBeGreaterThanOrEqual(0);
    expect(Number(finalBalance?.reservedBalance)).toBeGreaterThanOrEqual(0);

    // No lost updates: exactly `succeeded` RESERVATION rows exist, and the
    // balance drop matches exactly (balance + reservedBalance === starting).
    const reservationRows = await prisma.creditReservation.count({ where: { companyId, status: 'PENDING' } });
    expect(reservationRows).toBe(succeeded);
    expect(Number(finalBalance?.balance) + Number(finalBalance?.reservedBalance)).toBe(STARTING_BALANCE);
  }, 30_000);
});
