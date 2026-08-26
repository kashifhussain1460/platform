import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PlatformAdminAuthService } from '../src/modules/billing/platform-admin/platform-admin-auth.service';

/**
 * Credit system Phase 12 (Rollout), Task 12.1 — the enforcement-cohort
 * admin surface: `PATCH /internal/platform-admin/companies/:companyId/credit-enforcement`.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 12 — enforcement-cohort e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
    platformAdminAuth = app.get(PlatformAdminAuthService);
  });

  afterAll(async () => {
    if (companyIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { companyId: { in: companyIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    }
    if (operatorIds.length > 0) {
      await prisma.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
    }
    await app?.close();
  });

  async function newCompany(label: string): Promise<{ companyId: string; ownerToken: string }> {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P12 ${label} ${ts}`,
        name: 'Owner',
        email: `p12_${label}_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    const companyId = reg.body.company.id as string;
    companyIds.push(companyId);
    return { companyId, ownerToken: reg.body.tokens.accessToken as string };
  }

  async function newOperatorToken(label: string): Promise<string> {
    const operator = await prisma.platformOperator.create({
      data: { email: `p12op_${label}_${ts}@orlixa.internal`, name: `Operator ${label}` },
    });
    operatorIds.push(operator.id);
    return platformAdminAuth.issueToken(operator.id);
  }

  it("a company OWNER's JWT cannot flip enforcement (401)", async () => {
    const { companyId, ownerToken } = await newCompany('ownerdenied');
    await request(app.getHttpServer())
      .patch(`/internal/platform-admin/companies/${companyId}/credit-enforcement`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ enabled: true })
      .expect(401);
  });

  it('a valid operator token enrolls, then reverts, a company', async () => {
    const { companyId } = await newCompany('enrolltest');
    const token = await newOperatorToken('enrolltest');

    const before = await prisma.company.findUnique({ where: { id: companyId } });
    expect(before?.creditEnforcementEnabledAt).toBeNull();

    const enrolled = await request(app.getHttpServer())
      .patch(`/internal/platform-admin/companies/${companyId}/credit-enforcement`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true })
      .expect(200);
    expect(enrolled.body.creditEnforcementEnabledAt).not.toBeNull();

    const afterEnroll = await prisma.company.findUnique({ where: { id: companyId } });
    expect(afterEnroll?.creditEnforcementEnabledAt).not.toBeNull();

    const reverted = await request(app.getHttpServer())
      .patch(`/internal/platform-admin/companies/${companyId}/credit-enforcement`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: false })
      .expect(200);
    expect(reverted.body.creditEnforcementEnabledAt).toBeNull();

    const afterRevert = await prisma.company.findUnique({ where: { id: companyId } });
    expect(afterRevert?.creditEnforcementEnabledAt).toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { companyId, entityType: 'Company' },
    });
    expect(audits.some((a) => a.action === 'credits.enforcement_enrolled')).toBe(true);
    expect(audits.some((a) => a.action === 'credits.enforcement_reverted')).toBe(true);
  });
});
