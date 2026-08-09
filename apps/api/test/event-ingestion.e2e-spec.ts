import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

// Connector event ingestion → normalization → canonical event → workflow e2e
// (Unit A). Needs a live Postgres + Redis (BullMQ). Skipped when DATABASE_URL is
// unset so it never blocks builds. Run it with:
//   SKILL_EXECUTOR=mock LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   ENCRYPTION_KEY=<64hex> \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WEBHOOK_SECRET = 'whsec_test';

/** GitHub `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(rawBody) hex. */
function githubSig(rawBody: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')}`;
}

/** A runnable linear definition: TRIGGER -> AI_STEP -> NOTIFY (no external deps). */
const RUNNABLE_DEFINITION = {
  nodes: [
    { id: 'n1', type: 'TRIGGER', config: {} },
    {
      id: 'n2',
      type: 'AI_STEP',
      config: { prompt: 'Acknowledge the event.', outputKey: 'aiText' },
    },
    { id: 'n3', type: 'NOTIFY', config: { message: 'Done: {{aiText}}' } },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
  ],
};

// A GitHub pull_request.opened payload (the mapper reads action + pull_request).
const PR_PAYLOAD = {
  action: 'opened',
  pull_request: {
    node_id: 'PR_kwDOtest',
    number: 42,
    title: 'Add the widget',
    html_url: 'https://github.com/octo/hello/pull/42',
    created_at: '2026-07-10T09:12:01Z',
    user: { login: 'octocat' },
  },
  repository: { full_name: 'octo/hello' },
};

describeIfDb('Connector event ingestion e2e (webhook → canonical → EVENT workflow)', () => {
  // Async normalization + workflow firing are polled below; give them headroom.
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  const email = `events_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let connectorId = '';
  let workflowId = '';

  // A single shared delivery id, reused by the dedupe test.
  const body = JSON.stringify(PR_PAYLOAD);
  const delivery = randomUUID();

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });
  const server = () => app.getHttpServer();

  /** POST the ingestion edge with GitHub headers + a signature over `rawBody`. */
  function postWebhook(rawBody: string, headers: Record<string, string>) {
    const req = request(server())
      .post(`/connectors/${connectorId}/webhook`)
      .set('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(headers)) {
      req.set(k, v);
    }
    return req.send(rawBody);
  }

  /** Poll the canonical observability endpoint until >=1 event (or timeout). */
  async function pollCanonical(timeoutMs = 20_000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(server())
        .get(`/connectors/${connectorId}/events?kind=canonical`)
        .set(auth())
        .expect(200);
      if (Array.isArray(res.body) && res.body.length > 0) return res.body;
      await sleep(300);
    }
    return [];
  }

  /** Poll the workflow's runs until an EVENT-sourced run appears (or timeout). */
  async function pollEventRuns(timeoutMs = 20_000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(server())
        .get(`/workflows/${workflowId}/runs`)
        .set(auth())
        .expect(200);
      const eventRuns = (res.body ?? []).filter(
        (r: { source: string }) => r.source === 'EVENT',
      );
      if (eventRuns.length > 0) return eventRuns;
      await sleep(300);
    }
    return [];
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // rawBody: true so the ingestion edge can HMAC-verify the exact bytes (as main.ts does).
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const reg = await request(server())
      .post('/auth/register')
      .send({ companyName: 'Events E2E Co', name: 'Ev Owner', email, password })
      .expect(201);
    accessToken = reg.body.tokens.accessToken;

    // Install a github connector, then CONNECT it (real path → secret encrypted at rest).
    const install = await request(server())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'github' })
      .expect(201);
    connectorId = install.body.id;

    const connected = await request(server())
      .post(`/skills/installed/${connectorId}/connect`)
      .set(auth())
      .send({ credentials: { webhookSecret: WEBHOOK_SECRET } })
      .expect(201);
    expect(connected.body.connectionStatus).toBe('CONNECTED');
    // The raw secret must never be echoed back.
    expect(JSON.stringify(connected.body)).not.toContain(WEBHOOK_SECRET);

    // Create + activate an ACTIVE EVENT workflow listening for NEW_GITHUB_PR.
    const wf = await request(server())
      .post('/workflows')
      .set(auth())
      .send({ name: 'PR opened flow', definition: RUNNABLE_DEFINITION })
      .expect(201);
    workflowId = wf.body.id;
    await request(server())
      .patch(`/workflows/${workflowId}`)
      .set(auth())
      .send({ triggerType: 'EVENT', triggerConfig: { eventType: 'NEW_GITHUB_PR' } })
      .expect(200);
    const activated = await request(server())
      .post(`/workflows/${workflowId}/activate`)
      .set(auth())
      .expect(200);
    expect(activated.body.status).toBe('ACTIVE');
    expect(activated.body.triggerType).toBe('EVENT');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts a valid signed pull_request.opened webhook (NO auth) → 202 + RawEvent persisted', async () => {
    const res = await postWebhook(body, {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': githubSig(body),
    }).expect(202);
    expect(res.body.received).toBe(true);
    expect(res.body.deduped).toBe(false);
    expect(typeof res.body.rawEventId).toBe('string');

    // The RawEvent is persisted append-only with the verified flag set.
    const raw = await prisma.rawEvent.findUnique({
      where: { id: res.body.rawEventId },
    });
    expect(raw).toBeTruthy();
    expect(raw?.signatureVerified).toBe(true);
    expect(raw?.provider).toBe('github');
    // Dedupe identity is now a hash of the signed body, not the unsigned header.
    expect(raw?.externalId?.startsWith('sha256:')).toBe(true);

    // The raw observability endpoint surfaces it too.
    const rawFeed = await request(server())
      .get(`/connectors/${connectorId}/events?kind=raw`)
      .set(auth())
      .expect(200);
    expect(rawFeed.body.some((e: { id: string }) => e.id === res.body.rawEventId)).toBe(true);
  });

  it('normalizes to a NEW_GITHUB_PR CanonicalEvent (poll observability endpoint)', async () => {
    const events = await pollCanonical();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const pr = events.find((e) => e.type === 'NEW_GITHUB_PR');
    expect(pr).toBeTruthy();
    expect(pr.provider).toBe('github');
    // dedupeKey is derived from the body-hash externalId now.
    expect(pr.dedupeKey.startsWith('github:sha256:')).toBe(true);
  });

  it('fires the ACTIVE EVENT workflow → a WorkflowRun(source EVENT) was created', async () => {
    const runs = await pollEventRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].source).toBe('EVENT');
  });

  it('a bad signature → 401 and no additional canonical event', async () => {
    const before = await prisma.canonicalEvent.count({ where: { connectorId } });
    await postWebhook(body, {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': randomUUID(),
      'X-Hub-Signature-256': 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    }).expect(401);
    await sleep(500);
    const after = await prisma.canonicalEvent.count({ where: { connectorId } });
    expect(after).toBe(before);
  });

  it('a duplicate delivery (same X-GitHub-Delivery) is deduped → 200, still one Raw/Canonical', async () => {
    const res = await postWebhook(body, {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': delivery, // same as the accepted delivery above
      'X-Hub-Signature-256': githubSig(body),
    }).expect(200);
    expect(res.body.deduped).toBe(true);

    // Dedupe now keys on a hash of the signed body (externalId = `sha256:…`),
    // so this connector holds exactly one RawEvent for the one body posted.
    const rawCount = await prisma.rawEvent.count({ where: { connectorId } });
    expect(rawCount).toBe(1);
    const canonCount = await prisma.canonicalEvent.count({ where: { connectorId } });
    expect(canonCount).toBe(1);
  });

  it('SECURITY: a replay of the signed body with a MUTATED delivery header is still deduped', async () => {
    // The HMAC covers the body but not the delivery header. An attacker replays
    // the identical signed body while changing X-GitHub-Delivery to try to mint a
    // fresh RawEvent → new run. Body-hash dedupe must defeat this.
    const before = await prisma.rawEvent.count({ where: { connectorId } });
    const res = await postWebhook(body, {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': randomUUID(), // mutated — different from the original
      'X-Hub-Signature-256': githubSig(body), // same signed body
    }).expect(200);
    expect(res.body.deduped).toBe(true);
    const after = await prisma.rawEvent.count({ where: { connectorId } });
    expect(after).toBe(before); // no new RawEvent → no amplified run
  });

  it('an unknown connector id → 404 (no auth)', async () => {
    await request(server())
      .post('/connectors/does-not-exist/webhook')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', randomUUID())
      .set('X-Hub-Signature-256', githubSig(body))
      .send(body)
      .expect(404);
  });

  it('the observability reads require auth (401 without a token)', async () => {
    await request(server())
      .get(`/connectors/${connectorId}/events?kind=canonical`)
      .expect(401);
    await request(server()).get('/events/canonical').expect(401);
  });

  it('GET /events/canonical returns the company feed (authed, type filter)', async () => {
    const res = await request(server())
      .get('/events/canonical?type=NEW_GITHUB_PR&limit=10')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.every((e: { type: string }) => e.type === 'NEW_GITHUB_PR')).toBe(true);
  });
});
