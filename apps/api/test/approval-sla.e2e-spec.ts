import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ApprovalSlaService } from '../src/modules/approvals/sla/approval-sla.service';

// Approval SLA sweep e2e (P3-05 §8.2): needs live Postgres + Redis (BullMQ).
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('Approval SLA sweep e2e (P3-05 §8.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sla: ApprovalSlaService;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerToken = '';
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
    sla = app.get(ApprovalSlaService);

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'SLA E2E', name: 'Owner', email: `sla_owner_${ts}@ex.com`, password })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;

    const email = `sla_m1_${ts}@ex.com`;
    const created = await request(app.getHttpServer())
      .post('/users')
      .set(bearer(ownerToken))
      .send({ email, name: 'Member 1', role: 'MEMBER', password })
      .expect(201);
    member1Id = created.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Run a TRIGGER → APPROVAL[routing] → NOOP workflow to WAITING; return run + approval. */
  const runRoutedApproval = async (
    routing: Record<string, unknown>,
  ): Promise<{ runId: string; approvalId: string }> => {
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(ownerToken))
      .send({
        name: `sla-wf-${Math.round(Date.now())}-${Math.random()}`,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'APPROVAL', config: { message: 'Approve?', routing } },
            { id: 'n3', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }],
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
      status = r.body.status;
      if (status === 'WAITING' || status === 'COMPLETED' || status === 'FAILED') break;
      await sleep(250);
    }
    expect(status).toBe('WAITING');
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { companyId, workflowRunId: runId, status: 'PENDING' },
    });
    return { runId, approvalId: approval.id };
  };

  const backdate = (id: string) =>
    prisma.approvalRequest.update({ where: { id }, data: { dueAt: new Date(Date.now() - 60_000) } });

  const runStatus = async (runId: string): Promise<string> => {
    const deadline = Date.now() + 20_000;
    let status = 'RUNNING';
    while (Date.now() < deadline) {
      const r = await request(app.getHttpServer()).get(`/workflows/runs/${runId}`).set(bearer(ownerToken));
      status = r.body.status;
      if (status === 'COMPLETED' || status === 'FAILED') break;
      await sleep(250);
    }
    return status;
  };

  it('escalates a breached level to its next tier (routed member → ANY_ADMIN)', async () => {
    const { runId, approvalId } = await runRoutedApproval({
      levels: [
        {
          rule: 'USER',
          target: member1Id,
          slaMinutes: 60,
          escalationChain: [{ rule: 'ANY_ADMIN' }],
          onTimeout: 'NONE',
        },
      ],
    });
    await backdate(approvalId);

    const { processed } = await sla.sweep();
    expect(processed).toBeGreaterThanOrEqual(1);

    const level1 = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(level1.status).toBe('ESCALATED');
    expect(level1.escalatedToId).toBeTruthy();

    const tier1 = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: level1.escalatedToId! } });
    expect(tier1.status).toBe('PENDING');
    expect(tier1.escalationTier).toBe(1);
    expect(tier1.approverRuleType).toBe('ANY_ADMIN');
    expect(tier1.chainId).toBe(approvalId);

    // The escalated (admin) request can now be approved by the owner → run resumes.
    await request(app.getHttpServer())
      .post(`/approvals/${tier1.id}/approve`)
      .set(bearer(ownerToken))
      .send({})
      .expect(201);
    expect(await runStatus(runId)).toBe('COMPLETED');
  }, 40_000);

  it('AUTO_APPROVE on timeout resumes the run (autoDecided, no human)', async () => {
    const { runId, approvalId } = await runRoutedApproval({
      levels: [{ rule: 'USER', target: member1Id, slaMinutes: 60, onTimeout: 'AUTO_APPROVE' }],
    });
    await backdate(approvalId);
    await sla.sweep();

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.status).toBe('APPROVED');
    expect(row.autoDecided).toBe(true);
    expect(row.decidedById).toBeNull();
    expect(await runStatus(runId)).toBe('COMPLETED');
  }, 40_000);

  it('onTimeout NONE with no escalation → EXPIRED and the run FAILS', async () => {
    const { runId, approvalId } = await runRoutedApproval({
      levels: [{ rule: 'USER', target: member1Id, slaMinutes: 60, onTimeout: 'NONE' }],
    });
    await backdate(approvalId);
    await sla.sweep();

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    expect(row.status).toBe('EXPIRED');
    expect(await runStatus(runId)).toBe('FAILED');
  }, 40_000);

  it('a human decision in the same window wins — the sweep no-ops (race safety)', async () => {
    const { approvalId } = await runRoutedApproval({
      levels: [{ rule: 'USER', target: member1Id, slaMinutes: 60, onTimeout: 'AUTO_REJECT' }],
    });
    await backdate(approvalId);
    // Owner is not the routed USER, so can't decide — but the routed member can.
    // Simulate the human winning by deciding just before the sweep.
    await prisma.approvalRequest.update({
      where: { id: approvalId },
      data: { status: 'APPROVED', decidedById: member1Id, decidedAt: new Date() },
    });
    await sla.sweep();
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
    // Untouched by the sweep — still the human's APPROVED, not auto-rejected.
    expect(row.status).toBe('APPROVED');
    expect(row.autoDecided).toBe(false);
  }, 40_000);
});
