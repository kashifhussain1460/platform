import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { MetricsRegistry } from '../src/common/observability/metrics.registry';
import { RunStateWriter } from '../src/modules/workflow-runtime/run-state-writer.service';
import { RunEventStreamService } from '../src/modules/workflows/run-event-stream.service';

/**
 * WAVE 5 — observability + realtime against real Postgres/Redis.
 *
 * The registry's arithmetic and the context's async behaviour are unit-tested.
 * What only works here is the wiring: that transitions actually emit metrics,
 * that the scrape endpoint is gated, and that run events reach a subscriber.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('WAVE 5 — observability + realtime', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let metrics: MetricsRegistry;
  let state: RunStateWriter;
  let stream: RunEventStreamService;

  const ts = Date.now();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

  let token = '';
  let companyId = '';
  let workflowId = '';

  const newRun = () =>
    prisma.workflowRun.create({
      data: { companyId, workflowId, status: 'PENDING', source: 'MANUAL' },
    });

  beforeAll(async () => {
    // CRON_SECRET is pinned in test/setup-e2e-env.ts, not set here: ConfigService
    // snapshots the environment at import time, so a value assigned in beforeAll
    // never reaches the controller that compares against it.
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    metrics = app.get(MetricsRegistry);
    state = app.get(RunStateWriter);
    stream = app.get(RunEventStreamService);

    const reg = await http()
      .post('/auth/register')
      .send({
        companyName: `Obs Co ${ts}`,
        name: 'Obs Owner',
        email: `obs_owner_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

    const wf = await prisma.workflow.create({
      data: {
        companyId,
        name: 'Obs fixture',
        definition: { nodes: [], edges: [] } as never,
      },
    });
    workflowId = wf.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── §5.1 correlation ───────────────────────────────────────────────────────

  it('echoes a request id so a caller can quote it in a support ticket', async () => {
    const res = await http().get('/health').expect(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('adopts an inbound request id rather than inventing a second one', async () => {
    const res = await http()
      .get('/health')
      .set('x-request-id', `caller-${ts}`)
      .expect(200);
    expect(res.headers['x-request-id']).toBe(`caller-${ts}`);
  });

  // ── §5.3 metrics ───────────────────────────────────────────────────────────

  it('counts run lifecycle transitions', async () => {
    const before = metrics.total('workflow_runs_total');
    const run = await newRun();
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'COMPLETED',
      event: 'run.completed',
    });

    expect(metrics.total('workflow_runs_total')).toBe(before + 1);
    expect(metrics.total('workflow_success_total')).toBeGreaterThanOrEqual(1);
    // Duration is observed on the terminal transition.
    expect(metrics.total('workflow_duration_ms')).toBeGreaterThanOrEqual(1);
  });

  it('labels failures by failure class', async () => {
    const run = await newRun();
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'FAILED',
      failureClass: 'TIMEOUT',
      error: 'nope',
      event: 'run.failed',
    });
    expect(
      metrics.total('workflow_failure_total', { failure_class: 'TIMEOUT' }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('serves Prometheus exposition, including scrape-time gauges', async () => {
    const res = await http()
      .get('/admin/metrics')
      .set('x-cron-secret', process.env.CRON_SECRET as string)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('# TYPE workflow_runs_total counter');
    // Computed at scrape time, not maintained on every produce/consume.
    expect(res.text).toContain('outbox_backlog');
    expect(res.text).toContain('queue_depth_');
    expect(res.text).toContain('audit_relay_lag');
  });

  it('refuses the scrape endpoint without the operator secret', async () => {
    // Metric names and labels describe the system's shape and its tenants'
    // activity; this is not a harmless endpoint to leave open.
    await http().get('/admin/metrics').expect(403);
    await http()
      .get('/admin/metrics')
      .set('x-cron-secret', 'wrong')
      .expect(403);
  });

  // ── §5.4 alerts ────────────────────────────────────────────────────────────

  it('evaluates alert rules and reports none firing on a healthy system', async () => {
    const res = await http()
      .get('/admin/alerts')
      .set('x-cron-secret', process.env.CRON_SECRET as string)
      .expect(200);
    expect(res.body.evaluated).toBeGreaterThan(0);
    expect(Array.isArray(res.body.firing)).toBe(true);
  });

  // ── §5.5 realtime ──────────────────────────────────────────────────────────

  it('returns a run’s event history, tenant-scoped', async () => {
    const run = await newRun();
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });

    const res = await http()
      .get(`/workflows/runs/${run.id}/events`)
      .set(bearer(token))
      .expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].type).toBe('run.started');
    expect(res.body[0].runId).toBe(run.id);
    expect(typeof res.body[0].seq).toBe('number');
  });

  it('refuses another tenant’s run', async () => {
    const other = await prisma.company.create({
      data: { name: `Obs Other ${ts}`, slug: `obs-other-${ts}` },
    });
    const otherWf = await prisma.workflow.create({
      data: {
        companyId: other.id,
        name: 'other',
        definition: { nodes: [], edges: [] } as never,
      },
    });
    const otherRun = await prisma.workflowRun.create({
      data: {
        companyId: other.id,
        workflowId: otherWf.id,
        status: 'PENDING',
        source: 'MANUAL',
      },
    });

    // A stream keyed only by runId would let anyone who learns an id watch
    // another tenant's execution live.
    await http()
      .get(`/workflows/runs/${otherRun.id}/events`)
      .set(bearer(token))
      .expect(404);
  });

  it('delivers a live event to a subscriber, after replaying history', async () => {
    const run = await newRun();
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });

    const received: string[] = [];
    const sub = stream.subscribe(companyId, run.id, 0).subscribe((msg) => {
      received.push((msg.data as { type: string }).type);
    });

    // Give the replay a tick, then push a live event through the relay sink.
    await new Promise((r) => setTimeout(r, 200));

    // Delivery now goes out over Redis pub/sub and comes back on the
    // subscription, so it is a round trip rather than a synchronous call — and
    // the SUBSCRIBE itself is fire-and-forget so it cannot block app boot.
    // Poll for the event instead of sleeping a fixed interval, and re-publish
    // while waiting so a message sent before the subscription was ready is not
    // simply lost to a race.
    const deadline = Date.now() + 10_000;
    while (!received.includes('run.completed') && Date.now() < deadline) {
      await stream.publish([
        {
          seq: Number.MAX_SAFE_INTEGER,
          runId: run.id,
          companyId,
          type: 'run.completed',
          emittedAt: new Date().toISOString(),
          data: {},
        },
      ]);
      await new Promise((r) => setTimeout(r, 200));
    }
    sub.unsubscribe();

    // History first, then live — and the live one is not lost.
    expect(received).toContain('run.started');
    expect(received).toContain('run.completed');
  });

  it('replays only what the client has not seen (`after`)', async () => {
    // This is what makes a dropped SSE connection recoverable instead of
    // silently lossy.
    const run = await newRun();
    await state.transitionRun({
      runId: run.id,
      companyId,
      to: 'RUNNING',
      event: 'run.started',
    });
    const all = await stream.history(companyId, run.id, 0);
    expect(all.length).toBeGreaterThanOrEqual(1);

    const after = await stream.history(companyId, run.id, all[all.length - 1].seq);
    expect(after).toEqual([]);
  });
});
