import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PlatformAdminAuthService } from '../src/modules/billing/platform-admin/platform-admin-auth.service';

/**
 * Credit system Phase 10 (Admin/Finance), Task 10.1 + 10.2 e2e — the
 * PlatformOperator identity axis + PlatformAdminGuard, and the manual credit
 * adjustment endpoint.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 10 — Admin/Finance e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let platformAdminAuth: PlatformAdminAuthService;
  const ts = Date.now();
  const companyIds: string[] = [];
  const operatorIds: string[] = [];

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function newCompany(label: string): Promise<{ companyId: string; ownerToken: string; ownerEmail: string }> {
    const email = `p10_${label}_${ts}_${Math.round(Math.random() * 1e6)}@example.com`;
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: `Credits P10 ${label} ${ts}`, name: 'Owner', email, password: 'password123' })
      .expect(201);
    const companyId = reg.body.company.id as string;
    companyIds.push(companyId);
    return { companyId, ownerToken: reg.body.tokens.accessToken as string, ownerEmail: email };
  }

  async function newOperator(label: string): Promise<string> {
    const operator = await prisma.platformOperator.create({
      data: { email: `op_${label}_${ts}@orlixa.internal`, name: `Operator ${label}` },
    });
    operatorIds.push(operator.id);
    return platformAdminAuth.issueToken(operator.id);
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
    platformAdminAuth = app.get(PlatformAdminAuthService);
  });

  afterAll(async () => {
    if (companyIds.length > 0) {
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.auditLog.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.companyCreditBalance.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    if (operatorIds.length > 0) {
      await prisma.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
    }
    await app?.close();
  });

  describe('Task 10.1 — PlatformAdminGuard', () => {
    it("a company OWNER's JWT is rejected 401, never reaching role logic", async () => {
      const { companyId, ownerToken } = await newCompany('guardowner');
      await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(ownerToken))
        .set('Idempotency-Key', 'k1')
        .send({ amount: 100, reason: 'owner token should not work' })
        .expect(401);
    });

    it('a valid operator token passes the guard', async () => {
      const { companyId } = await newCompany('guardop');
      const token = await newOperator('guardop');
      const res = await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(token))
        .set('Idempotency-Key', 'k1')
        .send({ amount: 100, reason: 'valid operator token' })
        .expect(201);
      expect(res.body.ledgerEntryId).toBeDefined();
      expect(res.body.auditLogId).toBeDefined();
    });

    it('no token at all is rejected 401', async () => {
      const { companyId } = await newCompany('guardnone');
      await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set('Idempotency-Key', 'k1')
        .send({ amount: 100, reason: 'no token at all here' })
        .expect(401);
    });
  });

  describe('Task 10.2 — manual credit adjustment', () => {
    it('self-adjustment is 403 regardless of amount', async () => {
      const { companyId, ownerEmail } = await newCompany('selfadj');
      const operator = await prisma.platformOperator.create({
        data: { email: ownerEmail, name: 'Self Conflict Operator' },
      });
      operatorIds.push(operator.id);
      const token = await platformAdminAuth.issueToken(operator.id);

      await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(token))
        .set('Idempotency-Key', 'k1')
        .send({ amount: 1, reason: 'trying to self-adjust' })
        .expect(403);
    });

    it('missing/short reason is 400', async () => {
      const { companyId } = await newCompany('shortreason');
      const token = await newOperator('shortreason');

      await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(token))
        .set('Idempotency-Key', 'k1')
        .send({ amount: 100, reason: 'short' })
        .expect(400);

      await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(token))
        .set('Idempotency-Key', 'k2')
        .send({ amount: 100 })
        .expect(400);
    });

    it('missing Idempotency-Key header is 400', async () => {
      const { companyId } = await newCompany('noidemkey');
      const token = await newOperator('noidemkey');

      await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(token))
        .send({ amount: 100, reason: 'no idempotency key header' })
        .expect(400);
    });

    it('a duplicate key is a no-op returning the first result', async () => {
      const { companyId } = await newCompany('dupkey');
      const token = await newOperator('dupkey');

      const first = await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(token))
        .set('Idempotency-Key', 'dup-1')
        .send({ amount: 250, reason: 'first submission of this key' })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(token))
        .set('Idempotency-Key', 'dup-1')
        .send({ amount: 250, reason: 'first submission of this key' })
        .expect(201);

      expect(second.body.ledgerEntryId).toBe(first.body.ledgerEntryId);
      expect(second.body.auditLogId).toBe(first.body.auditLogId);

      const rows = await prisma.creditLedger.findMany({ where: { companyId, transactionType: 'ADJUSTMENT' } });
      expect(rows).toHaveLength(1);
    });

    it('two concurrent identical-key submissions produce exactly one ledger row', async () => {
      const { companyId } = await newCompany('concurrentadj');
      const token = await newOperator('concurrentadj');

      const [a, b] = await Promise.all([
        request(app.getHttpServer())
          .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
          .set(bearer(token))
          .set('Idempotency-Key', 'concurrent-1')
          .send({ amount: 500, reason: 'concurrent submission race test' }),
        request(app.getHttpServer())
          .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
          .set(bearer(token))
          .set('Idempotency-Key', 'concurrent-1')
          .send({ amount: 500, reason: 'concurrent submission race test' }),
      ]);

      expect(a.body.ledgerEntryId).toBe(b.body.ledgerEntryId);
      const rows = await prisma.creditLedger.findMany({
        where: { companyId, transactionType: 'ADJUSTMENT' },
      });
      expect(rows).toHaveLength(1);
    });

    it('response returns both ledgerEntryId and auditLogId per §31.5', async () => {
      const { companyId } = await newCompany('shape');
      const token = await newOperator('shape');

      const res = await request(app.getHttpServer())
        .post(`/internal/platform-admin/companies/${companyId}/credits/adjustments`)
        .set(bearer(token))
        .set('Idempotency-Key', 'k1')
        .send({ amount: 42, reason: 'checking the response shape' })
        .expect(201);

      expect(typeof res.body.ledgerEntryId).toBe('string');
      expect(typeof res.body.auditLogId).toBe('string');

      const ledgerEntry = await prisma.creditLedger.findUnique({ where: { id: res.body.ledgerEntryId } });
      expect(ledgerEntry?.transactionType).toBe('ADJUSTMENT');
      expect(ledgerEntry?.grantKind).toBe('MANUAL_ADMIN');
    });
  });
});
