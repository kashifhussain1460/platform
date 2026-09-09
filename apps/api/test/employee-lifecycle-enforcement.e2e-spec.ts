import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { WorkflowsService } from '../src/modules/workflows/workflows.service';

/**
 * Employee lifecycle enforcement e2e.
 *
 * The gap: pausing, disabling or archiving an AI Employee did NOT stop workflow
 * execution. Only the CHAT surface checked employee status, so a paused
 * employee's scheduled and event-triggered workflows kept creating runs and
 * kept executing with its persona, model, budget and skill connections — and
 * `TOOL_ACTION`, the one node type with side effects, never loaded the employee
 * row at all.
 *
 * Needs a live Postgres + Redis; skipped when DATABASE_URL is unset. Run with:
 *   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
 *   SKILL_EXECUTOR=mock BILLING_PROVIDER=mock ENCRYPTION_KEY=<64 hex> \
 *   npx jest --config ./test/jest-e2e.json employee-lifecycle --forceExit
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Employee lifecycle enforcement (pause/disable/archive stops automation)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workflows: WorkflowsService;

  const email = `emp_lifecycle_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let companyId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  /** Hire an employee through the real API. */
  const hire = async (name: string, role = 'HR'): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name, role })
      .expect(201);
    return res.body.id as string;
  };

  /** A minimal runnable graph whose AI step is bound to `employeeId`. */
  const graphFor = (employeeId: string) => ({
    nodes: [
      { id: 'n1', type: 'TRIGGER', config: {} },
      {
        id: 'n2',
        type: 'AI_EMPLOYEE_STEP',
        config: {
          employeeId,
          instruction: 'Summarise {{trigger.topic}}. Recommend only.',
          outputKey: 'summary',
        },
      },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  });

  /** Create + publish + activate a workflow bound to one employee. */
  const liveWorkflowFor = async (
    employeeId: string,
    name: string,
    trigger?: { triggerType: string; triggerConfig: Record<string, unknown> },
  ): Promise<string> => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({ name, definition: graphFor(employeeId) })
      .expect(201);
    const id = created.body.id as string;

    // publish() freezes the DRAFT VERSION, which POST /workflows does not
    // write (it only sets the `definition` column), so the draft has to be
    // saved explicitly first — same sequence journey-hr-e2e uses.
    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(auth())
      .send({ definition: graphFor(employeeId) })
      .expect(200);

    if (trigger) {
      await request(app.getHttpServer())
        .patch(`/workflows/${id}`)
        .set(auth())
        .send(trigger)
        .expect(200);
    }

    await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(auth())
      .send({ activate: true })
      .expect(200);
    return id;
  };

  const setStatus = (employeeId: string, status: string) =>
    request(app.getHttpServer())
      .patch(`/employees/${employeeId}`)
      .set(auth())
      .send({ status })
      .expect(200);

  const runCount = (workflowId: string) =>
    prisma.workflowRun.count({ where: { companyId, workflowId } });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    workflows = app.get(WorkflowsService);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Employee Lifecycle E2E Co',
        name: 'Lifecycle Owner',
        email,
        password,
      })
      .expect(201);
    accessToken = res.body.tokens.accessToken;
    companyId = res.body.company.id;

    // ENTERPRISE: this suite hires several employees and the role-based hiring
    // plans cap non-Enterprise tenants at 2 roles x 1-2 each.
    await prisma.subscription.updateMany({
      where: { companyId },
      data: { plan: 'ENTERPRISE' },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('baseline: an ACTIVE employee CAN start its workflow', async () => {
    const employeeId = await hire('Baseline Emma');
    const workflowId = await liveWorkflowFor(employeeId, 'Lifecycle baseline');

    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { topic: 'a baseline run' } })
      .expect(201);

    expect(await runCount(workflowId)).toBe(1);
  });

  it('PAUSED: the run is refused with 409 and the message names the employee', async () => {
    const employeeId = await hire('Paused Priya');
    const workflowId = await liveWorkflowFor(employeeId, 'Lifecycle paused');
    await setStatus(employeeId, 'PAUSED');

    const res = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { topic: 'should not run' } })
      .expect(409);

    expect(String(res.body.message)).toContain('Paused Priya');
    expect(String(res.body.message)).toContain('paused');
    // The important half: no run row was created at all.
    expect(await runCount(workflowId)).toBe(0);
  });

  it('DISABLED: same refusal', async () => {
    const employeeId = await hire('Disabled Dan', 'SALES');
    const workflowId = await liveWorkflowFor(employeeId, 'Lifecycle disabled');
    await setStatus(employeeId, 'DISABLED');

    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { topic: 'should not run' } })
      .expect(409);

    expect(await runCount(workflowId)).toBe(0);
  });

  it('ARCHIVED-but-ACTIVE is still blocked — the split state a status-only check misses', async () => {
    // PATCH { status: 'ACTIVE' } on an archived employee does NOT clear
    // archivedAt, and there is no unarchive endpoint, so this row is genuinely
    // reachable in production: ACTIVE, invisible in the roster, and workable to
    // any check that reads only `status`.
    const employeeId = await hire('Archived Ana', 'SUPPORT');
    const workflowId = await liveWorkflowFor(employeeId, 'Lifecycle archived');

    await request(app.getHttpServer())
      .delete(`/employees/${employeeId}`)
      .set(auth())
      .expect(204);
    await setStatus(employeeId, 'ACTIVE');

    const row = await prisma.aiEmployee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { status: true, archivedAt: true },
    });
    expect(row.status).toBe('ACTIVE');
    expect(row.archivedAt).not.toBeNull();

    const res = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { topic: 'should not run' } })
      .expect(409);

    expect(String(res.body.message)).toContain('archived');
    expect(await runCount(workflowId)).toBe(0);
  });

  it('SCHEDULE: a paused employee stops the schedule firing, without throwing', async () => {
    const employeeId = await hire('Scheduled Sam', 'MARKETING');
    const workflowId = await liveWorkflowFor(employeeId, 'Lifecycle schedule', {
      triggerType: 'SCHEDULE',
      triggerConfig: { everyMs: 60_000 },
    });

    // Stand the real scheduler down before asserting anything.
    //
    // 🔴 `activate()` registers a BullMQ REPEATABLE for a SCHEDULE trigger, and
    // with a live worker that repeatable competes with this test: in a full
    // suite run it created a run between the deleteMany below and the count,
    // which is a test that fails for a reason that has nothing to do with the
    // employee. Deactivating removes the repeatable; setting status back to
    // ACTIVE directly (rather than re-activating) leaves the row runnable
    // WITHOUT re-registering it, so `fireSchedule` calls made by this test are
    // the only thing that can create a run.
    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/deactivate`)
      .set(auth())
      .expect(200);
    await prisma.workflow.update({
      where: { id: workflowId },
      data: { status: 'ACTIVE' },
    });

    // Fires while ACTIVE.
    await workflows.fireSchedule(workflowId, 'SCHEDULE');
    expect(await runCount(workflowId)).toBeGreaterThanOrEqual(1);

    // 🔴 Clear the runs before the second fire. Without this the test PASSES
    // EVEN WITH THE KILL SWITCH REMOVED — verified by mutation — because
    // fireSchedule derives an idempotency key from the schedule SLOT
    // (`scheduleSlotKey(id, config, Date.now())`), so a second fire inside the
    // same 60s slot is deduped by the unique constraint whatever the
    // employee's status is. Deleting the rows frees the key, so the only thing
    // that can keep the count at zero is the employee kill switch. Same
    // settling trick workflow-canonical-path.e2e-spec.ts uses for the
    // disabled-publisher case.
    await prisma.workflowRun.deleteMany({ where: { companyId, workflowId } });
    expect(await runCount(workflowId)).toBe(0);

    await setStatus(employeeId, 'PAUSED');

    // fireSchedule is a background driver with no caller to receive a 409, so
    // it must LOG and swallow — never throw, never create a run.
    await expect(
      workflows.fireSchedule(workflowId, 'SCHEDULE'),
    ).resolves.not.toThrow();
    expect(await runCount(workflowId)).toBe(0);
  });

  it('a workflow naming nobody is unaffected by another employee being paused', async () => {
    // Back-compat: company-level workflows must keep working.
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'Lifecycle unbound',
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            {
              id: 'n2',
              type: 'AI_STEP',
              config: { prompt: 'No employee here', outputKey: 'out' },
            },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(201);
    const workflowId = created.body.id as string;
    await request(app.getHttpServer())
      .put(`/workflows/${workflowId}/draft`)
      .set(auth())
      .send({ definition: created.body.definition })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/publish`)
      .set(auth())
      .send({ activate: true })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { topic: 'unbound' } })
      .expect(201);

    expect(await runCount(workflowId)).toBe(1);
  });

  it('an author-DISABLED node does not block the run, because the engine skips it anyway', async () => {
    // False-positive guard: refusing a run because of a step nobody will
    // execute would make pausing an employee break unrelated workflows.
    const employeeId = await hire('Skipped Sara', 'ACCOUNTANT');
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'Lifecycle disabled-node',
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            {
              id: 'n2',
              type: 'AI_STEP',
              config: { prompt: 'Runs fine', outputKey: 'out' },
            },
            {
              id: 'n3',
              type: 'AI_EMPLOYEE_STEP',
              disabled: true,
              config: {
                employeeId,
                instruction: 'Never executed',
                outputKey: 'never',
              },
            },
          ],
          edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' },
          ],
        },
      })
      .expect(201);
    const workflowId = created.body.id as string;
    await request(app.getHttpServer())
      .put(`/workflows/${workflowId}/draft`)
      .set(auth())
      .send({ definition: created.body.definition })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/publish`)
      .set(auth())
      .send({ activate: true })
      .expect(200);

    await setStatus(employeeId, 'PAUSED');

    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { topic: 'skipped node' } })
      .expect(201);

    expect(await runCount(workflowId)).toBe(1);
  });
});
