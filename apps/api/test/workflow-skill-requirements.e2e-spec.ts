import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type {
  WorkflowSkillRequirementDto,
  WorkflowSkillRequirementsDto,
} from '@vaep/types';
import { AppModule } from '../src/app.module';

// Verifies the machine-readable workflow SKILL-DEPENDENCY surface
// (GET /workflows/:id/skill-requirements, doc 30 §12): capability-first
// detection, existing-connection reuse, and tenant isolation. Mode-independent
// — the endpoint reports true readiness regardless of SKILL_EXECUTOR, so it runs
// green under the CI `mock` executor. (The publish-time BLOCK is real-mode-only
// and is covered by the SkillRequirementsService unit spec.)
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Workflow skill requirements (in-chat connection surface)', () => {
  let app: INestApplication;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let workflowId = '';

  const graph = {
    nodes: [
      { id: 'trigger', type: 'TRIGGER', config: {} },
      {
        id: 'send',
        type: 'TOOL_ACTION',
        config: {
          skillKey: 'gmail',
          tool: 'send_email',
          args: { to: 'a@b.com', subject: 'Hi', body: 'x' },
          outputKey: 'sent',
        },
      },
    ],
    edges: [{ from: 'trigger', to: 'send' }],
  };

  const gmailReq = (body: WorkflowSkillRequirementsDto): WorkflowSkillRequirementDto => {
    const req = body.requirements.find((r) => r.skillKey === 'gmail');
    if (!req) throw new Error('expected a gmail requirement');
    return req;
  };

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
      .send({ companyName: 'Reqs Co', name: 'Owner', email: `reqs_owner_${ts}@ex.com`, password })
      .expect(201);
    token = reg.body.tokens.accessToken;

    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: `reqs-${ts}`, definition: graph })
      .expect(201);
    workflowId = created.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('detects the gmail dependency capability-first and reports it NOT_CONNECTED', async () => {
    const res = await request(app.getHttpServer())
      .get(`/workflows/${workflowId}/skill-requirements`)
      .set(bearer(token))
      .expect(200);

    const gmail = gmailReq(res.body);
    expect(gmail).toBeDefined();
    expect(gmail.capabilities).toEqual(['EMAIL_SEND']);
    expect(gmail.compatibleSkillKeys).toContain('email');
    expect(gmail.provider).toBe('google');
    expect(gmail.requiresConnection).toBe(true);
    expect(gmail.status).toBe('NOT_CONNECTED');
    expect(gmail.canManageConnection).toBe(true); // owner
    expect(res.body.allRequiredReady).toBe(false);
    expect(res.body.missingRequiredCount).toBe(1);
  });

  it('reuses an existing connection: once gmail is connected the requirement is READY', async () => {
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'gmail' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/skills/installed/${installed.body.id}/connect`)
      .set(bearer(token))
      .send({ credentials: { accessToken: 'ya29-test' } })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/workflows/${workflowId}/skill-requirements`)
      .set(bearer(token))
      .expect(200);

    const gmail = gmailReq(res.body);
    expect(gmail.status).toBe('READY');
    expect(gmail.installedSkillId).toBe(installed.body.id);
    expect(res.body.allRequiredReady).toBe(true);
    expect(res.body.missingRequiredCount).toBe(0);
  });

  it('never leaks another tenant’s workflow requirements (404)', async () => {
    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Other Co', name: 'Owner', email: `reqs_other_${ts}@ex.com`, password })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/workflows/${workflowId}/skill-requirements`)
      .set(bearer(other.body.tokens.accessToken))
      .expect(404);
  });
});
