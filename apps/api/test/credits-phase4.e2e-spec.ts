import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ToolExecutorService } from '../src/modules/employees/runtime/tool-executor.service';
import { CreditLedgerService } from '../src/modules/credits/credit-ledger.service';

/**
 * Credit system Phase 4 (Free Credits) e2e — needs live Postgres + Redis.
 * Proves the onboarding-complete grant (Task 4.4), its two abuse gates
 * (Tasks 4.2/4.3 — domain velocity + disposable email), and the expanded
 * approval gate for credit-only companies (Task 4.5).
 *
 * `CREDIT_GRANTS_ENABLED`/`FREE_GRANT_DOMAIN_CAP` are read live from
 * `process.env` (never cached at boot), so tests toggle them directly.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 4 — Free Credits e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let toolExecutor: ToolExecutorService;
  let ledger: CreditLedgerService;
  const ts = Date.now();
  const companyIds: string[] = [];

  async function registerCompany(emailLocal: string, domain = 'example.com') {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P4 ${emailLocal} ${ts}`,
        name: 'Owner',
        email: `${emailLocal}_${ts}_${Math.round(Math.random() * 1e6)}@${domain}`,
        password: 'password123',
      })
      .expect(201);
    companyIds.push(res.body.company.id as string);
    return {
      companyId: res.body.company.id as string,
      accessToken: res.body.tokens.accessToken as string,
    };
  }

  function completeOnboarding(accessToken: string) {
    return request(app.getHttpServer())
      .post('/onboarding/complete')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        business: { industry: 'SaaS' },
        departments: [],
        employees: [],
      })
      .expect(201);
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
    toolExecutor = app.get(ToolExecutorService);
    ledger = app.get(CreditLedgerService);
  });

  afterAll(async () => {
    delete process.env.CREDIT_GRANTS_ENABLED;
    delete process.env.FREE_GRANT_DOMAIN_CAP;
    if (companyIds.length > 0) {
      await prisma.creditLot.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.creditLedger.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.companyCreditBalance.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    await app?.close();
  });

  it('flag OFF (default): onboarding-complete grants nothing', async () => {
    delete process.env.CREDIT_GRANTS_ENABLED;
    const { companyId, accessToken } = await registerCompany('flagoff');
    await completeOnboarding(accessToken);
    const rows = await prisma.creditLedger.count({ where: { companyId } });
    expect(rows).toBe(0);
  });

  it('flag ON: a fresh company gets exactly one FREE_SIGNUP grant, reflected in GET /billing/credits', async () => {
    process.env.CREDIT_GRANTS_ENABLED = 'true';
    process.env.FREE_GRANT_DOMAIN_CAP = '100'; // high enough this test never trips the cap
    const { companyId, accessToken } = await registerCompany('flagon', 'freegrant-test.example');
    await completeOnboarding(accessToken);

    const ledgerRows = await prisma.creditLedger.findMany({
      where: { companyId, grantKind: 'FREE_SIGNUP' },
    });
    expect(ledgerRows).toHaveLength(1);
    expect(Number(ledgerRows[0].amount)).toBeGreaterThan(0);

    const lot = await prisma.creditLot.findUnique({
      where: { originLedgerEntryId: ledgerRows[0].id },
    });
    expect(lot).not.toBeNull();
    expect(lot!.expiresAt).not.toBeNull();

    const res = await request(app.getHttpServer())
      .get('/billing/credits')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.balance).toBe(Number(ledgerRows[0].amount));
  });

  it('IDEM: completing onboarding twice (the existing idempotent-retry path) grants exactly once', async () => {
    process.env.CREDIT_GRANTS_ENABLED = 'true';
    process.env.FREE_GRANT_DOMAIN_CAP = '100';
    const { companyId, accessToken } = await registerCompany('idem', 'idem-grant-test.example');
    await completeOnboarding(accessToken);
    await completeOnboarding(accessToken); // already onboarded — early-returns before the grant code

    const rows = await prisma.creditLedger.count({ where: { companyId, grantKind: 'FREE_SIGNUP' } });
    expect(rows).toBe(1);
  });

  it('disposable email domain: onboarding completes normally but no grant is made', async () => {
    process.env.CREDIT_GRANTS_ENABLED = 'true';
    process.env.FREE_GRANT_DOMAIN_CAP = '100';
    const { companyId, accessToken } = await registerCompany('disposable', 'mailinator.com');
    const res = await completeOnboarding(accessToken);
    expect(res.body.company.onboardedAt).not.toBeNull(); // onboarding itself never blocks

    const rows = await prisma.creditLedger.count({ where: { companyId } });
    expect(rows).toBe(0);
  });

  it('domain-velocity cap: the (N+1)th signup from one domain within 24h completes onboarding but gets no grant', async () => {
    process.env.CREDIT_GRANTS_ENABLED = 'true';
    process.env.FREE_GRANT_DOMAIN_CAP = '1';
    const domain = `velocity-${ts}.example`;

    const first = await registerCompany('velocity1', domain);
    await completeOnboarding(first.accessToken);
    const firstGrants = await prisma.creditLedger.count({
      where: { companyId: first.companyId, grantKind: 'FREE_SIGNUP' },
    });
    expect(firstGrants).toBe(1);

    const second = await registerCompany('velocity2', domain);
    const res = await completeOnboarding(second.accessToken);
    expect(res.body.company.onboardedAt).not.toBeNull(); // still completes

    const secondGrants = await prisma.creditLedger.count({
      where: { companyId: second.companyId, grantKind: 'FREE_SIGNUP' },
    });
    expect(secondGrants).toBe(0);
  });

  describe('Task 4.5 — approval-gate expansion for credit-only companies', () => {
    it("a credit-only company's Gmail-send call (normally unattended) now routes to ApprovalRequest", async () => {
      const { companyId } = await registerCompany('creditonly', 'credit-only-test.example');
      // No PACK_PURCHASE/SUBSCRIPTION_GRANT/ENTERPRISE_ALLOTMENT row exists for
      // this company — isCreditOnlyCompany() should read this as true.
      const call = await toolExecutor.call(
        { companyId, employeeId: 'e1' },
        { id: 'e1', companyId },
        'gmail',
        'send_email',
        { to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
      );
      expect(call.pendingApproval).toBe(true);
      expect(call.ok).toBe(false);
    });

    it('the same call for a company with a real paid grant does NOT route to approval', async () => {
      const { companyId } = await registerCompany('paidco', 'paid-test.example');
      await ledger.append({
        companyId,
        transactionType: 'CREDIT',
        grantKind: 'PACK_PURCHASE',
        amount: 500,
        reason: 'test pack purchase',
        source: 'SYSTEM',
        idempotencyKey: `test-pack-${companyId}`,
      });

      // No employeeId: the company-wide manual path — bypasses the
      // employee-skill-grant check entirely, so this proves ONLY the
      // credit-only gate, not skill assignment (a separate concern).
      const call = await toolExecutor.call(
        { companyId },
        { id: 'e1', companyId },
        'gmail',
        'send_email',
        { to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
      );
      expect(call.pendingApproval).toBeFalsy();
      expect(call.ok).toBe(true);
    });
  });
});
