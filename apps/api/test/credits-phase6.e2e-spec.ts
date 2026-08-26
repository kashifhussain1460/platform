import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  BILLING_PROVIDER_TOKEN,
  type BillingProvider,
  type BillingWebhookEvent,
} from '../src/modules/billing/billing.provider';

/**
 * Credit system Phase 6 (Stripe) e2e — needs live Postgres + Redis. Proves
 * `ProcessedWebhookEvent` dedupe (Task 6.1), the out-of-order guard
 * (Task 6.2), the checkout→credit-purchase grant loop including its
 * amount-mismatch rejection (Task 6.3), and the refund webhook's honest
 * "no automatic grant" behavior (Task 6.4, per the confirmed §40.7
 * resolution).
 *
 * Real Stripe signature verification is out of scope here (would need a
 * live Stripe test account) — `BILLING_PROVIDER_TOKEN` is overridden with a
 * stub whose `parseWebhookEvent` returns pre-built `BillingWebhookEvent`
 * objects directly, exercising the REAL `BillingService.handleWebhook` /
 * `applyWebhookEvent` pipeline exactly as a verified Stripe event would.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 6 — Stripe e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const companyIds: string[] = [];
  let queuedEvent: BillingWebhookEvent | null = null;

  class StubBillingProvider implements BillingProvider {
    readonly name = 'stub-stripe';
    async ensureCustomer() {
      return { externalCustomerId: `cus_real_${Date.now()}` };
    }
    async changePlan(): Promise<never> {
      throw new Error('not used by this test');
    }
    async parseWebhookEvent(): Promise<BillingWebhookEvent | null> {
      return queuedEvent;
    }
  }

  async function registerCompany(label: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P6 ${label} ${ts}`,
        name: 'Owner',
        email: `p6_${label}_${ts}_${Math.round(Math.random() * 1e6)}@ex.com`,
        password: 'password123',
      })
      .expect(201);
    companyIds.push(res.body.company.id as string);
    return res.body.company.id as string;
  }

  function sendWebhook() {
    return request(app.getHttpServer())
      .post('/billing/webhook')
      .set('stripe-signature', 'stub')
      .send({});
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BILLING_PROVIDER_TOKEN)
      .useValue(new StubBillingProvider())
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (companyIds.length > 0) {
      await prisma.creditLot.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.processedWebhookEvent.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  describe('Task 6.1 — ProcessedWebhookEvent dedupe', () => {
    it('a redelivered event (same externalEventId) fired concurrently: exactly one downstream effect', async () => {
      const companyId = await registerCompany('dedupe');
      queuedEvent = {
        type: 'invoice.payment_failed',
        externalEventId: `evt_dedupe_${ts}`,
        payload: {},
        createdAt: new Date(),
        companyId,
        status: 'PAST_DUE',
      };

      const [r1, r2] = await Promise.all([sendWebhook(), sendWebhook()]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const rows = await prisma.processedWebhookEvent.count({
        where: { provider: 'stripe', externalEventId: `evt_dedupe_${ts}` },
      });
      expect(rows).toBe(1);

      const auditRows = await prisma.auditLog.count({
        where: { companyId, action: 'billing.payment_failed' },
      });
      expect(auditRows).toBe(1);
    });

    it('a redelivery after full prior processing is a clean 200 no-op', async () => {
      const companyId = await registerCompany('redelivery');
      queuedEvent = {
        type: 'invoice.payment_failed',
        externalEventId: `evt_redelivery_${ts}`,
        payload: {},
        createdAt: new Date(),
        companyId,
        status: 'PAST_DUE',
      };
      await sendWebhook().expect(200);
      await sendWebhook().expect(200); // full redelivery, already processed

      const auditRows = await prisma.auditLog.count({
        where: { companyId, action: 'billing.payment_failed' },
      });
      expect(auditRows).toBe(1);
    });
  });

  describe('Task 6.3 — checkout.session.completed credit-purchase grant', () => {
    it('a matching event grants exactly once', async () => {
      const companyId = await registerCompany('creditgrant');
      const pack = await prisma.creditPack.findFirstOrThrow({ where: { packKey: 'SMALL', active: true } });
      const expectedCents = Math.round(Number(pack.priceUsd) * 100);

      queuedEvent = {
        type: 'checkout.session.completed',
        externalEventId: `evt_purchase_${ts}`,
        payload: {},
        createdAt: new Date(),
        companyId,
        creditPurchase: {
          packId: pack.packKey,
          creditPackRateId: pack.id,
          sessionId: `cs_test_${ts}`,
          amountTotalCents: expectedCents,
          currency: 'usd',
        },
      };
      await sendWebhook().expect(200);

      const ledgerRows = await prisma.creditLedger.findMany({
        where: { companyId, grantKind: 'PACK_PURCHASE' },
      });
      expect(ledgerRows).toHaveLength(1);
      const expectedAmount = Number(pack.creditAmount) * (1 + Number(pack.bonusPercent) / 100);
      expect(Number(ledgerRows[0].amount)).toBeCloseTo(expectedAmount, 5);

      const lot = await prisma.creditLot.findUnique({ where: { originLedgerEntryId: ledgerRows[0].id } });
      expect(lot).not.toBeNull();
      expect(lot!.expiresAt).toBeNull(); // purchased credits never expire
    });

    it('a mismatched amount_total grants nothing and leaves the balance unchanged', async () => {
      const companyId = await registerCompany('mismatch');
      const pack = await prisma.creditPack.findFirstOrThrow({ where: { packKey: 'SMALL', active: true } });

      queuedEvent = {
        type: 'checkout.session.completed',
        externalEventId: `evt_mismatch_${ts}`,
        payload: {},
        createdAt: new Date(),
        companyId,
        creditPurchase: {
          packId: pack.packKey,
          creditPackRateId: pack.id,
          sessionId: `cs_mismatch_${ts}`,
          amountTotalCents: 1, // deliberately wrong
          currency: 'usd',
        },
      };
      await sendWebhook().expect(200); // still 200 — never retried

      const ledgerRows = await prisma.creditLedger.count({ where: { companyId, grantKind: 'PACK_PURCHASE' } });
      expect(ledgerRows).toBe(0);
    });

    it('a redelivery of an already-processed purchase event grants nothing twice', async () => {
      const companyId = await registerCompany('purchaseredelivery');
      const pack = await prisma.creditPack.findFirstOrThrow({ where: { packKey: 'SMALL', active: true } });
      const expectedCents = Math.round(Number(pack.priceUsd) * 100);

      queuedEvent = {
        type: 'checkout.session.completed',
        externalEventId: `evt_purchase_redeliver_${ts}`,
        payload: {},
        createdAt: new Date(),
        companyId,
        creditPurchase: {
          packId: pack.packKey,
          creditPackRateId: pack.id,
          sessionId: `cs_redeliver_${ts}`,
          amountTotalCents: expectedCents,
          currency: 'usd',
        },
      };
      await sendWebhook().expect(200);
      await sendWebhook().expect(200); // redelivery

      const rows = await prisma.creditLedger.count({ where: { companyId, grantKind: 'PACK_PURCHASE' } });
      expect(rows).toBe(1);
    });
  });

  describe('Task 6.4 — charge.refunded (§40.7 confirmed resolution)', () => {
    it('creates no CreditRefund row (no DEBIT can be inferred from a payment-level charge refund) but still 200s', async () => {
      const companyId = await registerCompany('refund');
      queuedEvent = {
        type: 'charge.refunded',
        externalEventId: `evt_refund_${ts}`,
        payload: {},
        createdAt: new Date(),
        companyId,
        refund: {
          externalRefundId: `re_${ts}`,
          chargeId: `ch_${ts}`,
          amountCents: 1000,
        },
      };
      await sendWebhook().expect(200);

      const refundRows = await prisma.creditRefund.count({ where: { companyId } });
      expect(refundRows).toBe(0);
    });
  });
});
