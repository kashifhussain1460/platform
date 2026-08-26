import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SubscriptionCreditRenewalService } from '../src/modules/credits/subscription-credit-renewal.service';
import { EnterpriseCreditAgreementService } from '../src/modules/credits/enterprise-credit-agreement.service';
import {
  BILLING_PROVIDER_TOKEN,
  type BillingProvider,
  type BillingWebhookEvent,
} from '../src/modules/billing/billing.provider';

/**
 * Credit system Phase 7 (Subscription Credits) e2e — needs live Postgres +
 * Redis. Proves the plan catalog extension (Task 7.1), the Stripe renewal
 * grant loop (Task 7.2), the mock-subscription cron fallback (Task 7.3),
 * and the EnterpriseCreditAgreement recurring cron (Task 7.4).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 7 — Subscription Credits e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let renewal: SubscriptionCreditRenewalService;
  let enterpriseAgreement: EnterpriseCreditAgreementService;
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
        companyName: `Credits P7 ${label} ${ts}`,
        name: 'Owner',
        email: `p7_${label}_${ts}_${Math.round(Math.random() * 1e6)}@ex.com`,
        password: 'password123',
      })
      .expect(201);
    companyIds.push(res.body.company.id as string);
    return {
      companyId: res.body.company.id as string,
      accessToken: res.body.tokens.accessToken as string,
    };
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
    renewal = app.get(SubscriptionCreditRenewalService);
    enterpriseAgreement = app.get(EnterpriseCreditAgreementService);
  });

  afterAll(async () => {
    if (companyIds.length > 0) {
      await prisma.creditLot.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.enterpriseCreditAgreement.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  describe('Task 7.1 — PLAN_CATALOG extension', () => {
    it('GET /billing/plans includes includedCreditsPerMonth for every tier; STARTER is null', async () => {
      const { accessToken } = await registerCompany('catalog');
      const res = await request(app.getHttpServer())
        .get('/billing/plans')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const starter = res.body.find((p: { plan: string }) => p.plan === 'STARTER');
      const pro = res.body.find((p: { plan: string }) => p.plan === 'PRO');
      expect(starter.includedCreditsPerMonth).toBeNull();
      expect(pro.includedCreditsPerMonth).toBeGreaterThan(0);
    });
  });

  describe('Task 7.2 — invoice.payment_succeeded renewal grant', () => {
    it('a subscription_cycle event grants once', async () => {
      const { companyId } = await registerCompany('cycle');
      await prisma.subscription.update({ where: { companyId }, data: { plan: 'PRO' } });

      queuedEvent = {
        type: 'invoice.payment_succeeded',
        externalEventId: `evt_cycle_${ts}`,
        payload: {},
        createdAt: new Date(),
        companyId,
        subscriptionRenewal: { currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      };
      await sendWebhook().expect(200);

      const rows = await prisma.creditLedger.count({ where: { companyId, grantKind: 'PLAN_ALLOTMENT' } });
      expect(rows).toBe(1);
    });

    it('a redelivered cycle event grants nothing twice', async () => {
      const { companyId } = await registerCompany('cycleredeliver');
      await prisma.subscription.update({ where: { companyId }, data: { plan: 'PRO' } });

      queuedEvent = {
        type: 'invoice.payment_succeeded',
        externalEventId: `evt_cycle_redeliver_${ts}`,
        payload: {},
        createdAt: new Date(),
        companyId,
        subscriptionRenewal: { currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      };
      await sendWebhook().expect(200);
      await sendWebhook().expect(200);

      const rows = await prisma.creditLedger.count({ where: { companyId, grantKind: 'PLAN_ALLOTMENT' } });
      expect(rows).toBe(1);
    });
  });

  describe('Task 7.3 — mock-subscription renewal cron fallback', () => {
    it('a due mock company gets exactly one grant and its currentPeriodEnd advances; a same-tick re-run does not double-grant', async () => {
      const { companyId } = await registerCompany('mockrenewal');
      const stalePeriodEnd = new Date(Date.now() - 1000);
      await prisma.subscription.update({
        where: { companyId },
        data: { plan: 'PRO', provider: 'mock', currentPeriodEnd: stalePeriodEnd },
      });

      await renewal.grantDuePeriods();
      const afterFirst = await prisma.subscription.findUniqueOrThrow({ where: { companyId } });
      expect(afterFirst.currentPeriodEnd!.getTime()).toBeGreaterThan(stalePeriodEnd.getTime());

      const grantsAfterFirst = await prisma.creditLedger.count({
        where: { companyId, grantKind: 'PLAN_ALLOTMENT' },
      });
      expect(grantsAfterFirst).toBe(1);

      // The subscription is no longer due (period just advanced) — a second
      // sweep tick must not grant again.
      await renewal.grantDuePeriods();
      const grantsAfterSecond = await prisma.creditLedger.count({
        where: { companyId, grantKind: 'PLAN_ALLOTMENT' },
      });
      expect(grantsAfterSecond).toBe(1);
    });
  });

  describe('Task 7.4 — EnterpriseCreditAgreement recurring cron', () => {
    it('a new agreement grants on its first due period; a same-period re-run does not double-grant', async () => {
      const { companyId } = await registerCompany('enterprise');
      await prisma.enterpriseCreditAgreement.create({
        data: {
          companyId,
          includedCreditsPerPeriod: 50_000,
          periodMonths: 1,
          dealReference: 'PO-TEST-1',
          approvedByUserId: 'test-approver',
          startsAt: new Date(Date.now() - 1000),
          active: true,
        },
      });

      await enterpriseAgreement.grantDuePeriods();
      const grantsAfterFirst = await prisma.creditLedger.count({
        where: { companyId, grantKind: 'ENTERPRISE_ALLOTMENT' },
      });
      expect(grantsAfterFirst).toBe(1);

      await enterpriseAgreement.grantDuePeriods();
      const grantsAfterSecond = await prisma.creditLedger.count({
        where: { companyId, grantKind: 'ENTERPRISE_ALLOTMENT' },
      });
      expect(grantsAfterSecond).toBe(1);

      const agreement = await prisma.enterpriseCreditAgreement.findUniqueOrThrow({
        where: { companyId },
      });
      expect(agreement.lastGrantedPeriodStart).not.toBeNull();
    });
  });
});
