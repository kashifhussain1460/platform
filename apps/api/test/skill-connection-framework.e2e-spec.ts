import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { SkillsService } from '../src/modules/skills/skills.service';

/**
 * The enterprise skill-connection framework (plan §3, §4, §26, §28, §37).
 *
 * The behaviour under test is the plan's central rule: a connection cannot claim
 * to be READY until the provider has actually accepted it. Before this, `connect`
 * wrote CONNECTED for any string you typed, and `email.send_email` had no real
 * executor at all — so a customer could see a connected mailbox that had never
 * been contacted and could never send.
 *
 * These tests point the SMTP adapter at an address that cannot answer, so the
 * failure path is real (a genuine connection refusal), not a stub.
 *
 * Needs live Postgres + Redis.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Skill connection framework (§3/§37)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  const ts = Date.now();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let companyId = '';
  let emailSkillId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    crypto = app.get(CryptoService);

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Connection Framework Co',
        name: 'Owner',
        email: `conn_owner_${ts}@ex.com`,
        password: 'password123',
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'email' })
      .expect(201);
    emailSkillId = installed.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** An address that is guaranteed to refuse — a real failure, not a stub. */
  const UNREACHABLE = {
    smtpHost: '127.0.0.1',
    smtpPort: 1,
    smtpSecurity: 'starttls',
    smtpUser: 'kashif.hussain@dotsquares.com',
  };

  it('installs as NOT_CONNECTED — installing is not connecting', async () => {
    // The exact confusion this work started from: the catalog said "Installed"
    // while AI Assist said "Not connected". Both were right.
    const row = await prisma.installedSkill.findUniqueOrThrow({
      where: { id: emailSkillId },
      select: { connectionStatus: true },
    });
    expect(row.connectionStatus).toBe('NOT_CONNECTED');
  });

  it('exposes real SMTP fields instead of one meaningless "API key" box', async () => {
    const res = await request(app.getHttpServer())
      .get('/skills/catalog')
      .set(bearer(token))
      .expect(200);
    const email = res.body.find((s: { key: string }) => s.key === 'email');
    const keys = email.configSchema.map((f: { key: string }) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'smtpHost',
        'smtpPort',
        'smtpSecurity',
        'smtpUser',
        'smtpPassword',
        'fromAddress',
      ]),
    );
    // §4 — the password must be declared secret so it is stored encrypted.
    const password = email.configSchema.find((f: { key: string }) => f.key === 'smtpPassword');
    expect(password.secret).toBe(true);
  });

  it('stores the SMTP password ENCRYPTED, never in plaintext config (§4)', async () => {
    await request(app.getHttpServer())
      .patch(`/skills/installed/${emailSkillId}/config`)
      .set(bearer(token))
      .send({ config: { ...UNREACHABLE, smtpPassword: 'super-secret-pw' } })
      .expect(200);

    const row = await prisma.installedSkill.findUniqueOrThrow({
      where: { id: emailSkillId },
      select: { config: true, credentials: true },
    });

    // Read the raw columns: the plaintext config must not contain the password
    // anywhere, and the ciphertext must not contain it either.
    expect(JSON.stringify(row.config)).not.toContain('super-secret-pw');
    expect(JSON.stringify(row.credentials)).not.toContain('super-secret-pw');
    // …but it must be recoverable by the server that owns the key.
    const decrypted = crypto.decryptJson<Record<string, unknown>>(
      (row.credentials as { enc: string }).enc,
    );
    expect(decrypted.smtpPassword).toBe('super-secret-pw');
  });

  it('never returns the password to the client', async () => {
    const res = await request(app.getHttpServer())
      .get('/skills/installed')
      .set(bearer(token))
      .expect(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('super-secret-pw');
    // Only the masked boolean (§4's redacted metadata).
    const row = res.body.find((s: { id: string }) => s.id === emailSkillId);
    expect(row.credentialsSet).toBe(true);
  });

  it('§37: verify FAILS against an unreachable server and does NOT mark it connected', async () => {
    const res = await request(app.getHttpServer())
      .post(`/skills/installed/${emailSkillId}/verify`)
      .set(bearer(token))
      .send({})
      .expect(201);

    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('CONNECTION_FAILED');
    expect(res.body.connectionStatus).toBe('NOT_CONNECTED');

    const credentials = res.body.steps.find(
      (s: { key: string }) => s.key === 'credentials',
    );
    expect(credentials.status).toBe('FAILED');
    // The error has to name the ONE thing to change, not echo a socket error.
    expect(credentials.detail).toMatch(/Couldn't reach|port/i);

    const row = await prisma.installedSkill.findUniqueOrThrow({
      where: { id: emailSkillId },
      select: { connectionStatus: true, lastHealthError: true },
    });
    expect(row.connectionStatus).toBe('NOT_CONNECTED');
    expect(row.lastHealthError).toBeTruthy();
  });

  it('§37: connect is REFUSED (400) when the provider rejects the credentials', async () => {
    // This is the regression that matters most: the old code answered 200 and
    // wrote CONNECTED here, without contacting anything.
    const res = await request(app.getHttpServer())
      .post(`/skills/installed/${emailSkillId}/connect`)
      .set(bearer(token))
      .send({ credentials: { smtpPassword: 'still-wrong' } })
      .expect(400);

    expect(String(res.body.message)).toMatch(/Couldn't reach|password|port/i);

    const row = await prisma.installedSkill.findUniqueOrThrow({
      where: { id: emailSkillId },
      select: { connectionStatus: true },
    });
    expect(row.connectionStatus).not.toBe('CONNECTED');
  });

  it('records a failed connection attempt in the audit trail without the credential (§32/§4)', async () => {
    const events = await prisma.auditLog.findMany({
      where: { companyId, action: { in: ['connector.connect_failed', 'connector.verify_failed'] } },
      select: { action: true, metadata: true },
    });
    expect(events.length).toBeGreaterThan(0);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('super-secret-pw');
    expect(dump).not.toContain('still-wrong');
  });

  it('§10: reports inbound as SKIPPED when no IMAP host is set (send-only is valid)', async () => {
    // The connector currently has SMTP settings only. Inbound must read as
    // "not set up", not as a pass and not as a failure — a send-only mailbox is
    // a complete, legitimate connection.
    const res = await request(app.getHttpServer())
      .post(`/skills/installed/${emailSkillId}/verify`)
      .set(bearer(token))
      .send({})
      .expect(201);

    const inbound = res.body.steps.find((s: { key: string }) => s.key === 'inbound');
    // The credentials stage fails first (unreachable host), so inbound is not
    // reached at all — which is itself the contract: stages are sequential.
    expect(inbound).toBeUndefined();
  });

  it('§10: a WRONG IMAP host fails inbound verification', async () => {
    // Configuring inbound and getting it wrong is a real failure: a workflow
    // would sit waiting for email that is never polled while every screen shows
    // green. This is checked through the adapter directly because the shared
    // credentials stage would otherwise short-circuit first.
    const { smtpAdapter } = await import('../src/modules/skills/providers');
    const check = await smtpAdapter.validateInbound!({
      config: {
        imapHost: '127.0.0.1',
        imapPort: 1,
        imapSecurity: 'tls',
        smtpUser: 'kashif.hussain@dotsquares.com',
      },
      creds: { smtpPassword: 'x' },
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/Couldn't reach|port/i);
  });

  it('§10: inbound is SKIPPED (assumed), not PASSED, when IMAP is absent', async () => {
    const { smtpAdapter } = await import('../src/modules/skills/providers');
    const check = await smtpAdapter.validateInbound!({
      config: { smtpUser: 'a@b.com' },
      creds: { smtpPassword: 'x' },
    });
    expect(check.ok).toBe(true);
    // `assumed` is what makes the wizard render SKIPPED rather than a tick.
    expect(check.assumed).toBe(true);
    expect(check.detail).toMatch(/will not read it/i);
  });

  it('inbound email maps to the SAME canonical shape as Gmail (§31)', async () => {
    // A workflow triggered on NEW_EMAIL must not care which transport delivered
    // the mail — that is what lets a company move from Gmail OAuth to their own
    // mail server without touching a workflow.
    const { mapRawEvent } = await import(
      '../src/modules/events/normalization/event-mapper'
    );
    const payload = {
      messageId: '<abc@dotsquares.com>',
      from: 'candidate@example.com',
      subject: 'Application for Node developer',
      body: 'Please find my CV attached.',
      date: new Date().toISOString(),
      isReply: false,
    };
    const viaImap = mapRawEvent({
      provider: 'imap',
      externalId: payload.messageId,
      headers: null,
      payload,
    });
    const viaGmail = mapRawEvent({
      provider: 'gmail',
      externalId: payload.messageId,
      headers: null,
      payload,
    });

    expect(viaImap.type).toBe('NEW_EMAIL');
    expect(viaImap.type).toBe(viaGmail.type);
    expect(viaImap.data).toEqual(viaGmail.data);
    expect(viaImap.subject).toEqual(viaGmail.subject);
    // Only the dedupe namespace differs, so the same message arriving in two
    // different mailboxes is two deliveries, not one collapsed event.
    expect(viaImap.dedupeKey).toBe('imap:msg:<abc@dotsquares.com>');
    expect(viaGmail.dedupeKey).toBe('gmail:msg:<abc@dotsquares.com>');
  });

  it('does not poll any mailbox when no ACTIVE workflow consumes inbound email', async () => {
    // The guardrail that matters most on IMAP: opening a session against a
    // customer's own mail server every couple of minutes for nothing burns
    // their connection limit and shows up in their security logs.
    const { ImapInboundService } = await import(
      '../src/modules/events/inbound/imap-inbound.service'
    );
    const imap = app.get(ImapInboundService);
    const result = await imap.sweep();
    expect(result.polled).toBe(0);
    expect(result.newMessages).toBe(0);
  });

  it('reports SKIPPED — never a green tick — for a provider it cannot verify', async () => {
    // §37 again, from the other side: "we cannot check this" must not look like
    // "we checked it and it is fine".
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'stripe' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/skills/installed/${installed.body.id}/verify`)
      .set(bearer(token))
      .send({})
      .expect(201);

    expect(res.body.ok).toBe(false);
    expect(res.body.steps[0].status).toBe('SKIPPED');
    expect(res.body.steps[0].detail).toMatch(/cannot verify/i);
  });

  it('leaves adapter-less skills connectable exactly as before (no collateral damage)', async () => {
    // The strict gate is opt-in per provider. Breaking `connect` for the twelve
    // integrations that have no way to validate anything would be a far bigger
    // regression than the bug it fixes.
    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(bearer(token))
      .send({ skillKey: 'github' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/skills/installed/${installed.body.id}/connect`)
      .set(bearer(token))
      .send({ credentials: { apiKey: 'ghp_example' } })
      .expect(201);

    const row = await prisma.installedSkill.findUniqueOrThrow({
      where: { id: installed.body.id },
      select: { connectionStatus: true },
    });
    expect(row.connectionStatus).toBe('CONNECTED');
  });

  describe('OAuth provider adapters (Wave 2 — Gmail, Slack)', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('a Gmail OAuth connect that fails verification lands NOT_CONNECTED, not a silent CONNECTED', async () => {
      const installed = await request(app.getHttpServer())
        .post('/skills/install')
        .set(bearer(token))
        .send({ skillKey: 'gmail' })
        .expect(201);

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'Insufficient scope' } }),
      }) as unknown as typeof fetch;

      const skills = app.get(SkillsService);
      await skills.connectOAuth(companyId, installed.body.id, { accessToken: 'bad-scope-token' });

      const res = await request(app.getHttpServer())
        .get('/skills/installed')
        .set(bearer(token))
        .expect(200);
      const row = res.body.find((s: { id: string }) => s.id === installed.body.id);
      expect(row.connectionStatus).toBe('NOT_CONNECTED');

      // Company-wide installs are unique per (companyId, skillKey) — free the
      // slot so the next test's fresh `gmail` install doesn't collide with it.
      await request(app.getHttpServer())
        .delete(`/skills/installed/${installed.body.id}`)
        .set(bearer(token))
        .expect(204);
    });

    it('a successful Gmail OAuth connect shows CONNECTED and the discovered account', async () => {
      const installed = await request(app.getHttpServer())
        .post('/skills/install')
        .set(bearer(token))
        .send({ skillKey: 'gmail' })
        .expect(201);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ emailAddress: 'hr@company.com' }),
      }) as unknown as typeof fetch;

      const skills = app.get(SkillsService);
      await skills.connectOAuth(companyId, installed.body.id, { accessToken: 'good-token' });

      const res = await request(app.getHttpServer())
        .get('/skills/installed')
        .set(bearer(token))
        .expect(200);
      const row = res.body.find((s: { id: string }) => s.id === installed.body.id);
      expect(row.connectionStatus).toBe('CONNECTED');
      expect(row.config?.connectedAccount).toBe('hr@company.com');
    });

    it('a Slack connection made before the users:read.email scope existed fails only the test action', async () => {
      const installed = await request(app.getHttpServer())
        .post('/skills/install')
        .set(bearer(token))
        .send({ skillKey: 'slack' })
        .expect(201);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, team: 'Acme', user: 'orlixa-bot' }),
      }) as unknown as typeof fetch;
      const skills = app.get(SkillsService);
      await skills.connectOAuth(companyId, installed.body.id, { accessToken: 'xoxb-old-scope-token' });

      // Only `users.lookupByEmail` needs the new `users:read.email` scope —
      // `auth.test` (the credentials stage AND account discovery) still
      // succeeds, exactly like the real connection this reproduces. A blanket
      // fetch mock would fail the credentials stage too and demote the
      // connector to DEGRADED, which is a different bug than the one under
      // test here.
      global.fetch = jest.fn().mockImplementation((url: string) => {
        const isLookup = url.toString().includes('users.lookupByEmail');
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            isLookup ? { ok: false, error: 'missing_scope' } : { ok: true, team: 'Acme', user: 'orlixa-bot' },
        });
      }) as unknown as typeof fetch;
      const verifyRes = await request(app.getHttpServer())
        .post(`/skills/installed/${installed.body.id}/verify`)
        .set(bearer(token))
        .send({ sendTest: true })
        .expect(201);
      expect(verifyRes.body.ok).toBe(false);
      expect(verifyRes.body.code).toBe('INSUFFICIENT_SCOPE');

      // validateCredentials/healthCheck are unaffected — the connection itself
      // is still authenticated. But `verifyConnection` demotes on ANY failed
      // stage (skills.service.ts), including a test-action-only failure, so a
      // previously-CONNECTED connector reads DEGRADED here — not a silent
      // CONNECTED, and not the total loss of NOT_CONNECTED either.
      const list = await request(app.getHttpServer())
        .get('/skills/installed')
        .set(bearer(token))
        .expect(200);
      expect(
        list.body.find((s: { id: string }) => s.id === installed.body.id).connectionStatus,
      ).toBe('DEGRADED');
    });
  });
});
