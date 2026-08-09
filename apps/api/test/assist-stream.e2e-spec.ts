import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * The SSE turn stream (doc 30 wave A3, §10).
 *
 * What matters here is the PROTOCOL, not the agent — the loop itself is covered
 * by `assist-agent.e2e-spec.ts`. Specifically: the right content type, the frame
 * ORDER the client depends on, and the guarantee that a turn always terminates
 * with exactly one `done` even when it fails. A client that trusts those and is
 * wrong hangs forever.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Parse an SSE body into frames, ignoring `: ping` heartbeat comments. */
function parseFrames(body: string): Frame[] {
  return body
    .split('\n\n')
    .map((raw) => raw.trim())
    .filter((raw) => raw && !raw.startsWith(':'))
    .map((raw) => {
      const lines = raw.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '';
      const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim() ?? '{}';
      return { event, data: JSON.parse(dataLine) as Record<string, unknown> };
    });
}

describeIfDb('Assist turn stream (SSE — doc 30 A3)', () => {
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

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Stream Co',
        name: 'Stella Owner',
        email: `stream_owner_${ts}@ex.com`,
        password,
      })
      .expect(201);
    token = reg.body.tokens.accessToken;

    await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(token))
      .send({ plan: 'BUSINESS' })
      .expect(201);

    // Something real for the agent to ground on.
    await request(app.getHttpServer())
      .post('/employees')
      .set(bearer(token))
      .send({ name: 'Emma', role: 'HR' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'slack' })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  const startSession = async (prompt: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/assist/sessions')
      .set(bearer(token))
      .send({ prompt })
      .expect(201);
    return res.body.id;
  };

  it('streams a turn as text/event-stream with the documented frame order', async () => {
    const sessionId = await startSession('Have HR screen CVs and post to Slack.');

    const res = await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns/stream`)
      // Empty text: the opening prompt is already stored, so the client just
      // opens the stream to have it answered rather than repeating itself.
      .send({ text: '' })
      .set(bearer(token))
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    // Buffering headers matter as much as the content type — without these a
    // proxy delivers the whole stream at the end and streaming looks broken.
    expect(res.headers['cache-control']).toContain('no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const frames = parseFrames(res.text);
    const kinds = frames.map((f) => f.event);

    expect(kinds).toContain('thinking');
    expect(kinds).toContain('tool');
    expect(kinds).toContain('token');
    expect(kinds).toContain('graph');

    // 🔑 Exactly one `done`, and it is LAST. Clients close on it.
    expect(kinds.filter((k) => k === 'done')).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe('done');

    // 🔑 `graph` precedes `done`, so the canvas is never behind the text.
    expect(kinds.indexOf('graph')).toBeLessThan(kinds.indexOf('done'));
    // …and follows the tool call that produced it.
    expect(kinds.indexOf('tool')).toBeLessThan(kinds.indexOf('graph'));

    // The graph frame carries a usable draft.
    const graph = frames.find((f) => f.event === 'graph')!;
    const definition = graph.data.definition as { nodes: unknown[] };
    expect(definition.nodes.length).toBeGreaterThan(1);
    expect(graph.data.version).toBeGreaterThan(0);

    // Tokens reassemble into the reply.
    const text = frames
      .filter((f) => f.event === 'token')
      .map((f) => String(f.data.text))
      .join('');
    expect(text.length).toBeGreaterThan(0);
  }, 40_000);

  it('persists the same turn it streamed, so a reload shows what the user saw', async () => {
    const sessionId = await startSession('Build something small.');
    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns/stream`)
      .send({ text: '' })
      .set(bearer(token))
      .expect(200);

    const session = await request(app.getHttpServer())
      .get(`/assist/sessions/${sessionId}`)
      .set(bearer(token))
      .expect(200);

    const assistant = (session.body.messages as { role: string; content: string }[]).find(
      (m) => m.role === 'ASSISTANT',
    );
    expect(assistant?.content.length).toBeGreaterThan(0);
    expect(session.body.draftDefinition).toBeTruthy();
  }, 40_000);

  it('reports a refusal INSIDE the stream, still ending with exactly one done', async () => {
    // Headers are already sent by the time a failure is known, so an error
    // cannot become an HTTP status — it has to be a frame. A client that only
    // handled `done` would otherwise wait forever.
    const sessionId = await startSession('Budget test.');
    await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns`)
      .set(bearer(token))
      .send({ text: 'first turn' })
      .expect(201);

    // Force the session over its budget.
    const prisma = app.get(PrismaService);
    await prisma.assistSession.update({
      where: { id: sessionId },
      data: { promptTokens: 400_000, completionTokens: 1, status: 'EXHAUSTED' },
    });

    const res = await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns/stream`)
      .send({ text: 'keep going' })
      .set(bearer(token))
      // Still 200: the stream opened successfully, the refusal is its content.
      .expect(200);

    const frames = parseFrames(res.text);
    const kinds = frames.map((f) => f.event);
    expect(kinds).toContain('error');
    expect(kinds.filter((k) => k === 'done')).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe('done');

    const error = frames.find((f) => f.event === 'error')!;
    expect(String(error.data.message)).toMatch(/budget/i);
    // A 4xx is the user's to act on — not something to retry automatically.
    expect(error.data.retryable).toBe(false);
  }, 40_000);

  it('will not stream another tenant\'s session', async () => {
    const sessionId = await startSession('Private.');
    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Other Stream Co',
        name: 'Otto',
        email: `stream_other_${ts}@ex.com`,
        password,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(bearer(other.body.tokens.accessToken))
      .send({ plan: 'BUSINESS' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/assist/sessions/${sessionId}/turns/stream`)
      .send({ text: 'let me in' })
      .set(bearer(other.body.tokens.accessToken))
      .expect(200);

    const frames = parseFrames(res.text);
    expect(frames.map((f) => f.event)).toContain('error');
    // Never leaks a graph across tenants.
    expect(frames.map((f) => f.event)).not.toContain('graph');
  }, 40_000);
});
