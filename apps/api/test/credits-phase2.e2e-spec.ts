import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CreditLedgerService, InsufficientCreditsError } from '../src/modules/credits/credit-ledger.service';
import { CreditBalanceService } from '../src/modules/credits/credit-balance.service';
import { CreditCostCalculatorService } from '../src/modules/credits/credit-cost-calculator.service';
import { CreditRateAdminService } from '../src/modules/credits/credit-rate-admin.service';
import { CreditReservationService } from '../src/modules/credits/credit-reservation.service';
import { CreditReservationSweepService } from '../src/modules/credits/credit-reservation-sweep.service';

/**
 * Credit system Phase 2 (Ledger) e2e — needs live Postgres. Proves the
 * safety-critical acceptance criteria the plan names explicitly: the §12.3
 * concurrency proof, the §10.3 worked example, the LOOP-collision proof, and
 * the reservation-leak sweep's claim-exactly-once guarantee. Direct service
 * injection (no HTTP) for everything except the cron endpoint test — Phase 2
 * has zero real call sites wired to these services yet, so there is no
 * request-level surface for the rest.
 *
 * Deliberately ONE `/auth/register` call per `describe` block (not per
 * `it()`): that endpoint carries a real 10/minute-per-IP `@Throttle` (a
 * legitimate abuse control, not something to work around) — a naive
 * one-company-per-test design tripped it immediately. Tests needing a clean
 * starting balance within a block use `resetBalance`, a direct
 * `CompanyCreditBalance` write that is TEST SCAFFOLDING ONLY (never done
 * outside a test) — production code always goes through
 * `CreditLedgerService.append`.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 2 — Ledger e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: CreditLedgerService;
  let balance: CreditBalanceService;
  let calculator: CreditCostCalculatorService;
  let rateAdmin: CreditRateAdminService;
  let reservations: CreditReservationService;
  let sweep: CreditReservationSweepService;
  const ts = Date.now();

  async function newCompany(label: string): Promise<string> {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P2 ${label} ${ts}-${Math.random()}`,
        name: 'Owner',
        email: `credits_${label}_${ts}_${Math.round(Math.random() * 1e6)}@ex.com`,
        password: 'password123',
      })
      .expect(201);
    return reg.body.company.id as string;
  }

  /** Grant credits directly via the ledger (a CREDIT — no rate id required). */
  async function grant(companyId: string, amount: number, key: string): Promise<void> {
    await ledger.append({
      companyId,
      transactionType: 'CREDIT',
      amount,
      reason: 'test grant',
      source: 'SYSTEM',
      idempotencyKey: key,
    });
  }

  /** TEST SCAFFOLDING ONLY — direct cache write to give a test a known starting balance, bypassing the ledger entirely. Never done in production code. */
  async function resetBalance(companyId: string, bal: number, reservedBal = 0): Promise<void> {
    await prisma.companyCreditBalance.upsert({
      where: { companyId },
      create: { companyId, balance: bal, reservedBalance: reservedBal, updatedAt: new Date() },
      update: { balance: bal, reservedBalance: reservedBal },
    });
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
    ledger = app.get(CreditLedgerService);
    balance = app.get(CreditBalanceService);
    calculator = app.get(CreditCostCalculatorService);
    rateAdmin = app.get(CreditRateAdminService);
    reservations = app.get(CreditReservationService);
    sweep = app.get(CreditReservationSweepService);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('Task 2.1 — CreditLedgerService.append', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('ledger');
    });

    it('T2: concurrent DEBIT 50 / DEBIT 60 against balance 100 — exactly one succeeds, balance never negative', async () => {
      await resetBalance(companyId, 100);

      const results = await Promise.allSettled([
        ledger.append({
          companyId,
          transactionType: 'DEBIT',
          amount: -50,
          reason: 'concurrent A',
          source: 'SYSTEM',
          idempotencyKey: `debitA:${randomUUID()}`,
          modelCostRateId: 'test-rate',
        }),
        ledger.append({
          companyId,
          transactionType: 'DEBIT',
          amount: -60,
          reason: 'concurrent B',
          source: 'SYSTEM',
          idempotencyKey: `debitB:${randomUUID()}`,
          modelCostRateId: 'test-rate',
        }),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsError);

      const final = await balance.getBalance(companyId);
      expect(final.balance).toBeGreaterThanOrEqual(0);
      expect([50, 40]).toContain(final.balance); // 100-50 or 100-60
    });

    it('T1: duplicate idempotencyKey returns the identical row with zero additional balance mutation', async () => {
      await resetBalance(companyId, 100);
      const key = `dup:${randomUUID()}`;
      const first = await ledger.append({
        companyId,
        transactionType: 'DEBIT',
        amount: -10,
        reason: 'first',
        source: 'SYSTEM',
        idempotencyKey: key,
        modelCostRateId: 'test-rate',
      });
      const second = await ledger.append({
        companyId,
        transactionType: 'DEBIT',
        amount: -10,
        reason: 'second (duplicate)',
        source: 'SYSTEM',
        idempotencyKey: key,
        modelCostRateId: 'test-rate',
      });
      expect(second.id).toBe(first.id);
      const final = await balance.getBalance(companyId);
      expect(final.balance).toBe(90); // only ONE debit applied
    });

    it('floor-guard rejects insufficient balance with zero rows written', async () => {
      await resetBalance(companyId, 10);
      const key = `toomuch:${randomUUID()}`;
      await expect(
        ledger.append({
          companyId,
          transactionType: 'DEBIT',
          amount: -50,
          reason: 'too much',
          source: 'SYSTEM',
          idempotencyKey: key,
          modelCostRateId: 'test-rate',
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError);
      const rows = await prisma.creditLedger.count({ where: { companyId, idempotencyKey: key } });
      expect(rows).toBe(0);
      const final = await balance.getBalance(companyId);
      expect(final.balance).toBe(10); // unchanged
    });

    it('missing rate-id throws for DEBIT/RESERVATION', async () => {
      await resetBalance(companyId, 100);
      await expect(
        ledger.append({
          companyId,
          transactionType: 'DEBIT',
          amount: -10,
          reason: 'no rate',
          source: 'SYSTEM',
          idempotencyKey: `norate:${randomUUID()}`,
        }),
      ).rejects.toThrow(/requires a non-null modelCostRateId or toolCostRateId/);
    });

    it('a negative ADJUSTMENT is floor-guarded exactly like a DEBIT — never drives balance negative', async () => {
      await resetBalance(companyId, 30);
      const key = `adj-too-much:${randomUUID()}`;
      await expect(
        ledger.append({
          companyId,
          transactionType: 'ADJUSTMENT',
          amount: -50,
          reason: 'correction larger than balance',
          source: 'SYSTEM',
          idempotencyKey: key,
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError);
      const rows = await prisma.creditLedger.count({ where: { companyId, idempotencyKey: key } });
      expect(rows).toBe(0);
      expect((await balance.getBalance(companyId)).balance).toBe(30); // unchanged, never negative

      // A negative ADJUSTMENT within the balance succeeds normally.
      await ledger.append({
        companyId,
        transactionType: 'ADJUSTMENT',
        amount: -20,
        reason: 'correction within balance',
        source: 'SYSTEM',
        idempotencyKey: `adj-ok:${randomUUID()}`,
      });
      expect((await balance.getBalance(companyId)).balance).toBe(10);
    });
  });

  describe('Task 2.2 — CreditBalanceService', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('balance');
    });

    it('getBalance never throws for a company with no credit history', async () => {
      // Uses the real `companyId` from this block's beforeAll, BEFORE any
      // other test in this block has touched its balance — a real company
      // that has simply never had a CompanyCreditBalance row written yet.
      // (A fully made-up companyId would violate CompanyCreditBalance's real
      // FK to Company — Convention A — which is itself the correct behavior,
      // just not what this test is trying to exercise.) Must run before
      // 'zero-drift reconcile...' below, which is the only other test in
      // this block and does touch the balance.
      const snap = await balance.getBalance(companyId);
      expect(snap.balance).toBe(0);
      expect(snap.reservedBalance).toBe(0);
    });

    it('zero-drift reconcile is a no-op; a corrupted cache is corrected exactly once and idempotently', async () => {
      await prisma.creditLedger.deleteMany({ where: { companyId } }); // isolate this test's ledger sum
      await resetBalance(companyId, 0);
      await grant(companyId, 100, `grant:${randomUUID()}`);

      const clean = await balance.reconcile(companyId);
      expect(clean.corrected).toBe(false);
      expect(clean.drift).toBe(0);

      // Corrupt the cache directly (simulating drift) — never done outside tests.
      await resetBalance(companyId, 999);

      const first = await balance.reconcile(companyId);
      expect(first.corrected).toBe(true);
      expect(first.drift).toBe(100 - 999);
      const fixed = await balance.getBalance(companyId);
      expect(fixed.balance).toBe(100);

      // Idempotent: running again with the SAME (now-correct) state is a no-op —
      // the ledger sum must still equal 100, not shift with each reconcile.
      const second = await balance.reconcile(companyId);
      expect(second.corrected).toBe(false);
      expect(second.drift).toBe(0);
    });
  });

  describe('Task 2.3/2.4 — Cost calculator and rate admin', () => {
    // No company/registration needed — these operate on the global
    // ModelCostRate/ToolCostRate catalogs, not a company balance.
    it('missing-rate falls back to defaults without throwing, and seeds a real DB rate', async () => {
      const provider = `test-provider-${randomUUID()}`;
      const model = `test-model-${randomUUID()}`;
      const priced = await calculator.priceLlmCall({
        provider,
        model,
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      });
      expect(priced.credits).toBeGreaterThan(0);
      expect(priced.modelCostRateId).toBeTruthy();
      const row = await prisma.modelCostRate.findUnique({ where: { id: priced.modelCostRateId } });
      expect(row).not.toBeNull();
      expect(row!.effectiveTo).toBeNull();
    });

    it('the same (rate id, tokens) pair always reprices identically', async () => {
      const provider = `test-provider-${randomUUID()}`;
      const model = `test-model-${randomUUID()}`;
      const first = await calculator.priceLlmCall({ provider, model, promptTokens: 500, completionTokens: 200 });
      const second = await calculator.priceLlmCall({ provider, model, promptTokens: 500, completionTokens: 200 });
      expect(second.modelCostRateId).toBe(first.modelCostRateId);
      expect(second.credits).toBe(first.credits);
    });

    it('a new admin rate closes the prior one; historical ledger rows still resolve to their original (closed) rate', async () => {
      const provider = `test-provider-${randomUUID()}`;
      const model = `test-model-${randomUUID()}`;
      const original = await rateAdmin.setModelRate({
        provider,
        model,
        promptRatePer1MUsd: 1,
        completionRatePer1MUsd: 1,
        creditsPerUsd: 100,
      });
      expect(original.effectiveTo).toBeNull();

      const replacement = await rateAdmin.setModelRate({
        provider,
        model,
        promptRatePer1MUsd: 2,
        completionRatePer1MUsd: 2,
        creditsPerUsd: 100,
      });
      expect(replacement.id).not.toBe(original.id);

      const closedOriginal = await prisma.modelCostRate.findUniqueOrThrow({ where: { id: original.id } });
      expect(closedOriginal.effectiveTo).not.toBeNull();
      expect(closedOriginal.promptRatePer1MUsd.toString()).toBe('1'); // historical row unchanged

      const openReplacement = await prisma.modelCostRate.findUniqueOrThrow({ where: { id: replacement.id } });
      expect(openReplacement.effectiveTo).toBeNull();

      // At most one open row for this (provider, model) pair.
      const openCount = await prisma.modelCostRate.count({ where: { provider, model, effectiveTo: null } });
      expect(openCount).toBe(1);
    });

    it('priceToolCall returns 0 credits + null rate id for a tool with no real external cost', async () => {
      const priced = await calculator.priceToolCall({ skillKey: 'email', tool: 'send_email' });
      expect(priced.credits).toBe(0);
      expect(priced.toolCostRateId).toBeNull();
    });
  });

  describe('Task 2.5 — CreditReservationService.reserve', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('reserve');
    });

    it('LOOP-collision proof: two reservations for the same nodeId but different WorkflowStepRun.id both succeed independently', async () => {
      await resetBalance(companyId, 100);
      const runId = randomUUID();

      const r1 = await reservations.reserve({
        companyId,
        workflowRunId: runId,
        workflowStepRunId: `step-iter-1-${randomUUID()}`, // iteration 1's own row
        resourceType: 'LLM_CALL',
        estimatedCredits: 10,
        modelCostRateId: 'test-rate',
        reason: 'loop iteration 1',
      });
      const r2 = await reservations.reserve({
        companyId,
        workflowRunId: runId,
        workflowStepRunId: `step-iter-2-${randomUUID()}`, // iteration 2's own row — same nodeId conceptually, different step
        resourceType: 'LLM_CALL',
        estimatedCredits: 10,
        modelCostRateId: 'test-rate',
        reason: 'loop iteration 2',
      });

      expect(r1.outcome).toBe('created');
      expect(r2.outcome).toBe('created');
      expect(r1.reservation.id).not.toBe(r2.reservation.id);

      const snap = await balance.getBalance(companyId);
      expect(snap.balance).toBe(80); // 100 - 10 - 10
      expect(snap.reservedBalance).toBe(20);
    });

    it('a retry of the same WorkflowStepRun.id reuses the existing PENDING reservation rather than double-reserving', async () => {
      await resetBalance(companyId, 100);
      const stepId = `step-${randomUUID()}`;

      const attempt1 = await reservations.reserve({
        companyId,
        workflowStepRunId: stepId,
        resourceType: 'LLM_CALL',
        estimatedCredits: 15,
        modelCostRateId: 'test-rate',
        reason: 'attempt 1',
      });
      expect(attempt1.outcome).toBe('created');

      // Attempt 2 (a retry of the SAME logical step, lease not yet expired) —
      // must be recognised as a genuine concurrent duplicate, not a fresh
      // reservation, and must NOT double-decrement the balance.
      const attempt2 = await reservations.reserve({
        companyId,
        workflowStepRunId: stepId,
        resourceType: 'LLM_CALL',
        estimatedCredits: 15,
        modelCostRateId: 'test-rate',
        reason: 'attempt 2 (retry)',
      });
      expect(attempt2.outcome).toBe('duplicateInFlight');
      expect(attempt2.reservation.id).toBe(attempt1.reservation.id);

      const snap = await balance.getBalance(companyId);
      expect(snap.balance).toBe(85); // 100 - 15, only ONCE
      expect(snap.reservedBalance).toBe(15);
    });

    it('insufficient balance rejects with zero reservation rows created', async () => {
      await resetBalance(companyId, 5);
      const conversationId = randomUUID();
      await expect(
        reservations.reserve({
          companyId,
          conversationId,
          messageIdempotencyKey: randomUUID(),
          resourceType: 'LLM_CALL',
          estimatedCredits: 50,
          modelCostRateId: 'test-rate',
          reason: 'too much',
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsError);
      const rows = await prisma.creditReservation.count({ where: { companyId, conversationId } });
      expect(rows).toBe(0);
    });
  });

  describe('Task 2.6 — CreditReservationService.settle', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('settle');
    });

    it('reproduces the §10.3 worked example exactly: reserve 20 → settle 13 → release 7 → balance 100→80→87', async () => {
      await resetBalance(companyId, 100);

      const reserved = await reservations.reserve({
        companyId,
        conversationId: randomUUID(),
        messageIdempotencyKey: randomUUID(),
        resourceType: 'LLM_CALL',
        estimatedCredits: 20,
        modelCostRateId: 'test-rate',
        reason: 'worked example reserve',
      });
      expect(reserved.outcome).toBe('created');
      expect((await balance.getBalance(companyId)).balance).toBe(80);
      expect((await balance.getBalance(companyId)).reservedBalance).toBe(20);

      const settled = await reservations.settle({
        reservationId: reserved.reservation.id,
        companyId,
        actualCredits: 13,
        modelCostRateId: 'test-rate',
      });
      expect(settled.status).toBe('SETTLED');
      expect(settled.actualCredits).toBe(13);

      const final = await balance.getBalance(companyId);
      expect(final.balance).toBe(87);
      expect(final.reservedBalance).toBe(0);
    });

    it('T2: two concurrent settle calls for the same reservation — exactly one performs the DEBIT/RELEASE pair, the other is a clean no-op', async () => {
      await resetBalance(companyId, 100);
      const reserved = await reservations.reserve({
        companyId,
        conversationId: randomUUID(),
        messageIdempotencyKey: randomUUID(),
        resourceType: 'LLM_CALL',
        estimatedCredits: 20,
        modelCostRateId: 'test-rate',
        reason: 'settle-race reserve',
      });

      const [a, b] = await Promise.all([
        reservations.settle({
          reservationId: reserved.reservation.id,
          companyId,
          actualCredits: 13,
          modelCostRateId: 'test-rate',
        }),
        reservations.settle({
          reservationId: reserved.reservation.id,
          companyId,
          actualCredits: 13,
          modelCostRateId: 'test-rate',
        }),
      ]);
      expect(a.status).toBe('SETTLED');
      expect(b.status).toBe('SETTLED');
      expect(a.actualCredits).toBe(13);
      expect(b.actualCredits).toBe(13);

      // Exactly one DEBIT + one RELEASE row exist for this reservation, not two.
      const debits = await prisma.creditLedger.count({
        where: { reservationId: reserved.reservation.id, transactionType: 'DEBIT' },
      });
      const releases = await prisma.creditLedger.count({
        where: { reservationId: reserved.reservation.id, transactionType: 'RELEASE' },
      });
      expect(debits).toBe(1);
      expect(releases).toBe(1);
      expect((await balance.getBalance(companyId)).balance).toBe(87);
    });

    it('§40.9 guard: settle rejects when called with a DIFFERENT company\'s id — no cross-tenant settle, and the reservation stays untouched', async () => {
      await resetBalance(companyId, 100);
      const otherCompanyId = await newCompany('settle-other-tenant');

      const reserved = await reservations.reserve({
        companyId,
        conversationId: randomUUID(),
        messageIdempotencyKey: randomUUID(),
        resourceType: 'LLM_CALL',
        estimatedCredits: 20,
        modelCostRateId: 'test-rate',
        reason: 'cross-tenant settle attempt',
      });

      // Attacker/bug scenario: the reservation belongs to `companyId`, but the
      // caller (e.g. a forged/misrouted request) passes `otherCompanyId`.
      const result = await reservations.settle({
        reservationId: reserved.reservation.id,
        companyId: otherCompanyId,
        actualCredits: 13,
        modelCostRateId: 'test-rate',
      });

      // The `updateMany`'s companyId guard makes this claim zero rows, so it
      // falls into the idempotent-no-op branch and returns the reservation
      // AS-IS — still PENDING, not settled by the wrong tenant.
      expect(result.status).toBe('PENDING');
      expect(result.actualCredits).toBeNull();

      const stillPending = await prisma.creditReservation.findUniqueOrThrow({
        where: { id: reserved.reservation.id },
      });
      expect(stillPending.status).toBe('PENDING');
      expect(stillPending.companyId).toBe(companyId);

      // No DEBIT/RELEASE was posted to either company's ledger.
      const ledgerRows = await prisma.creditLedger.count({
        where: { reservationId: reserved.reservation.id, transactionType: { in: ['DEBIT', 'RELEASE'] } },
      });
      expect(ledgerRows).toBe(0);
      expect((await balance.getBalance(companyId)).balance).toBe(80); // still held, not settled
      expect((await balance.getBalance(otherCompanyId)).balance).toBe(0); // untouched
    });
  });

  describe('Task 2.7 — CreditReservationService.release', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('release');
    });

    it('release returns the full estimate; releasing an already-settled reservation is a safe no-op', async () => {
      await resetBalance(companyId, 100);
      const reserved = await reservations.reserve({
        companyId,
        conversationId: randomUUID(),
        messageIdempotencyKey: randomUUID(),
        resourceType: 'LLM_CALL',
        estimatedCredits: 30,
        modelCostRateId: 'test-rate',
        reason: 'release test',
      });
      expect((await balance.getBalance(companyId)).balance).toBe(70);

      const released = await reservations.release({
        reservationId: reserved.reservation.id,
        companyId,
        reason: 'never executed',
      });
      expect(released.status).toBe('RELEASED');
      const afterRelease = await balance.getBalance(companyId);
      expect(afterRelease.balance).toBe(100); // full amount back
      expect(afterRelease.reservedBalance).toBe(0);

      // Idempotent no-op: releasing again does nothing further.
      const releasedAgain = await reservations.release({
        reservationId: reserved.reservation.id,
        companyId,
        reason: 'duplicate release call',
      });
      expect(releasedAgain.status).toBe('RELEASED');
      expect((await balance.getBalance(companyId)).balance).toBe(100);

      // Releasing a SETTLED reservation is also a safe no-op.
      const other = await reservations.reserve({
        companyId,
        conversationId: randomUUID(),
        messageIdempotencyKey: randomUUID(),
        resourceType: 'LLM_CALL',
        estimatedCredits: 10,
        modelCostRateId: 'test-rate',
        reason: 'to be settled',
      });
      await reservations.settle({
        reservationId: other.reservation.id,
        companyId,
        actualCredits: 10,
        modelCostRateId: 'test-rate',
      });
      const noop = await reservations.release({
        reservationId: other.reservation.id,
        companyId,
        reason: 'should be a no-op',
      });
      expect(noop.status).toBe('SETTLED'); // unchanged
    });

    it('release rejects when called with a DIFFERENT company\'s id — no cross-tenant release', async () => {
      await resetBalance(companyId, 100);
      const otherCompanyId = await newCompany('release-other-tenant');

      const reserved = await reservations.reserve({
        companyId,
        conversationId: randomUUID(),
        messageIdempotencyKey: randomUUID(),
        resourceType: 'LLM_CALL',
        estimatedCredits: 25,
        modelCostRateId: 'test-rate',
        reason: 'cross-tenant release attempt',
      });
      expect((await balance.getBalance(companyId)).balance).toBe(75);

      const result = await reservations.release({
        reservationId: reserved.reservation.id,
        companyId: otherCompanyId,
        reason: 'forged/misrouted release',
      });

      // companyId guard makes the claim zero rows -> idempotent no-op as-is,
      // still PENDING, still held against the OWNING company.
      expect(result.status).toBe('PENDING');
      const stillPending = await prisma.creditReservation.findUniqueOrThrow({
        where: { id: reserved.reservation.id },
      });
      expect(stillPending.status).toBe('PENDING');
      expect((await balance.getBalance(companyId)).balance).toBe(75); // still held
      expect((await balance.getBalance(otherCompanyId)).balance).toBe(0); // untouched
    });

    it('retrying reserve() with the same key after the reservation was RELEASED is resumable — no second hold, no double reservation row', async () => {
      await resetBalance(companyId, 100);
      const conversationId = randomUUID();
      const messageIdempotencyKey = randomUUID();

      const first = await reservations.reserve({
        companyId,
        conversationId,
        messageIdempotencyKey,
        resourceType: 'LLM_CALL',
        estimatedCredits: 15,
        modelCostRateId: 'test-rate',
        reason: 'will be released then retried',
      });
      expect(first.outcome).toBe('created');

      await reservations.release({
        reservationId: first.reservation.id,
        companyId,
        reason: 'pre-provider-call failure',
      });
      expect((await balance.getBalance(companyId)).balance).toBe(100); // fully returned

      // A retry of the SAME logical call (same conversation + idempotency
      // key) re-derives the identical key. It must NOT throw and must NOT
      // silently create a second PENDING hold — §40.8/Q4(1)'s "retry after a
      // retryable failure does not orphan a fresh attempt behind a dead key".
      const retried = await reservations.reserve({
        companyId,
        conversationId,
        messageIdempotencyKey,
        resourceType: 'LLM_CALL',
        estimatedCredits: 15,
        modelCostRateId: 'test-rate',
        reason: 'retry after release',
      });
      expect(retried.outcome).toBe('resumable');
      expect(retried.reservation.id).toBe(first.reservation.id);
      expect(retried.reservation.status).toBe('RELEASED');

      const rows = await prisma.creditReservation.count({
        where: { companyId, conversationId },
      });
      expect(rows).toBe(1); // no second row was created
      expect((await balance.getBalance(companyId)).balance).toBe(100); // no second hold taken
    });
  });

  describe('Task 2.8 — Reservation-leak sweep', () => {
    let companyId: string;
    beforeAll(async () => {
      companyId = await newCompany('sweep');
    });

    it('a stale PENDING reservation is claimed exactly once even when the sweep runs twice concurrently', async () => {
      await resetBalance(companyId, 50);
      const reserved = await reservations.reserve({
        companyId,
        conversationId: randomUUID(),
        messageIdempotencyKey: randomUUID(),
        resourceType: 'LLM_CALL',
        estimatedCredits: 20,
        modelCostRateId: 'test-rate',
        reason: 'will go stale',
      });
      // Force the lease into the past so the sweep treats it as orphaned.
      await prisma.creditReservation.update({
        where: { id: reserved.reservation.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });

      const [resultA, resultB] = await Promise.all([sweep.sweep(), sweep.sweep()]);
      const totalSwept = resultA.swept + resultB.swept;
      expect(totalSwept).toBe(1); // claimed by exactly one of the two concurrent ticks

      const row = await prisma.creditReservation.findUniqueOrThrow({
        where: { id: reserved.reservation.id },
      });
      expect(row.status).toBe('RELEASED');
      expect((await balance.getBalance(companyId)).balance).toBe(50); // full amount back
    });

    it('T3: POST /admin/cron/credit-reservation-sweep with X-Cron-Secret releases a seeded stale reservation', async () => {
      const cronSecret = process.env.CRON_SECRET;
      if (!cronSecret) {
        // Matches CronController's own documented behaviour: routes are
        // disabled (not open) when CRON_SECRET is unset. Nothing to test.
        return;
      }
      await resetBalance(companyId, 50);
      const reserved = await reservations.reserve({
        companyId,
        conversationId: randomUUID(),
        messageIdempotencyKey: randomUUID(),
        resourceType: 'LLM_CALL',
        estimatedCredits: 20,
        modelCostRateId: 'test-rate',
        reason: 'seeded stale row for http sweep test',
      });
      await prisma.creditReservation.update({
        where: { id: reserved.reservation.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });

      await request(app.getHttpServer())
        .post('/admin/cron/credit-reservation-sweep')
        .set('X-Cron-Secret', cronSecret)
        .expect(200);

      const row = await prisma.creditReservation.findUniqueOrThrow({
        where: { id: reserved.reservation.id },
      });
      expect(row.status).toBe('RELEASED');
    });
  });
});
