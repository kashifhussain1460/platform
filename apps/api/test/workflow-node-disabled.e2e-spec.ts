import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * `WorkflowNode.disabled` — the Workflow Builder's "Deactivate" action.
 *
 * The point of this suite is that the flag is REAL, not cosmetic. A greyed-out
 * card that still executes would be the worst possible outcome, so the load-
 * bearing test here is the run assertion: a disabled node must produce a SKIPPED
 * step and the run must continue past it to the node after.
 *
 * Also covers the `whitelist: true` trap (an undeclared DTO field is silently
 * stripped, so the flag would never persist) and the validator's refusal to let
 * the entry TRIGGER be disabled.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('Workflow node disabled (Deactivate)', () => {
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
    // Mirror production exactly: whitelist strips undeclared fields.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Disabled Node Co',
        name: 'Owner',
        email: `disabled_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

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

  it('persists `disabled` through create + PATCH and returns it on GET', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({
        name: `disabled-persist-${ts}`,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOOP', config: {}, disabled: true },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(201);

    // Survived the whitelist pipe on the way in.
    expect(created.body.definition.nodes[1].disabled).toBe(true);

    // And on a PATCH (the canvas autosave path), toggling it back off.
    const patched = await request(app.getHttpServer())
      .patch(`/workflows/${created.body.id}`)
      .set(bearer(token))
      .send({
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
        expectedUpdatedAt: created.body.updatedAt,
      })
      .expect(200);
    expect(patched.body.definition.nodes[1].disabled).toBeUndefined();

    const fetched = await request(app.getHttpServer())
      .get(`/workflows/${created.body.id}`)
      .set(bearer(token))
      .expect(200);
    expect(fetched.body.definition.nodes[1].disabled).toBeUndefined();
  });

  it('rejects a disabled TRIGGER (the graph would have no root)', async () => {
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({
        name: `disabled-trigger-${ts}`,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {}, disabled: true },
            { id: 'n2', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(400);
    expect(String(res.body.message)).toMatch(/cannot be disabled/);
  });

  it('SKIPS a disabled node at run time and continues to the next one', async () => {
    // TRIGGER → skipMe (disabled) → after. If `disabled` were cosmetic, `skipMe`
    // would report COMPLETED instead of SKIPPED.
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({
        name: `disabled-run-${ts}`,
        definition: {
          nodes: [
            { id: 'trigger', type: 'TRIGGER', config: {} },
            {
              id: 'skipMe',
              type: 'SET_VARIABLE',
              config: { scope: 'RUNTIME', name: 'touched', value: 'yes' },
              disabled: true,
            },
            { id: 'after', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 'trigger', to: 'skipMe' },
            { from: 'skipMe', to: 'after' },
          ],
        },
      })
      .expect(201);
    const workflowId: string = created.body.id;

    await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/activate`)
      .set(bearer(token))
      .expect(200);

    const run = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);

    expect(await runStatus(run.body.id, ['COMPLETED', 'FAILED'])).toBe('COMPLETED');

    const final = await request(app.getHttpServer())
      .get(`/workflows/runs/${run.body.id}`)
      .set(bearer(token))
      .expect(200);

    const step = (nodeId: string) =>
      final.body.steps.find((s: { nodeId: string }) => s.nodeId === nodeId);

    // The disabled node ran as SKIPPED — recorded, so the timeline explains the gap.
    expect(step('skipMe')?.status).toBe('SKIPPED');
    // …and the walk carried on past it rather than stopping.
    expect(step('after')?.status).toBe('COMPLETED');
  }, 40_000);
});
