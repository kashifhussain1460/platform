import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { NODE_TYPES } from '@vaep/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * P2 — the new node types end to end.
 *
 * Proves three things a unit test cannot: the registry really exposes every
 * declared type, the new nodes execute inside a real run, and publish-time
 * validation rejects what the engine cannot execute.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfDb('P2 nodes', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = Date.now();
  let token = '';
  let employeeId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });

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
      .send({
        companyName: `P2 Nodes ${stamp}`,
        name: 'P2 Owner',
        email: `p2_nodes_${stamp}@example.com`,
        password: 'password123',
      })
      .expect(201);
    token = reg.body.tokens.accessToken;

    const emp = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'P2 Marketer', role: 'MARKETING' })
      .expect(201);
    employeeId = emp.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const runToTerminal = async (workflowId: string) => {
    const start = await request(app.getHttpServer())
      .post(`/workflows/${workflowId}/run`)
      .set(auth())
      .send({ trigger: { band: 'weak', people: [{ name: 'Ann' }, { name: 'Bo' }] } })
      .expect(201);
    const runId = start.body.id as string;

    const deadline = Date.now() + 20_000;
    let body = start.body;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/workflows/runs/${runId}`)
        .set(auth())
        .expect(200);
      body = res.body;
      if (['COMPLETED', 'FAILED', 'WAITING'].includes(body.status)) break;
      await sleep(250);
    }
    return body;
  };

  it('the registry exposes a handler for EVERY declared node type', async () => {
    const res = await request(app.getHttpServer())
      .get('/workflows/node-types')
      .set(auth())
      .expect(200);

    // Generated from the registry, so this catches a type declared in
    // @vaep/types with no handler behind it — the drift that would otherwise
    // only surface as a run failing mid-flight.
    expect([...res.body.types].sort()).toEqual([...NODE_TYPES].sort());
    expect(res.body.types).toContain('AI_EMPLOYEE_STEP');
    expect(res.body.types).toHaveLength(19);
  });

  it('runs SET_VARIABLE → TRANSFORM → SWITCH → NOOP through a real run', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 pipeline',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            {
              id: 'v',
              type: 'SET_VARIABLE',
              config: { name: 'band', value: '{{trigger.band}}', outputKey: 'band' },
            },
            {
              id: 'x',
              type: 'TRANSFORM',
              config: {
                input: 'trigger.people',
                operations: [
                  { op: 'map', field: 'name' },
                  { op: 'join', separator: ' & ' },
                ],
                outputKey: 'names',
              },
            },
            {
              id: 's',
              type: 'SWITCH',
              config: {
                on: '{{band}}',
                cases: [
                  { value: 'strong', branch: 'advance' },
                  { value: 'weak', branch: 'reject' },
                ],
              },
            },
            { id: 'ok', type: 'NOOP', config: {} },
            { id: 'no', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 't', to: 'v' },
            { from: 'v', to: 'x' },
            { from: 'x', to: 's' },
            { from: 's', to: 'ok', branch: 'advance' },
            { from: 's', to: 'no', branch: 'reject' },
          ],
        },
      })
      .expect(201);

    const run = await runToTerminal(created.body.id);
    expect(run.status).toBe('COMPLETED');

    const types = (run.steps as { type: string; status: string }[]).map((s) => s.type);
    expect(types).toEqual(['TRIGGER', 'SET_VARIABLE', 'TRANSFORM', 'SWITCH', 'NOOP']);

    // The trigger said band=weak, so SWITCH must have taken the 'reject' edge.
    const visited = (run.steps as { nodeId: string }[]).map((s) => s.nodeId);
    expect(visited).toContain('no');
    expect(visited).not.toContain('ok');

    // TRANSFORM's map+join actually produced a value.
    const transform = (run.steps as { nodeId: string; output: unknown }[]).find(
      (s) => s.nodeId === 'x',
    );
    expect((transform!.output as { value: string }).value).toBe('Ann & Bo');
  });

  it('TERMINATE ends a run early', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 terminate',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'stop', type: 'TERMINATE', config: { status: 'COMPLETED', reason: 'done early' } },
          ],
          edges: [{ from: 't', to: 'stop' }],
        },
      })
      .expect(201);

    const run = await runToTerminal(created.body.id);
    expect(run.status).toBe('COMPLETED');
    expect(
      (run.steps as { type: string }[]).some((s) => s.type === 'TERMINATE'),
    ).toBe(true);
  });

  it('TERMINATE with status FAILED actually FAILS the run', async () => {
    // Without explicit terminate handling in the run loop the walk would simply
    // fall off the end of the graph and report COMPLETED — so a TERMINATE asking
    // to fail would silently succeed. This is the assertion that catches that.
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 terminate failed',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'stop', type: 'TERMINATE', config: { status: 'FAILED', reason: 'not eligible' } },
          ],
          edges: [{ from: 't', to: 'stop' }],
        },
      })
      .expect(201);

    const run = await runToTerminal(created.body.id);
    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('not eligible');
  });

  it('MEMORY_WRITE then MEMORY_READ round-trips a fact', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 memory',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            {
              id: 'w',
              type: 'MEMORY_WRITE',
              config: { employeeId, kind: 'FACT', content: 'Prefers {{trigger.band}} leads' },
            },
            {
              id: 'r',
              type: 'MEMORY_READ',
              config: { employeeId, kind: 'FACT', limit: 5, outputKey: 'memories' },
            },
          ],
          edges: [
            { from: 't', to: 'w' },
            { from: 'w', to: 'r' },
          ],
        },
      })
      .expect(201);

    const run = await runToTerminal(created.body.id);
    expect(run.status).toBe('COMPLETED');

    const stored = await prisma.employeeMemory.findMany({
      where: { employeeId, kind: 'FACT', source: 'RUN' },
    });
    expect(stored.some((m) => m.content === 'Prefers weak leads')).toBe(true);

    const read = (run.steps as { nodeId: string; output: unknown }[]).find(
      (s) => s.nodeId === 'r',
    );
    expect((read!.output as { count: number }).count).toBeGreaterThan(0);
  });

  it('runs PARALLEL lanes and converges at JOIN', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 parallel',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            {
              id: 'p',
              type: 'PARALLEL',
              config: { lanes: ['l1', 'l2'], joinNodeId: 'j' },
            },
            { id: 'l1', type: 'SET_VARIABLE', config: { name: 'laneOne', value: 'one' } },
            { id: 'l2', type: 'SET_VARIABLE', config: { name: 'laneTwo', value: 'two' } },
            { id: 'j', type: 'JOIN', config: { outputKey: 'joined' } },
            { id: 'end', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 't', to: 'p' },
            { from: 'l1', to: 'j' },
            { from: 'l2', to: 'j' },
            { from: 'j', to: 'end' },
          ],
        },
      })
      .expect(201);

    const run = await runToTerminal(created.body.id);
    expect(run.status).toBe('COMPLETED');

    const visited = (run.steps as { nodeId: string }[]).map((s) => s.nodeId);
    // Both lanes ran, then the join, then the tail.
    expect(visited).toEqual(
      expect.arrayContaining(['t', 'p', 'l1', 'l2', 'j', 'end']),
    );

    const join = (run.steps as { nodeId: string; output: unknown }[]).find(
      (s) => s.nodeId === 'j',
    );
    expect((join!.output as { arrived: number }).arrived).toBe(2);
  });

  it('runs a LOOP body once per item', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 loop',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            {
              id: 'l',
              type: 'LOOP',
              config: {
                over: 'trigger.people',
                itemVar: 'person',
                body: 'b',
                maxIterations: 5,
                done: 'end',
              },
            },
            {
              id: 'b',
              type: 'SET_VARIABLE',
              config: { name: 'lastPerson', value: '{{person.name}}' },
            },
            { id: 'end', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 't', to: 'l' },
            { from: 'b', to: 'l' },
          ],
        },
      })
      .expect(201);

    const run = await runToTerminal(created.body.id);
    expect(run.status).toBe('COMPLETED');

    // The trigger supplies two people, so the body must have run twice.
    const bodyRuns = (run.steps as { nodeId: string }[]).filter(
      (s) => s.nodeId === 'b',
    );
    expect(bodyRuns.length).toBeGreaterThanOrEqual(2);

    const loop = (run.steps as { nodeId: string; output: unknown }[]).find(
      (s) => s.nodeId === 'l',
    );
    expect((loop!.output as { itemCount: number }).itemCount).toBe(2);
  });

  it('runs PARALLEL lanes CONCURRENTLY, not one after another', async () => {
    // Two lanes each WAIT ~400ms. Concurrent → total well under 800ms;
    // sequential → over 800ms. This is the assertion that would have failed
    // against the original Promise-less implementation.
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 concurrent lanes',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            {
              id: 'p',
              type: 'PARALLEL',
              config: { lanes: ['w1', 'w2'], joinNodeId: 'j' },
            },
            { id: 'w1', type: 'WAIT', config: { durationMs: 400 } },
            { id: 'w2', type: 'WAIT', config: { durationMs: 400 } },
            { id: 'j', type: 'JOIN', config: {} },
          ],
          edges: [
            { from: 't', to: 'p' },
            { from: 'w1', to: 'j' },
            { from: 'w2', to: 'j' },
          ],
        },
      })
      .expect(201);

    const run = await runToTerminal(created.body.id);
    expect(run.status).toBe('COMPLETED');

    const steps = run.steps as { nodeId: string; startedAt: string; finishedAt: string }[];
    const w1 = steps.find((x) => x.nodeId === 'w1')!;
    const w2 = steps.find((x) => x.nodeId === 'w2')!;

    // Overlapping execution windows is the direct evidence of concurrency —
    // more reliable than a wall-clock total, which a slow CI box could inflate.
    const start1 = new Date(w1.startedAt).getTime();
    const end1 = new Date(w1.finishedAt).getTime();
    const start2 = new Date(w2.startedAt).getTime();
    const end2 = new Date(w2.finishedAt).getTime();
    expect(start1).toBeLessThan(end2);
    expect(start2).toBeLessThan(end1);
  });

  it('rejects an unbounded LOOP at save time', async () => {
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 unbounded loop',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'l', type: 'LOOP', config: { over: 'trigger.people', body: 'b' } },
            { id: 'b', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 't', to: 'l' }],
        },
      })
      .expect(400);
    expect(String(res.body.message)).toMatch(/maxIterations/);
  });

  it('rejects a cyclic graph at save time', async () => {
    // Previously this saved cleanly and only died at runtime with a confusing
    // "exceeded max node count".
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 cycle',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'a', type: 'NOOP', config: {} },
            { id: 'b', type: 'NOOP', config: {} },
          ],
          edges: [
            { from: 't', to: 'a' },
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        },
      })
      .expect(400);
    expect(String(res.body.message)).toMatch(/Cycle detected/);
  });

  it('a WORKFLOW-scope variable persists and is readable by the NEXT run', async () => {
    // The whole point of WORKFLOW scope: it outlives one run. Before the
    // WorkflowVariable table existed this silently vanished at run end.
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 persisted variable',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            {
              id: 'v',
              type: 'SET_VARIABLE',
              config: {
                name: 'lastBand',
                value: '{{trigger.band}}',
                scope: 'WORKFLOW',
              },
            },
          ],
          edges: [{ from: 't', to: 'v' }],
        },
      })
      .expect(201);

    const first = await runToTerminal(created.body.id);
    expect(first.status).toBe('COMPLETED');

    const stored = await prisma.workflowVariable.findFirst({
      where: { workflowId: created.body.id, scope: 'WORKFLOW', key: 'lastBand' },
    });
    expect(stored).not.toBeNull();
    expect(stored!.value).toBe('weak');

    // A SECOND run must see the stored value seeded into its context.
    const second = await runToTerminal(created.body.id);
    expect(second.status).toBe('COMPLETED');
    expect(
      (second.context as Record<string, unknown>).lastBand,
    ).toBe('weak');
  });

  it('rejects an inline secret in node config at save time', async () => {
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 secret',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'a', type: 'TOOL_ACTION', config: { clientSecret: 'hunter2' } },
          ],
          edges: [{ from: 't', to: 'a' }],
        },
      })
      .expect(400);
    expect(String(res.body.message)).toMatch(/inline secret/i);
  });

  it('rejects SET_VARIABLE writing a read-only scope at save time', async () => {
    const res = await request(app.getHttpServer())
      .post('/workflows')
      .set(auth())
      .send({
        name: 'P2 scope',
        definition: {
          nodes: [
            { id: 't', type: 'TRIGGER', config: {} },
            { id: 'v', type: 'SET_VARIABLE', config: { name: 'x', scope: 'SECRET' } },
          ],
          edges: [{ from: 't', to: 'v' }],
        },
      })
      .expect(400);
    expect(String(res.body.message)).toMatch(/read-only/);
  });
});
