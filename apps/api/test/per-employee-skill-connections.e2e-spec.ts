import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Needs a live Postgres + Redis, same convention as skills.e2e-spec.ts.
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Per-employee skill connections e2e (two mailboxes, correct routing)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `per_employee_skill_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  const auth: Record<string, string> = {};
  let hrEmployeeId = '';
  let hrConnectorId = '';
  let hrWorkflowId = '';
  let companyWideConnectorId = '';
  let companyWideWorkflowId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Per-Employee Skill E2E Co', name: 'Owner', email, password })
      .expect(201);
    auth.Authorization = `Bearer ${res.body.tokens.accessToken}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sets up an HR-owned Gmail connection and a company-wide Gmail connection', async () => {
    const hr = await request(app.getHttpServer())
      .post('/employees')
      .set(auth)
      .send({ name: 'HR AI', role: 'HR', persona: 'HR assistant.' })
      .expect(201);
    hrEmployeeId = hr.body.id;

    const hrInstall = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth)
      .send({ skillKey: 'gmail', employeeId: hrEmployeeId })
      .expect(201);
    hrConnectorId = hrInstall.body.id;

    const companyInstall = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth)
      .send({ skillKey: 'gmail' })
      .expect(201);
    companyWideConnectorId = companyInstall.body.id;

    expect(hrConnectorId).not.toBe(companyWideConnectorId);
  });

  it('creates one workflow scoped to the HR connector and one scoped to the company-wide connector', async () => {
    const hrWf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth)
      .send({
        name: 'HR mailbox workflow',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'n', type: 'NOTIFY', config: { message: 'HR mail arrived' } },
          ],
          edges: [{ from: 't', to: 'n' }],
        },
      })
      .expect(201);
    hrWorkflowId = hrWf.body.id;
    await request(app.getHttpServer())
      .patch(`/workflows/${hrWorkflowId}`)
      .set(auth)
      .send({
        triggerType: 'EVENT',
        triggerConfig: { eventType: 'NEW_EMAIL', connectorId: hrConnectorId },
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${hrWorkflowId}/activate`)
      .set(auth)
      .expect(200);

    const companyWf = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth)
      .send({
        name: 'Company-wide mailbox workflow',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'n', type: 'NOTIFY', config: { message: 'company mail arrived' } },
          ],
          edges: [{ from: 't', to: 'n' }],
        },
      })
      .expect(201);
    companyWideWorkflowId = companyWf.body.id;
    await request(app.getHttpServer())
      .patch(`/workflows/${companyWideWorkflowId}`)
      .set(auth)
      .send({
        triggerType: 'EVENT',
        triggerConfig: { eventType: 'NEW_EMAIL', connectorId: companyWideConnectorId },
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${companyWideWorkflowId}/activate`)
      .set(auth)
      .expect(200);
  });

  it('an event from the HR connector fires only the HR-scoped workflow', async () => {
    const fired = await request(app.getHttpServer())
      .post('/workflows/events')
      .set(auth)
      .send({ eventType: 'NEW_EMAIL', payload: { eventId: 'evt_hr_1' }, connectorId: hrConnectorId })
      .expect(200);
    expect(fired.body.runIds).toHaveLength(1);
    const run = await prisma.workflowRun.findUnique({ where: { id: fired.body.runIds[0] } });
    expect(run?.workflowId).toBe(hrWorkflowId);
  });

  it('an event from the company-wide connector fires only the company-wide-scoped workflow', async () => {
    const fired = await request(app.getHttpServer())
      .post('/workflows/events')
      .set(auth)
      .send({ eventType: 'NEW_EMAIL', payload: { eventId: 'evt_co_1' }, connectorId: companyWideConnectorId })
      .expect(200);
    expect(fired.body.runIds).toHaveLength(1);
    const run = await prisma.workflowRun.findUnique({ where: { id: fired.body.runIds[0] } });
    expect(run?.workflowId).toBe(companyWideWorkflowId);
  });
});
