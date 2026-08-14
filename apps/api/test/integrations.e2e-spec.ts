import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { OAuthService } from '../src/modules/skills/oauth/oauth.service';
import { SkillsService } from '../src/modules/skills/skills.service';
import { SKILL_EXECUTOR_TOKEN } from '../src/modules/skills/executors/skill-executor';
import { MockSkillExecutor } from '../src/modules/skills/executors/mock-skill-executor';
import { RealSkillExecutor } from '../src/modules/skills/executors/real-skill-executor';
import { AutoSkillExecutor } from '../src/modules/skills/executors/auto-skill-executor';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service';
import { PostizClientService } from '../src/modules/engines/marketing/postiz-client.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ChatwootClientService } from '../src/modules/engines/support/chatwoot-client.service';
import { PlaneClientService } from '../src/modules/engines/pm/plane-client.service';
import {
  assertUrlAllowed,
  isBlockedAddress,
} from '../src/modules/skills/executors/ssrf';

// Integrations e2e (real executors + OAuth + Stripe webhook), covering ONLY the
// behaviour that is verifiable OFFLINE. Real Slack/Gmail/HTTP calls, the real
// OAuth round-trip and real Stripe checkout+webhook are NOT exercised here (they
// need live credentials). The DB-gated block needs Postgres + Redis (skipped
// when DATABASE_URL is unset); the unit block always runs. Run with:
//   SKILL_EXECUTOR=mock BILLING_PROVIDER=mock LLM_PROVIDER=mock \
//   EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=... REDIS_URL=... JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

// --- Unit: OAuth signed-state (HMAC) — always runs, no DB / no network -------
describe('OAuth signed state (HMAC via CryptoService)', () => {
  const config = {
    get: (k: string) =>
      k === 'WEB_ORIGIN' ? 'http://localhost:3000' : undefined,
  } as unknown as ConfigService;
  const crypto = new CryptoService(config);
  // SkillsService is never reached in these paths (state parse fails / no code).
  // Prisma likewise: WAVE 2's one-time-state lookup happens only AFTER the state
  // parses and a code is present, and every case here fails before that.
  const oauth = new OAuthService(
    config,
    crypto,
    {} as SkillsService,
    {} as PrismaService,
  );

  const makeState = (iat: number): string => {
    const body = Buffer.from(
      JSON.stringify({
        installedSkillId: 'is_1',
        companyId: 'co_1',
        skillKey: 'gmail',
        nonce: 'n',
        iat,
      }),
    ).toString('base64url');
    return `${body}.${crypto.sign(body)}`;
  };

  it('CryptoService.sign/verify round-trips and rejects tampering', () => {
    const sig = crypto.sign('payload');
    expect(crypto.verify('payload', sig)).toBe(true);
    expect(crypto.verify('payload-2', sig)).toBe(false);
    expect(crypto.verify('payload', 'deadbeef')).toBe(false);
  });

  it('rejects a tampered/garbage state (invalid_state)', async () => {
    const garbage = await oauth.handleCallback('any-code', 'not.a.valid.state');
    expect(garbage).toContain('error=invalid_state');

    const good = makeState(Date.now());
    const tampered = `${good.slice(0, good.lastIndexOf('.'))}.deadbeef`;
    const url = await oauth.handleCallback('any-code', tampered);
    expect(url).toContain('error=invalid_state');
  });

  it('accepts a validly-signed state (fails later, NOT on the signature)', async () => {
    // code omitted → the signature verifies and parsing proceeds past state,
    // then fails on the missing code (proving verify() accepted the signature).
    const url = await oauth.handleCallback(undefined, makeState(Date.now()));
    expect(url).toContain('error=');
    expect(url).not.toContain('invalid_state');
  });

  it('rejects an expired but validly-signed state (state_expired)', async () => {
    const stale = makeState(Date.now() - 20 * 60 * 1000);
    const url = await oauth.handleCallback('any-code', stale);
    expect(url).toContain('error=state_expired');
  });
});

// --- Unit: SSRF guard for the real http.request executor — always runs -------
describe('SSRF guard (real http.request)', () => {
  it('classifies loopback/private/link-local/metadata as blocked', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.1.2.3')).toBe(true);
    expect(isBlockedAddress('172.16.5.4')).toBe(true);
    expect(isBlockedAddress('192.168.0.10')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true); // cloud metadata
    expect(isBlockedAddress('::1')).toBe(true);
    // Public addresses are allowed.
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
  });

  it('rejects non-http schemes and private IP literals (no DNS needed)', async () => {
    await expect(assertUrlAllowed('ftp://example.com', false)).rejects.toThrow();
    await expect(assertUrlAllowed('http://127.0.0.1/x', false)).rejects.toThrow();
    await expect(assertUrlAllowed('http://[::1]/x', false)).rejects.toThrow();
    await expect(assertUrlAllowed('http://localhost/x', false)).rejects.toThrow();
  });

  it('allows a public IP literal, and bypasses when allowPrivate=true', async () => {
    await expect(assertUrlAllowed('http://8.8.8.8/x', false)).resolves.toBeTruthy();
    // allowPrivate short-circuits the guard (local-dev escape hatch).
    await expect(assertUrlAllowed('http://127.0.0.1/x', true)).resolves.toBeTruthy();
  });
});

// --- DB-gated: auto executor fallback + authorize 400 + webhook 400 + mock ---
describeIfDb('Integrations e2e (auto executor · OAuth · Stripe webhook)', () => {
  let app: INestApplication;
  const email = `integrations_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let slackId = '';
  let gmailId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  beforeAll(async () => {
    // OAuth credentials are neutralised globally in test/setup-e2e-env.ts —
    // it must happen before ConfigModule.forRoot() runs at import time.
    // Force the AUTO executor for this app (the suite otherwise runs mock) so we
    // can prove an UNCONNECTED skill falls back to the offline mock (no network).
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SKILL_EXECUTOR_TOKEN)
      .useFactory({
        factory: (
          config: ConfigService,
          scheduling: SchedulingService,
          postizClient: PostizClientService,
          prisma: PrismaService,
          chatwootClient: ChatwootClientService,
          crypto: CryptoService,
          planeClient: PlaneClientService,
        ) => {
          const mock = new MockSkillExecutor();
          return new AutoSkillExecutor(
            new RealSkillExecutor(config, mock, scheduling, postizClient, prisma, chatwootClient, crypto, planeClient),
            mock,
          );
        },
        inject: [
          ConfigService,
          SchedulingService,
          PostizClientService,
          PrismaService,
          ChatwootClientService,
          CryptoService,
          PlaneClientService,
        ],
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Integrations Co', name: 'Integ Owner', email, password })
      .expect(201);
    accessToken = res.body.tokens.accessToken;

    const slack = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'slack' })
      .expect(201);
    slackId = slack.body.id;

    const gmail = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'gmail' })
      .expect(201);
    gmailId = gmail.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('auto: an UNCONNECTED skill tool falls back to the offline mock (ok)', async () => {
    // slack is installed but NOT connected → auto routes to mock (no real call).
    const res = await request(app.getHttpServer())
      .post(`/skills/installed/${slackId}/tools/send_message/execute`)
      .set(auth())
      .send({ args: { channel: '#general', text: 'hi' } })
      .expect(201);
    expect(res.body.ok).toBe(true);
    // The mock's deterministic sandbox signature proves it did NOT go real.
    expect(res.body.result?.sandbox).toBe(true);
    expect(res.body.skillKey).toBe('slack');
    expect(res.body.tool).toBe('send_message');
  });

  it('GET oauth/authorize with OAuth UNCONFIGURED → 400 (clear message)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/skills/installed/${gmailId}/oauth/authorize`)
      .set(auth())
      .expect(400);
    expect(String(res.body.message)).toContain('OAuth not configured');
  });

  it('GET oauth/authorize requires a token (401)', async () => {
    await request(app.getHttpServer())
      .get(`/skills/installed/${gmailId}/oauth/authorize`)
      .expect(401);
  });

  it('POST /billing/webhook with a bad/missing signature → 400 (public route)', async () => {
    // BILLING_PROVIDER=mock has no webhook support → 400 (not 401: route is public).
    await request(app.getHttpServer())
      .post('/billing/webhook')
      .send({ some: 'payload' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/billing/webhook')
      .set('stripe-signature', 'bogus')
      .send({ some: 'payload' })
      .expect(400);
  });

  it('POST /billing/subscription under mock switches immediately (no checkoutUrl)', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/subscription')
      .set(auth())
      .send({ plan: 'PRO' })
      .expect(201);
    expect(res.body.plan).toBe('PRO');
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.checkoutUrl).toBeUndefined();

    const after = await request(app.getHttpServer())
      .get('/billing/subscription')
      .set(auth())
      .expect(200);
    expect(after.body.plan).toBe('PRO');
  });
});
