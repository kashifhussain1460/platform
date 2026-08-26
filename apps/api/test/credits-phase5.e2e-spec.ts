import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CreditPackCatalogService } from '../src/modules/billing/credit-packs';
import {
  BILLING_PROVIDER_TOKEN,
  type BillingProvider,
} from '../src/modules/billing/billing.provider';

/**
 * Credit system Phase 5 (PAYG) e2e — needs live Postgres + Redis. Proves the
 * `CreditPack` catalog (Task 5.1), the purchase endpoint's "creates a
 * Checkout Session, mints zero credits" contract (Task 5.2), and its
 * per-company throttle (Task 5.3).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 5 — PAYG e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let packCatalog: CreditPackCatalogService;
  const ts = Date.now();
  const companyIds: string[] = [];

  async function registerCompany(label: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P5 ${label} ${ts}`,
        name: 'Owner',
        email: `p5_${label}_${ts}_${Math.round(Math.random() * 1e6)}@ex.com`,
        password: 'password123',
      })
      .expect(201);
    companyIds.push(res.body.company.id as string);
    return {
      companyId: res.body.company.id as string,
      accessToken: res.body.tokens.accessToken as string,
    };
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
    packCatalog = app.get(CreditPackCatalogService);
  });

  afterAll(async () => {
    delete process.env.CREDIT_PAYG_ENABLED;
    if (companyIds.length > 0) {
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  describe('Task 5.1 — CreditPack catalog', () => {
    it('listActive() returns only active, currently-effective packs, seeded on boot', async () => {
      const packs = await packCatalog.listActive();
      expect(packs.length).toBeGreaterThanOrEqual(3);
      expect(packs.every((p) => p.active)).toBe(true);
      const keys = packs.map((p) => p.packKey);
      expect(keys).toEqual(expect.arrayContaining(['SMALL', 'MEDIUM', 'LARGE']));
    });

    it('is idempotent — seeding twice does not duplicate rows', async () => {
      const before = (await packCatalog.listActive()).length;
      await packCatalog.onModuleInit();
      const after = (await packCatalog.listActive()).length;
      expect(after).toBe(before);
    });
  });

  describe('Task 5.2/5.3 — purchase endpoint', () => {
    it('under mock (CREDIT_PAYG_ENABLED unset): returns {checkoutUrl:null} without calling Stripe, and creates zero CreditLedger rows', async () => {
      delete process.env.CREDIT_PAYG_ENABLED;
      const { companyId, accessToken } = await registerCompany('mockpurchase');
      const res = await request(app.getHttpServer())
        .post('/billing/credits/purchase')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ packId: 'SMALL' })
        .expect(201);
      expect(res.body.checkoutUrl).toBeNull();

      const rows = await prisma.creditLedger.count({ where: { companyId } });
      expect(rows).toBe(0);
    });

    it('rejects an unknown packId', async () => {
      const { accessToken } = await registerCompany('badpack');
      await request(app.getHttpServer())
        .post('/billing/credits/purchase')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ packId: 'NOT_A_REAL_PACK' })
        .expect(400);
    });

    it('a MEMBER gets 403; an OWNER gets 201', async () => {
      const { accessToken: ownerToken } = await registerCompany('roles');
      const memberEmail = `p5_member_${ts}@ex.com`;
      await request(app.getHttpServer())
        .post('/users')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Mo Member', email: memberEmail, password: 'password123', role: 'MEMBER' })
        .expect(201);
      const memberLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: memberEmail, password: 'password123' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/billing/credits/purchase')
        .set('Authorization', `Bearer ${memberLogin.body.tokens.accessToken}`)
        .send({ packId: 'SMALL' })
        .expect(403);

      await request(app.getHttpServer())
        .post('/billing/credits/purchase')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ packId: 'SMALL' })
        .expect(201);
    });

    it('the 11th request within 60s from one company is throttled', async () => {
      const { accessToken } = await registerCompany('throttle');
      for (let i = 0; i < 10; i += 1) {
        await request(app.getHttpServer())
          .post('/billing/credits/purchase')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ packId: 'SMALL' })
          .expect(201);
      }
      await request(app.getHttpServer())
        .post('/billing/credits/purchase')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ packId: 'SMALL' })
        .expect(429);
    });
  });

  describe('Task 5.2 — stubbed Stripe provider', () => {
    let stubApp: INestApplication;
    let stubPrisma: PrismaService;
    const capturedSessions: Array<{ metadata: Record<string, unknown> }> = [];

    class StubBillingProvider implements BillingProvider {
      readonly name = 'stub-stripe';
      async ensureCustomer() {
        return { externalCustomerId: `cus_real_${Date.now()}` };
      }
      async changePlan(): Promise<never> {
        throw new Error('not used by this test');
      }
      async createCreditCheckoutSession(input: {
        externalCustomerId: string;
        companyId: string;
        packId: string;
        creditPackRateId: string;
        stripePriceId: string;
      }) {
        capturedSessions.push({
          metadata: {
            companyId: input.companyId,
            packId: input.packId,
            creditPackRateId: input.creditPackRateId,
          },
        });
        return { url: 'https://checkout.stripe.example/session/stub_123' };
      }
    }

    beforeAll(async () => {
      // Seed a real stripePriceId for SMALL so purchaseCredits() doesn't 400.
      await prisma.creditPack.updateMany({
        where: { packKey: 'SMALL' },
        data: { stripePriceId: 'price_stub_small' },
      });
      process.env.CREDIT_PAYG_ENABLED = 'true';

      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(BILLING_PROVIDER_TOKEN)
        .useValue(new StubBillingProvider())
        .compile();
      stubApp = moduleRef.createNestApplication();
      stubApp.use(cookieParser());
      stubApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await stubApp.init();
      stubPrisma = stubApp.get(PrismaService);
    });

    afterAll(async () => {
      delete process.env.CREDIT_PAYG_ENABLED;
      await prisma.creditPack.updateMany({
        where: { packKey: 'SMALL' },
        data: { stripePriceId: null },
      });
      await stubApp?.close();
    });

    it('an ADMIN gets a session URL with creditPackRateId in its metadata', async () => {
      const reg = await request(stubApp.getHttpServer())
        .post('/auth/register')
        .send({
          companyName: `Credits P5 stub ${ts}`,
          name: 'Owner',
          email: `p5_stub_${ts}_${Math.round(Math.random() * 1e6)}@ex.com`,
          password: 'password123',
        })
        .expect(201);
      const companyId = reg.body.company.id as string;
      companyIds.push(companyId);
      const accessToken = reg.body.tokens.accessToken as string;

      const res = await request(stubApp.getHttpServer())
        .post('/billing/credits/purchase')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ packId: 'SMALL' })
        .expect(201);

      expect(res.body.checkoutUrl).toBe('https://checkout.stripe.example/session/stub_123');
      const captured = capturedSessions.find((s) => s.metadata.companyId === companyId);
      expect(captured).toBeDefined();
      expect(captured!.metadata.creditPackRateId).toEqual(expect.any(String));

      const rows = await stubPrisma.creditLedger.count({ where: { companyId } });
      expect(rows).toBe(0); // no ledger effect from the purchase endpoint itself
    });
  });
});
