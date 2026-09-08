import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import twilio from 'twilio';
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ToolIdempotencyService } from '../src/common/idempotency/tool-idempotency.service';
import { SuppressionService } from '../src/modules/engines/marketing/suppression.service';
import { ChatwootClientService } from '../src/modules/engines/support/chatwoot-client.service';
import { PlaneClientService } from '../src/modules/engines/pm/plane-client.service';
import { PostizClientService } from '../src/modules/engines/marketing/postiz-client.service';
import { TwilioWhatsappClientService } from '../src/modules/engines/whatsapp/twilio-whatsapp-client.service';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service';
import { AutoSkillExecutor } from '../src/modules/skills/executors/auto-skill-executor';
import { MockSkillExecutor } from '../src/modules/skills/executors/mock-skill-executor';
import { RealSkillExecutor } from '../src/modules/skills/executors/real-skill-executor';
import { SKILL_EXECUTOR_TOKEN, type SkillExecutor } from '../src/modules/skills/executors/skill-executor';

/**
 * The WhatsApp lead pipeline, end to end over real HTTP.
 *
 * ## Why this suite exists
 *
 * Every other engine in this codebase has an e2e suite; WhatsApp shipped with
 * none, and the gap hid the feature's central defect: NOTHING anywhere created
 * a `Lead` row. `prisma.lead.create`/`upsert` appeared nowhere in the
 * repository. Every unit test passed, because each half was tested against a
 * mock of the other half — the webhook was asserted to call `ingestVerified`,
 * and the Leads service was asserted to read rows a fixture had put there.
 *
 * This test is deliberately the whole chain and nothing else:
 *
 *   signed Twilio POST → Lead row → GET /leads → GET /leads/:id (conversation
 *   + the customer's actual message)
 *
 * It is the single test that would have caught C1 directly.
 *
 * Needs a live Postgres + Redis (BullMQ, because the verified delivery is
 * handed to the canonical ingest queue). Skipped when DATABASE_URL is unset so
 * it never blocks a build.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const WEBHOOK_PATH = '/engines/whatsapp/webhook';
const AUTH_TOKEN = 'e2e-twilio-auth-token';
const SENDER = '+19995550000';

describeIfDb('WhatsApp lead pipeline e2e (signed webhook → Lead → /leads)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;

  const ts = Date.now();
  const password = 'password123';
  const leadPhone = `+1555${String(ts).slice(-7)}`;

  let accessToken = '';
  let companyId = '';
  let employeeId = '';
  let accountId = '';

  const server = () => app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  /**
   * Twilio signs the public request URL + the sorted form params.
   *
   * The SDK's `validateRequest` tries the URL both with and without its port,
   * so signing the port-less form here matches whatever ephemeral port
   * supertest binds to. (`twilio.getExpectedTwilioSignature`'s real signature
   * is `(authToken: string, url, params)` — the object form throws inside
   * `crypto.createHmac`.)
   */
  const postWebhook = (params: Record<string, string>) =>
    request(server())
      .post(WEBHOOK_PATH)
      .set(
        'x-twilio-signature',
        twilio.getExpectedTwilioSignature(AUTH_TOKEN, `http://127.0.0.1${WEBHOOK_PATH}`, params),
      )
      .send(params);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true } as never);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const reg = await request(server())
      .post('/auth/register')
      .send({
        companyName: `WA Leads Co ${ts}`,
        name: 'WA Owner',
        email: `wa_owner_${ts}@example.com`,
        password,
      })
      .expect(201);
    accessToken = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

    // The Sales AI Employee that will own the inbound conversation.
    const emp = await request(server())
      .post('/employees')
      .set(auth())
      .send({ name: 'Sam', role: 'SALES', persona: 'Qualifies inbound leads.' })
      .expect(201);
    employeeId = emp.body.id;

    // The connected WhatsApp number. Written directly rather than through
    // `POST /engines/whatsapp/accounts`, because that route now makes a REAL
    // Twilio credential call (I3) and there are no live Twilio credentials in
    // CI. The encryption goes through the app's own CryptoService so the
    // webhook's `decrypt` reads back the exact token it signs against.
    const crypto = app.get(CryptoService);
    const account = await prisma.whatsAppAccount.create({
      data: {
        companyId,
        employeeId,
        twilioAccountSid: 'ACe2e0000000000000000000000000000',
        twilioAuthToken: crypto.encrypt(AUTH_TOKEN),
        whatsappSenderNumber: SENDER,
        status: 'CONNECTED',
      },
    });
    accountId = account.id;
  }, 60_000);

  afterAll(async () => {
    if (prisma && companyId) {
      // Lead → Conversation is SetNull, and RawEvent/CanonicalEvent carry a
      // plain companyId, so clear them before the company cascade.
      await prisma.lead.deleteMany({ where: { companyId } });
      await prisma.canonicalEvent.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prisma.rawEvent.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prisma.company.deleteMany({ where: { id: companyId } });
    }
    await app?.close();
  });

  it('rejects an unsigned delivery', async () => {
    await request(server())
      .post(WEBHOOK_PATH)
      .send({ MessageSid: 'MMunsigned', From: `whatsapp:${leadPhone}`, To: `whatsapp:${SENDER}` })
      .expect(401);
  });

  it('creates a Lead with a Conversation and the inbound Message from one signed delivery', async () => {
    await postWebhook({
      MessageSid: `MM_${ts}_1`,
      From: `whatsapp:${leadPhone}`,
      To: `whatsapp:${SENDER}`,
      Body: 'Hi, how much for the enterprise plan?',
    }).expect(200);

    const leads = await prisma.lead.findMany({ where: { companyId } });
    expect(leads).toHaveLength(1);
    expect(leads[0].phone).toBe(leadPhone);
    expect(leads[0].source).toBe('WHATSAPP');
    expect(leads[0].conversationId).not.toBeNull();

    const messages = await prisma.message.findMany({
      where: { conversationId: leads[0].conversationId as string },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('USER');
    expect(messages[0].content).toBe('Hi, how much for the enterprise plan?');

    // The conversation belongs to the account's employee (I3/C1's resolution rule).
    const conversation = await prisma.conversation.findUnique({
      where: { id: leads[0].conversationId as string },
    });
    expect(conversation?.employeeId).toBe(employeeId);

    // And the canonical event carries the lead id the workflow template binds to.
    const raw = await prisma.rawEvent.findFirst({
      where: { companyId, connectorId: accountId },
      orderBy: { receivedAt: 'desc' },
    });
    expect((raw?.payload as { leadId?: string } | null)?.leadId).toBe(leads[0].id);
  });

  it('reuses the same Lead and thread for a second message from the same number', async () => {
    await postWebhook({
      MessageSid: `MM_${ts}_2`,
      From: `whatsapp:${leadPhone}`,
      To: `whatsapp:${SENDER}`,
      Body: 'Still interested.',
    }).expect(200);

    const leads = await prisma.lead.findMany({ where: { companyId } });
    expect(leads).toHaveLength(1);

    const messages = await prisma.message.findMany({
      where: { conversationId: leads[0].conversationId as string },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages.map((m: { content: string }) => m.content)).toEqual([
      'Hi, how much for the enterprise plan?',
      'Still interested.',
    ]);
  });

  it('does not duplicate the thread when Twilio redelivers the same message', async () => {
    const redelivery = {
      MessageSid: `MM_${ts}_2`,
      From: `whatsapp:${leadPhone}`,
      To: `whatsapp:${SENDER}`,
      Body: 'Still interested.',
    };
    await postWebhook(redelivery).expect(200);

    const leads = await prisma.lead.findMany({ where: { companyId } });
    expect(leads).toHaveLength(1);
    const messages = await prisma.message.findMany({
      where: { conversationId: leads[0].conversationId as string },
    });
    expect(messages).toHaveLength(2);
  });

  it('shows the lead on GET /leads', async () => {
    const res = await request(server()).get('/leads').set(auth()).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      phone: leadPhone,
      source: 'WHATSAPP',
      status: 'NEW',
    });
  });

  it('shows the conversation with the inbound messages on GET /leads/:id', async () => {
    const list = await request(server()).get('/leads').set(auth()).expect(200);
    const leadId = list.body[0].id as string;

    const res = await request(server()).get(`/leads/${leadId}`).set(auth()).expect(200);
    expect(res.body.conversation).not.toBeNull();
    expect(res.body.conversation.employeeId).toBe(employeeId);
    expect(res.body.conversation.messages.map((m: { content: string }) => m.content)).toEqual([
      'Hi, how much for the enterprise plan?',
      'Still interested.',
    ]);
  });

  it('does not leak the lead to another company', async () => {
    const other = await request(server())
      .post('/auth/register')
      .send({
        companyName: `WA Other Co ${ts}`,
        name: 'Other Owner',
        email: `wa_other_${ts}@example.com`,
        password,
      })
      .expect(201);
    const otherToken = other.body.tokens.accessToken as string;
    const otherCompanyId = other.body.user.companyId as string;

    try {
      const res = await request(server())
        .get('/leads')
        .set({ Authorization: `Bearer ${otherToken}` })
        .expect(200);
      expect(res.body).toEqual([]);
    } finally {
      await prisma.company.deleteMany({ where: { id: otherCompanyId } });
    }
  });

  /**
   * Real-Estate-flavored site-visit round-trip.
   *
   * `leads.record_site_visit` (the `leads` skill added alongside this
   * workflow) needs no external credentials (`connection: { type: 'none' }`
   * in the catalog), so `AutoSkillExecutor` always routes it to the REAL
   * executor regardless of connection status — the same
   * `.overrideProvider(SKILL_EXECUTOR_TOKEN)` technique
   * `integrations.e2e-spec.ts` uses to force a non-default executor for one
   * dedicated app. This suite's ambient `SKILL_EXECUTOR=mock` would otherwise
   * answer from the side-effect-free `MockSkillExecutor`, which never writes
   * to the Lead row — the whole point of this case is proving the DB write
   * really happens, not a sandboxed echo of the args.
   */
  describe('leads.record_site_visit through the live executor', () => {
    let executorApp: INestApplication;

    beforeAll(async () => {
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(SKILL_EXECUTOR_TOKEN)
        .useFactory({
          factory: (
            config: ConfigService,
            scheduling: SchedulingService,
            postizClient: PostizClientService,
            prismaSvc: PrismaService,
            chatwootClient: ChatwootClientService,
            crypto: CryptoService,
            planeClient: PlaneClientService,
            idempotency: ToolIdempotencyService,
            suppression: SuppressionService,
            twilioWhatsappClient: TwilioWhatsappClientService,
          ) => {
            const mock = new MockSkillExecutor();
            return new AutoSkillExecutor(
              new RealSkillExecutor(
                config,
                mock,
                scheduling,
                postizClient,
                prismaSvc,
                chatwootClient,
                crypto,
                planeClient,
                idempotency,
                suppression,
                false,
                twilioWhatsappClient,
              ),
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
            ToolIdempotencyService,
            SuppressionService,
            TwilioWhatsappClientService,
          ],
        })
        .compile();
      executorApp = moduleRef.createNestApplication();
      await executorApp.init();
    });

    afterAll(async () => {
      await executorApp?.close();
    });

    it('records a site visit and it round-trips through GET /leads/:id', async () => {
      const visitPhone = `+1555${String(ts + 1).slice(-7)}`;
      await postWebhook({
        MessageSid: `MM_${ts}_visit`,
        From: `whatsapp:${visitPhone}`,
        To: `whatsapp:${SENDER}`,
        Body: 'Can we schedule a viewing this weekend?',
      }).expect(200);

      const created = await prisma.lead.findFirst({ where: { companyId, phone: visitPhone } });
      expect(created).not.toBeNull();
      const leadId = (created as { id: string }).id;

      const eventId = `evt_${ts}_visit`;
      const start = '2026-09-12T15:00:00.000Z';

      const executor = executorApp.get<SkillExecutor>(SKILL_EXECUTOR_TOKEN);
      const result = await executor.execute(
        'leads',
        'record_site_visit',
        { leadId, eventId, start },
        { companyId },
      );
      expect(result.ok).toBe(true);

      const res = await request(server()).get(`/leads/${leadId}`).set(auth()).expect(200);
      expect(res.body.qualificationData).toMatchObject({
        siteVisitAt: start,
        siteVisitEventId: eventId,
      });
    });
  });
});
