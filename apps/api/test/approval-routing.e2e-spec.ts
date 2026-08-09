import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ApprovalService } from '../src/modules/approvals/approval.service';

// Approval routing + canDecide (R12) e2e: needs a live Postgres + Redis (BullMQ).
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RunBody {
  id: string;
  status: string;
}

describeIfDb('Approval routing + canDecide/R12 e2e (P3-05 §8.1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerToken = '';
  let member1Token = '';
  let member2Token = '';
  let companyId = '';
  let member1Id = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Routing E2E', name: 'Owner', email: `route_owner_${ts}@ex.com`, password })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;

    const mkMember = async (n: number): Promise<{ token: string; id: string }> => {
      const email = `route_m${n}_${ts}@ex.com`;
      const created = await request(app.getHttpServer())
        .post('/users')
        .set(bearer(ownerToken))
        .send({ email, name: `Member ${n}`, role: 'MEMBER', password })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(201);
      return { token: login.body.tokens.accessToken, id: created.body.id };
    };
    const m1 = await mkMember(1);
    const m2 = await mkMember(2);
    member1Token = m1.token;
    member1Id = m1.id;
    member2Token = m2.token;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Create a workflow (TRIGGER → APPROVAL[routing?] → NOOP) and run it to WAITING. */
  const runApprovalWorkflow = async (
    approvalConfig: Record<string, unknown>,
  ): Promise<{ runId: string; approvalId: string }> => {
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(ownerToken))
      .send({
        name: `route-wf-${Math.round(Date.now())}-${Math.random()}`,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'APPROVAL', config: approvalConfig },
            { id: 'n3', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' },
          ],
        },
      })
      .expect(201);

    const start = await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/run`)
      .set(bearer(ownerToken))
      .send({ trigger: {} })
      .expect(201);
    const runId = start.body.id as string;

    const deadline = Date.now() + 20_000;
    let status = start.body.status as string;
    while (Date.now() < deadline && status !== 'WAITING') {
      const r = await request(app.getHttpServer()).get(`/workflows/runs/${runId}`).set(bearer(ownerToken));
      status = (r.body as RunBody).status;
      if (status === 'WAITING' || status === 'COMPLETED' || status === 'FAILED') break;
      await sleep(250);
    }
    expect(status).toBe('WAITING');
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { companyId, workflowRunId: runId, status: 'PENDING' },
    });
    return { runId, approvalId: approval.id };
  };

  const pollTerminal = async (runId: string): Promise<string> => {
    const deadline = Date.now() + 20_000;
    let status = 'RUNNING';
    while (Date.now() < deadline) {
      const r = await request(app.getHttpServer()).get(`/workflows/runs/${runId}`).set(bearer(ownerToken));
      status = (r.body as RunBody).status;
      if (status === 'COMPLETED' || status === 'FAILED') break;
      await sleep(250);
    }
    return status;
  };

  it('UNROUTED request: a MEMBER is 403; OWNER can decide (R12 §8.1.11 regression, over HTTP)', async () => {
    const { runId, approvalId } = await runApprovalWorkflow({ message: 'Approve?' });
    // The row is unrouted.
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.approverRuleType).toBeNull();
    expect(row.chainId).toBe(approvalId);

    // A MEMBER must NOT be able to decide an unrouted request — exactly today's rule.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`)
      .set(bearer(member1Token))
      .send({})
      .expect(403);

    // OWNER can, and the run resumes.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`)
      .set(bearer(ownerToken))
      .send({})
      .expect(201);
    expect(await pollTerminal(runId)).toBe('COMPLETED');
  }, 40_000);

  it('USER-routed request: only the routed member may decide (not another member, not even the owner)', async () => {
    const { runId, approvalId } = await runApprovalWorkflow({
      message: 'Approve?',
      routing: { levels: [{ rule: 'USER', target: member1Id }] },
    });
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.approverRuleType).toBe('USER');
    expect(row.approverRuleValue).toBe(member1Id);

    // Not the routed member → 403.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/reject`)
      .set(bearer(member2Token))
      .send({})
      .expect(403);
    // The routing is specific: even OWNER isn't the named USER → 403 (doc 08 §8.1.7 canDecide).
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`)
      .set(bearer(ownerToken))
      .send({})
      .expect(403);
    // The routed member decides → run resumes.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`)
      .set(bearer(member1Token))
      .send({})
      .expect(201);
    expect(await pollTerminal(runId)).toBe('COMPLETED');

    // History has exactly the one (now APPROVED) row for this chain.
    const history = await request(app.getHttpServer())
      .get(`/approvals/${approvalId}/history`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].status).toBe('APPROVED');
  }, 40_000);

  it('multi-level chain: level 1 approval opens level 2; the run resumes only after the final level', async () => {
    const { runId, approvalId } = await runApprovalWorkflow({
      message: 'Two-level sign-off',
      routing: { levels: [{ rule: 'USER', target: member1Id }, { rule: 'ANY_ADMIN' }] },
    });

    // Level 1 (routed to member1) approved → run STAYS waiting; a level-2 row opens.
    await request(app.getHttpServer())
      .post(`/approvals/${approvalId}/approve`)
      .set(bearer(member1Token))
      .send({})
      .expect(201);
    await sleep(500);
    const runMid = await request(app.getHttpServer()).get(`/workflows/runs/${runId}`).set(bearer(ownerToken));
    expect((runMid.body as RunBody).status).toBe('WAITING'); // not resumed yet

    const level2 = await prisma.approvalRequest.findFirstOrThrow({
      where: { companyId, chainId: approvalId, level: 2, status: 'PENDING' },
    });
    expect(level2.approverRuleType).toBe('ANY_ADMIN');

    // Level 2 is ANY_ADMIN: member1 can't decide it, the owner can.
    await request(app.getHttpServer())
      .post(`/approvals/${level2.id}/approve`)
      .set(bearer(member1Token))
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post(`/approvals/${level2.id}/approve`)
      .set(bearer(ownerToken))
      .send({})
      .expect(201);
    expect(await pollTerminal(runId)).toBe('COMPLETED');

    // History reads the whole chain: level 1 + level 2, both APPROVED.
    const history = await request(app.getHttpServer())
      .get(`/approvals/${level2.id}/history`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body.map((r: { status: string }) => r.status)).toEqual(['APPROVED', 'APPROVED']);
  }, 40_000);

  it('TOOL-kind routing: an employee\'s approvalRules.routing gates the tool approval', async () => {
    // An AI Employee whose high-risk tool calls route to member1 specifically.
    const employee = await prisma.aiEmployee.create({
      data: {
        companyId,
        name: 'Routed Bot',
        role: 'SALES',
        approvalRules: { routing: { levels: [{ rule: 'USER', target: member1Id }] } },
      },
    });

    // createRequest is the TOOL-kind entry the runtime uses (invoked directly here).
    const approvals = app.get(ApprovalService);
    const req = await approvals.createRequest({
      companyId,
      employeeId: employee.id,
      skillKey: 'slack',
      tool: 'send_message',
      args: { channel: '#deals', text: 'hi' },
    });
    // The row was routed from the employee's rules (not unrouted).
    expect(req.approverRuleType).toBe('USER');
    expect(req.approverRuleValue).toBe(member1Id);
    expect(req.chainId).toBe(req.id);

    // A non-routed member (and even the owner) can't decide; the routed member can.
    await request(app.getHttpServer())
      .post(`/approvals/${req.id}/approve`)
      .set(bearer(member2Token))
      .send({})
      .expect(403);
    const done = await request(app.getHttpServer())
      .post(`/approvals/${req.id}/approve`)
      .set(bearer(member1Token))
      .send({})
      .expect(201);
    expect(done.body.status).toBe('APPROVED');
  }, 40_000);
});
