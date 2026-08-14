import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ConnectorHealthService } from '../src/modules/skills/connectors/connector-health.service';
import { ConnectorTokenService } from '../src/modules/skills/connectors/connector-token.service';
import { MetricsRegistry } from '../src/common/observability/metrics.registry';

// Connector health / DEGRADED lifecycle + single-flight token refresh e2e (Unit
// B). The single-flight UNIT block always runs (no DB / no network — a stubbed
// prisma + fetch). The lifecycle block needs Postgres + Redis (skipped when
// DATABASE_URL is unset). Run the whole suite with:
//   SKILL_EXECUTOR=mock BILLING_PROVIDER=mock EMBEDDINGS_PROVIDER=hash \
//   LLM_PROVIDER=mock STORAGE_PROVIDER=local ENCRYPTION_KEY=<64hex> \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

// --- Unit: single-flight OAuth token refresh (no DB / no network) ------------
describe('ConnectorTokenService single-flight refresh (stubbed prisma + fetch)', () => {
  // A ConfigService stub carrying the google OAuth client config the refresh
  // needs (ENCRYPTION_KEY is unset → CryptoService derives its dev key).
  const config = {
    get: (key: string) =>
      ({
        OAUTH_GOOGLE_CLIENT_ID: 'gcid',
        OAUTH_GOOGLE_CLIENT_SECRET: 'gsecret',
        OAUTH_REDIRECT_BASE: 'https://api.example.com',
      })[key],
  } as unknown as ConfigService;
  const crypto = new CryptoService(config);

  /** A connector row with an expired OAuth token + a refresh token. */
  function connectorRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'con_1',
      companyId: 'co_1',
      skillKey: 'gmail',
      connectionType: 'oauth',
      credentials: {
        enc: crypto.encryptJson({
          accessToken: 'old-token',
          refreshToken: 'refresh-1',
        }),
      },
      tokenExpiresAt: new Date(Date.now() - 1000), // already expired
      ...overrides,
    };
  }

  function makePrisma(row: Record<string, unknown>) {
    return {
      installedSkill: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
    };
  }

  it('concurrent getAccessToken calls trigger exactly ONE token-endpoint call', async () => {
    const prisma = makePrisma(connectorRow());
    const health = { markDisconnected: jest.fn() };
    const fetchStub = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-token',
        expires_in: 3600,
        refresh_token: 'refresh-2',
      }),
    });

    const svc = new ConnectorTokenService(
      prisma as never,
      crypto,
      config,
      health as never,
      fetchStub as never,
      new MetricsRegistry(),
    );

    const results = await Promise.all([
      svc.getAccessToken('con_1'),
      svc.getAccessToken('con_1'),
      svc.getAccessToken('con_1'),
    ]);

    // All callers received the fresh token, but the provider was hit ONCE.
    expect(results).toEqual(['new-token', 'new-token', 'new-token']);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(prisma.installedSkill.update).toHaveBeenCalledTimes(1);

    // The refreshed tokens were re-encrypted + persisted and status restored.
    const updateArg = prisma.installedSkill.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'con_1' });
    expect(updateArg.data.connectionStatus).toBe('CONNECTED');
    expect(updateArg.data.tokenExpiresAt).toBeInstanceOf(Date);
    const decrypted = crypto.decryptJson<{
      accessToken: string;
      refreshToken: string;
    }>((updateArg.data.credentials as { enc: string }).enc);
    expect(decrypted.accessToken).toBe('new-token');
    expect(decrypted.refreshToken).toBe('refresh-2');
    expect(health.markDisconnected).not.toHaveBeenCalled();
  });

  it('does NOT refresh when the token is still valid (returns the stored token)', async () => {
    const prisma = makePrisma(
      connectorRow({ tokenExpiresAt: new Date(Date.now() + 3_600_000) }),
    );
    const health = { markDisconnected: jest.fn() };
    const fetchStub = jest.fn();
    const svc = new ConnectorTokenService(
      prisma as never,
      crypto,
      config,
      health as never,
      fetchStub as never,
      new MetricsRegistry(),
    );

    const token = await svc.getAccessToken('con_1');
    expect(token).toBe('old-token');
    expect(fetchStub).not.toHaveBeenCalled();
    expect(prisma.installedSkill.update).not.toHaveBeenCalled();
  });

  it('invalid_grant on refresh → connector DISCONNECTED + throws', async () => {
    const prisma = makePrisma(connectorRow());
    const health = { markDisconnected: jest.fn() };
    const fetchStub = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    });
    const svc = new ConnectorTokenService(
      prisma as never,
      crypto,
      config,
      health as never,
      fetchStub as never,
      new MetricsRegistry(),
    );

    await expect(svc.getAccessToken('con_1')).rejects.toThrow(/invalid_grant/);
    expect(health.markDisconnected).toHaveBeenCalledWith(
      'con_1',
      expect.stringContaining('invalid_grant'),
    );
    // A revoked grant must NOT persist new (nonexistent) tokens.
    expect(prisma.installedSkill.update).not.toHaveBeenCalled();
  });
});

// --- DB-gated: CONNECTED → DEGRADED → CONNECTED lifecycle + endpoints --------
describeIfDb('Connector health lifecycle e2e (DEGRADED ↔ CONNECTED + endpoints)', () => {
  let app: INestApplication;
  let health: ConnectorHealthService;
  const email = `conn_health_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let companyId = '';
  let connectorId = '';

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    health = app.get(ConnectorHealthService);
    // Prove the app is wired (PrismaService resolvable) — mirrors sibling specs.
    expect(app.get(PrismaService)).toBeTruthy();

    const reg = await request(server())
      .post('/auth/register')
      .send({ companyName: 'Conn Health Co', name: 'Owner', email, password })
      .expect(201);
    accessToken = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;

    // Install + connect a github connector → CONNECTED.
    const install = await request(server())
      .post('/skills/install')
      .set(auth())
      .send({ skillKey: 'github' })
      .expect(201);
    connectorId = install.body.id;
    const connected = await request(server())
      .post(`/skills/installed/${connectorId}/connect`)
      .set(auth())
      .send({ credentials: { apiKey: 'ghp_test' } })
      .expect(201);
    expect(connected.body.connectionStatus).toBe('CONNECTED');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /connectors/:id/health → CONNECTED, zero errors (freshly connected)', async () => {
    const res = await request(server())
      .get(`/connectors/${connectorId}/health`)
      .set(auth())
      .expect(200);
    expect(res.body.connectorId).toBe(connectorId);
    expect(res.body.status).toBe('CONNECTED');
    expect(res.body.consecutiveErrors).toBe(0);
    expect(res.body.lastHealthError).toBeNull();
  });

  it('≥N consecutive egress failures (test seam) → DEGRADED + consecutiveErrors≥N', async () => {
    // Internal test hook: drive the passive egress signal directly. N = 3.
    for (let i = 0; i < 3; i += 1) {
      await health.recordFailure(companyId, 'github', 'simulated egress 5xx');
    }
    const res = await request(server())
      .get(`/connectors/${connectorId}/health`)
      .set(auth())
      .expect(200);
    expect(res.body.status).toBe('DEGRADED');
    expect(res.body.consecutiveErrors).toBeGreaterThanOrEqual(3);
    expect(res.body.lastHealthError).toContain('simulated egress');
  });

  it('POST /connectors/:id/health-check (mock probe healthy) → CONNECTED, counter reset', async () => {
    const res = await request(server())
      .post(`/connectors/${connectorId}/health-check`)
      .set(auth())
      .expect(200);
    expect(res.body.status).toBe('CONNECTED');
    expect(res.body.consecutiveErrors).toBe(0);
    expect(res.body.lastHealthError).toBeNull();
    expect(typeof res.body.lastHealthCheckAt).toBe('string');
  });

  it('a successful egress signal keeps a CONNECTED connector healthy', async () => {
    await health.recordSuccess(companyId, 'github');
    const res = await request(server())
      .get(`/connectors/${connectorId}/health`)
      .set(auth())
      .expect(200);
    expect(res.body.status).toBe('CONNECTED');
    expect(res.body.consecutiveErrors).toBe(0);
  });

  it('health reads require auth (401) and unknown connector → 404', async () => {
    await request(server()).get(`/connectors/${connectorId}/health`).expect(401);
    await request(server())
      .get('/connectors/does-not-exist/health')
      .set(auth())
      .expect(404);
  });
});
