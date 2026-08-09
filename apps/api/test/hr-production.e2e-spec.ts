import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * HR production verification e2e — locks the leave.create audit gap
 * (doc 27 §HR-06 mandates `full` audit on the request, not only the decision).
 * The AI_EMPLOYEE_STEP approval boundary (doc 27 §0.3) is locked deterministically
 * by the unit test `tool-executor.service.spec.ts` (forceApproval), which does not
 * depend on the mock LLM choosing to emit a tool call.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('HR production verification', () => {
  let app: INestApplication;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let ownerToken = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'HR Prod Co', name: 'Owner', email: `hrprod_${ts}@example.com`, password })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('leave.create AND leave.decide both write an audit entry with an actor', async () => {
    const staff = await request(app.getHttpServer())
      .post('/hr/staff')
      .set(bearer(ownerToken))
      .send({ fullName: 'Leave Tester', workEmail: 'lt@acme.com' })
      .expect(201);

    const leave = await request(app.getHttpServer())
      .post('/hr/leave')
      .set(bearer(ownerToken))
      .send({
        staffId: staff.body.id,
        leaveType: 'ANNUAL',
        startDate: '2026-09-01',
        endDate: '2026-09-02',
        days: 2,
        reason: 'family',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/hr/leave/${leave.body.id}/decide`)
      .set(bearer(ownerToken))
      .send({ status: 'APPROVED' })
      .expect(201);

    const audit = await request(app.getHttpServer())
      .get('/audit-log')
      .set(bearer(ownerToken))
      .expect(200);
    const rows: { action: string; entityId: string; actorUserId: string | null }[] =
      Array.isArray(audit.body) ? audit.body : audit.body.items;
    const forLeave = rows.filter((r) => r.entityId === leave.body.id);
    expect(
      forLeave.some((r) => r.action === 'leave.create' && Boolean(r.actorUserId)),
    ).toBe(true);
    expect(
      forLeave.some((r) => r.action === 'leave.decide' && Boolean(r.actorUserId)),
    ).toBe(true);
  }, 30_000);
});
