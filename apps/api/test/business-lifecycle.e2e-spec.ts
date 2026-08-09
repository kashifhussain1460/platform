import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * The complete business lifecycle, walked end to end against real HTTP + a
 * real Postgres: register → upgrade plan → onboard (hiring an HR AND a
 * Marketing AI Employee — the exact capability the onboarding department-list
 * fix in this same session unblocked) → install a real first-party HR
 * workflow template → activate it → run it → decide the human approval it
 * pauses on → watch it complete → then repeat install→run→approve→complete
 * for a real Marketing template.
 *
 * This is deliberately ONE continuous story (not one company per `it`, like
 * most other suites) — the whole point is proving the pieces work TOGETHER,
 * not each in isolation. Mirrors `workflow-lifecycle-publish.e2e-spec.ts`'s
 * one-test-one-narrative shape.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('Complete business lifecycle (onboarding → hire → template → run → approve)', () => {
  let app: INestApplication;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Poll a run until it reaches one of `want`, or give up after 20s. */
  const runStatus = async (runId: string, want: string[]): Promise<string> => {
    const deadline = Date.now() + 20_000;
    let status = 'PENDING';
    while (Date.now() < deadline) {
      const r = await request(app.getHttpServer())
        .get(`/workflows/runs/${runId}`)
        .set(bearer(token));
      status = r.body.status;
      if (want.includes(status)) return status;
      await sleep(200);
    }
    return status;
  };

  /** Find the DB row id for a first-party template by its catalog `key`. */
  const findTemplateId = async (key: string): Promise<string> => {
    const list = await request(app.getHttpServer())
      .get('/workflow-templates')
      .set(bearer(token))
      .expect(200);
    const row = list.body.find((t: { key: string }) => t.key === key);
    expect(row).toBeDefined();
    return row.id;
  };

  /** Approve the single pending WORKFLOW-kind approval gating this run. */
  const approveRun = async (runId: string): Promise<void> => {
    const pending = await request(app.getHttpServer())
      .get('/approvals?status=PENDING')
      .set(bearer(token))
      .expect(200);
    const approval = pending.body.find(
      (a: { workflowRunId: string | null }) => a.workflowRunId === runId,
    );
    expect(approval).toBeDefined();
    await request(app.getHttpServer())
      .post(`/approvals/${approval.id}/approve`)
      .set(bearer(token))
      .expect(201);
  };

  it('walks the whole lifecycle for both an HR and a Marketing workflow', async () => {
    // ── 1. Register a fresh throwaway company ──────────────────────────────
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Lifecycle Co ${ts}`,
        name: 'Owner',
        email: `lifecycle_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    expect(reg.body.company.onboardedAt).toBeNull();

    // ── 2. Every first-party HR/Marketing template requires BUSINESS ───────
    const upgraded = await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(token))
      .send({ plan: 'BUSINESS' })
      .expect(201);
    expect(upgraded.body.plan).toBe('BUSINESS');

    // ── 3. Onboard, hiring BOTH an HR and a Marketing AI Employee ──────────
    // This is the exact path the department-list fix unblocked: before it,
    // 'MARKETING' wasn't a selectable department and had no onboarding-catalog
    // entry, so this employee could never be hired from the wizard.
    const onboarded = await request(app.getHttpServer())
      .post('/onboarding/complete')
      .set(bearer(token))
      .send({
        business: {
          industry: 'SaaS',
          size: '11-50',
          description: 'A test company walking the full business lifecycle.',
        },
        departments: ['HR', 'MARKETING'],
        employees: [
          { role: 'HR', name: 'Emma' },
          { role: 'MARKETING', name: 'Max' },
        ],
      })
      .expect(201);

    expect(onboarded.body.employees).toHaveLength(2);
    const hrEmployee = onboarded.body.employees.find(
      (e: { role: string }) => e.role === 'HR',
    );
    const mktEmployee = onboarded.body.employees.find(
      (e: { role: string }) => e.role === 'MARKETING',
    );
    expect(hrEmployee).toBeDefined();
    expect(mktEmployee).toBeDefined();

    // Departments persisted with readable names — 'HR' stays an acronym,
    // 'MARKETING' Title-Cases normally (both label-formatting fixes at once).
    expect(
      onboarded.body.departments.map((d: { name: string }) => d.name).sort(),
    ).toEqual(['HR', 'Marketing']);

    // ── 4. Install the skills the two templates below call ────────────────
    await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'slack' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'gdrive' })
      .expect(201);

    // ── 5. HR: install "leave request → approval → notify", run it, ───────
    //         decide the approval, watch it complete ───────────────────────
    const hrTemplateId = await findTemplateId('hr.leave-request');
    const hrInstall = await request(app.getHttpServer())
      .post(`/workflow-templates/${hrTemplateId}/install`)
      .set(bearer(token))
      .set('Idempotency-Key', `hr-install-${ts}`)
      .send({
        name: 'Leave request handling',
        parameters: { hrEmployee: hrEmployee.id, notifyChannel: '#hr-updates' },
      })
      .expect(201);
    const hrWorkflowId: string = hrInstall.body.id;
    expect(hrInstall.body.status).toBe('DRAFT');

    await request(app.getHttpServer())
      .post(`/workflows/${hrWorkflowId}/activate`)
      .set(bearer(token))
      .expect(200);

    const hrRun = await request(app.getHttpServer())
      .post(`/workflows/${hrWorkflowId}/run`)
      .set(bearer(token))
      .send({ trigger: { payload: { employee: 'Priya', days: 3, reason: 'Family event' } } })
      .expect(201);

    // The template's own shape (TRIGGER → AI_EMPLOYEE_STEP → APPROVAL →
    // TOOL_ACTION) means it MUST pause here — this is the real approval gate,
    // not a stub.
    expect(await runStatus(hrRun.body.id, ['WAITING', 'FAILED'])).toBe('WAITING');
    await approveRun(hrRun.body.id);
    expect(await runStatus(hrRun.body.id, ['COMPLETED', 'FAILED'])).toBe('COMPLETED');

    const hrFinal = await request(app.getHttpServer())
      .get(`/workflows/runs/${hrRun.body.id}`)
      .set(bearer(token))
      .expect(200);
    const notifyStep = hrFinal.body.steps.find(
      (s: { nodeId: string }) => s.nodeId === 'notify',
    );
    expect(notifyStep.status).toBe('COMPLETED');

    // ── 6. Marketing: install "campaign plan → approval → save", run it, ──
    //         decide the approval, watch it complete ───────────────────────
    const mktTemplateId = await findTemplateId('mkt.campaign-plan');
    const mktInstall = await request(app.getHttpServer())
      .post(`/workflow-templates/${mktTemplateId}/install`)
      .set(bearer(token))
      .set('Idempotency-Key', `mkt-install-${ts}`)
      .send({
        name: 'Campaign planning',
        parameters: { marketingEmployee: mktEmployee.id },
      })
      .expect(201);
    const mktWorkflowId: string = mktInstall.body.id;

    await request(app.getHttpServer())
      .post(`/workflows/${mktWorkflowId}/activate`)
      .set(bearer(token))
      .expect(200);

    const mktRun = await request(app.getHttpServer())
      .post(`/workflows/${mktWorkflowId}/run`)
      .set(bearer(token))
      .send({
        trigger: { brief: 'Q1 product launch', campaignName: 'Q1-Launch' },
      })
      .expect(201);

    expect(await runStatus(mktRun.body.id, ['WAITING', 'FAILED'])).toBe('WAITING');
    await approveRun(mktRun.body.id);
    expect(await runStatus(mktRun.body.id, ['COMPLETED', 'FAILED'])).toBe('COMPLETED');

    const mktFinal = await request(app.getHttpServer())
      .get(`/workflows/runs/${mktRun.body.id}`)
      .set(bearer(token))
      .expect(200);
    const saveStep = mktFinal.body.steps.find(
      (s: { nodeId: string }) => s.nodeId === 'save',
    );
    expect(saveStep.status).toBe('COMPLETED');

    // ── 7. The company genuinely ran its business through the platform ────
    const finalCompany = await request(app.getHttpServer())
      .get('/auth/me')
      .set(bearer(token))
      .expect(200);
    expect(finalCompany.body.company.onboardedAt).not.toBeNull();
  }, 60_000);
});
