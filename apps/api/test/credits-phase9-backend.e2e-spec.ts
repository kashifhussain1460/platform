import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Credit system Phase 9 (Frontend) — the two backend reads its UI needs:
 * `GET /billing/credit-packs` (catalog, any member) and
 * `GET /billing/credits/usage` (row-level ledger, OWNER/ADMIN only).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 9 — backend reads e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const companyIds: string[] = [];
  const password = 'password123';

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
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
  });

  afterAll(async () => {
    if (companyIds.length > 0) {
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.companyCreditBalance.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  it('GET /billing/credit-packs lists the seeded active catalog', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P9 packs ${ts}`,
        name: 'Owner',
        email: `p9packs_${ts}@example.com`,
        password,
      })
      .expect(201);
    companyIds.push(reg.body.company.id as string);
    const ownerToken = reg.body.tokens.accessToken as string;

    const res = await request(app.getHttpServer())
      .get('/billing/credit-packs')
      .set(bearer(ownerToken))
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        packKey: expect.any(String),
        creditAmount: expect.any(Number),
        priceUsd: expect.any(Number),
      }),
    );
  });

  it('GET /billing/credits/usage: OWNER sees rows, MEMBER is 403', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P9 usage ${ts}`,
        name: 'Owner',
        email: `p9usage_${ts}@example.com`,
        password,
      })
      .expect(201);
    const companyId = reg.body.company.id as string;
    companyIds.push(companyId);
    const ownerToken = reg.body.tokens.accessToken as string;

    await prisma.companyCreditBalance.upsert({
      where: { companyId },
      create: { companyId, balance: 100, reservedBalance: 0, updatedAt: new Date() },
      update: { balance: 100 },
    });
    await prisma.creditLedger.create({
      data: {
        companyId,
        transactionType: 'CREDIT',
        grantKind: 'PROMOTIONAL',
        amount: 100,
        balanceBefore: 0,
        balanceAfter: 100,
        reason: 'test seed',
        source: 'ADMIN',
        idempotencyKey: `p9usage-seed-${ts}`,
      },
    });

    const ownerRes = await request(app.getHttpServer())
      .get('/billing/credits/usage')
      .set(bearer(ownerToken))
      .expect(200);
    expect(ownerRes.body.length).toBeGreaterThanOrEqual(1);
    expect(ownerRes.body[0]).toEqual(
      expect.objectContaining({ companyId, transactionType: 'CREDIT' }),
    );

    const memberEmail = `p9member_${ts}@example.com`;
    await request(app.getHttpServer())
      .post('/users')
      .set(bearer(ownerToken))
      .send({ email: memberEmail, name: 'Member', role: 'MEMBER', password })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password })
      .expect(201);
    const memberToken = login.body.tokens.accessToken as string;

    await request(app.getHttpServer())
      .get('/billing/credits/usage')
      .set(bearer(memberToken))
      .expect(403);
  });
});
