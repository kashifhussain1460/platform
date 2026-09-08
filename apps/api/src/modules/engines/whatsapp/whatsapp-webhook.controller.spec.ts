import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import twilio from 'twilio';
import { configureApp } from '../../../bootstrap';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { CanonicalIngestService } from '../../events/ingestion/canonical-ingest.service';
import { AuditLogService } from '../../audit/audit-log.service';

describe('WhatsappWebhookController', () => {
  let app: INestApplication;
  const prisma = {
    whatsAppAccount: { findFirst: jest.fn() },
    lead: { upsert: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
    conversation: { create: jest.fn() },
    message: { create: jest.fn() },
    aiEmployee: { findFirst: jest.fn() },
  };
  const crypto = { decrypt: jest.fn((v: string) => v) };
  const ingest = { ingestVerified: jest.fn().mockResolvedValue({ deduped: false, rawEventId: 'evt_1' }) };
  const audit = { record: jest.fn() };
  const AUTH_TOKEN = 'test-auth-token';

  const ACCOUNT = {
    id: 'wa_1',
    companyId: 'c_1',
    employeeId: null,
    twilioAuthToken: AUTH_TOKEN,
    whatsappSenderNumber: '+19990000000',
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      // ConfigModule so `configureApp` (which reads WEB_ORIGIN) can run against
      // this test app — the point being that the trust-proxy assertion below
      // exercises the REAL production bootstrap, not a setting invented here.
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [WhatsappWebhookController],
      providers: [
        { provide: TwilioWhatsappClientService, useValue: new TwilioWhatsappClientService({} as any, {} as any) },
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: crypto },
        { provide: CanonicalIngestService, useValue: ingest },
        { provide: AuditLogService, useValue: audit },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true } as any);
    configureApp(app);
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    ingest.ingestVerified.mockResolvedValue({ deduped: false, rawEventId: 'evt_1' });
    prisma.lead.upsert.mockResolvedValue({ id: 'lead_1', conversationId: null });
    prisma.lead.updateMany.mockResolvedValue({ count: 1 });
    prisma.conversation.create.mockResolvedValue({ id: 'conv_1' });
    prisma.message.create.mockResolvedValue({ id: 'msg_1' });
    prisma.aiEmployee.findFirst.mockResolvedValue({ id: 'emp_sales' });
  });

  it('rejects a request with no signature header before touching the database', async () => {
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .send({ MessageSid: 'MM1', From: 'whatsapp:+15550002222', Body: 'hi' })
      .expect(401);
    expect(prisma.whatsAppAccount.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a request for an unknown sender number', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue(null);
    // NOTE: matching twilio-whatsapp-client.service.spec.ts's own correction —
    // getExpectedTwilioSignature's actual installed signature is
    // (authToken: string, url, params), NOT ({ authToken } as any, url, params)
    // (the object form throws inside crypto.createHmac). The brief's literal
    // test snippet had the object form; using the bare string here is the
    // corrected, working call.
    const params = { MessageSid: 'MM1', From: 'whatsapp:+15550002222', To: 'whatsapp:+19990000000', Body: 'hi' };
    const url = 'http://127.0.0.1/engines/whatsapp/webhook';
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .set('x-twilio-signature', signature)
      .send(params)
      .expect(401);
    expect(prisma.lead.upsert).not.toHaveBeenCalled();
  });

  it('accepts a validly-signed request for a known account and ingests it', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue(ACCOUNT);
    const params = { MessageSid: 'MM2', From: 'whatsapp:+15550002222', To: 'whatsapp:+19990000000', Body: 'hi again' };
    const url = 'http://127.0.0.1/engines/whatsapp/webhook';
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .set('x-twilio-signature', signature)
      .send(params)
      .expect(200);
    expect(ingest.ingestVerified).toHaveBeenCalled();
  });

  /**
   * C2 — the regression that only appears once this is deployed.
   *
   * Twilio signs the PUBLIC url. Behind a proxy that is `https://…`, but
   * Express reports `req.protocol === 'http'` unless `trust proxy` is set — so
   * before `configureApp()` set it, every genuine production delivery failed
   * the HMAC check and got a false 401. The tests above only ever proved the
   * plain `http://127.0.0.1` case, which is why this went unnoticed.
   */
  it('verifies a proxied request against the https URL Twilio actually signed', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue(ACCOUNT);
    const params = { MessageSid: 'MM3', From: 'whatsapp:+15550002222', To: 'whatsapp:+19990000000', Body: 'proxied' };
    const signature = twilio.getExpectedTwilioSignature(
      AUTH_TOKEN,
      'https://api.example.com/engines/whatsapp/webhook',
      params,
    );
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .set('x-twilio-signature', signature)
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'api.example.com')
      .set('host', 'api.example.com')
      .send(params)
      .expect(200);
  });

  it('still rejects a proxied request signed against the wrong scheme', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue(ACCOUNT);
    const params = { MessageSid: 'MM4', From: 'whatsapp:+15550002222', To: 'whatsapp:+19990000000', Body: 'nope' };
    const signature = twilio.getExpectedTwilioSignature(
      AUTH_TOKEN,
      'http://api.example.com/engines/whatsapp/webhook',
      params,
    );
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .set('x-twilio-signature', signature)
      .set('x-forwarded-proto', 'https')
      .set('host', 'api.example.com')
      .send(params)
      .expect(401);
  });

  /**
   * C1 — the finding this whole feature turned on: nothing anywhere created a
   * `Lead`, so `/leads` was permanently empty and every `whatsapp.*` tool
   * answered "Lead not found".
   */
  describe('Lead / Conversation / Message creation', () => {
    const post = (params: Record<string, string>) => {
      const url = 'http://127.0.0.1/engines/whatsapp/webhook';
      const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
      return request(app.getHttpServer())
        .post('/engines/whatsapp/webhook')
        .set('x-twilio-signature', signature)
        .send(params);
    };

    it('upserts a Lead, opens a Conversation and appends the inbound Message', async () => {
      prisma.whatsAppAccount.findFirst.mockResolvedValue(ACCOUNT);
      await post({
        MessageSid: 'MM10',
        From: 'whatsapp:+15550002222',
        To: 'whatsapp:+19990000000',
        Body: 'I want a quote',
      }).expect(200);

      expect(prisma.lead.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.lead.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            companyId_source_phone: {
              companyId: 'c_1',
              source: 'WHATSAPP',
              phone: '+15550002222',
            },
          },
        }),
      );
      expect(prisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ companyId: 'c_1', employeeId: 'emp_sales' }),
        }),
      );
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          companyId: 'c_1',
          conversationId: 'conv_1',
          role: 'USER',
          content: 'I want a quote',
          idempotencyKey: 'whatsapp:MM10',
        },
      });
    });

    it('reuses the existing Lead and Conversation on a second message from the same number', async () => {
      prisma.whatsAppAccount.findFirst.mockResolvedValue(ACCOUNT);
      // The upsert resolves to the SAME lead, which already has a conversation.
      prisma.lead.upsert.mockResolvedValue({ id: 'lead_1', conversationId: 'conv_1' });

      await post({
        MessageSid: 'MM11',
        From: 'whatsapp:+15550002222',
        To: 'whatsapp:+19990000000',
        Body: 'still here',
      }).expect(200);

      expect(prisma.lead.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ conversationId: 'conv_1', content: 'still here' }),
        }),
      );
    });

    it('prefers the account-owning employee over the company SALES fallback', async () => {
      prisma.whatsAppAccount.findFirst.mockResolvedValue({ ...ACCOUNT, employeeId: 'emp_own' });
      await post({
        MessageSid: 'MM12',
        From: 'whatsapp:+15550003333',
        To: 'whatsapp:+19990000000',
        Body: 'hello',
      }).expect(200);

      expect(prisma.aiEmployee.findFirst).not.toHaveBeenCalled();
      expect(prisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ employeeId: 'emp_own' }) }),
      );
    });

    it('still records the Lead when no employee can be resolved', async () => {
      prisma.whatsAppAccount.findFirst.mockResolvedValue(ACCOUNT);
      prisma.aiEmployee.findFirst.mockResolvedValue(null);

      await post({
        MessageSid: 'MM13',
        From: 'whatsapp:+15550004444',
        To: 'whatsapp:+19990000000',
        Body: 'anyone there',
      }).expect(200);

      expect(prisma.lead.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('passes the resulting leadId into the canonical event payload', async () => {
      prisma.whatsAppAccount.findFirst.mockResolvedValue(ACCOUNT);
      await post({
        MessageSid: 'MM14',
        From: 'whatsapp:+15550005555',
        To: 'whatsapp:+19990000000',
        Body: 'quote please',
      }).expect(200);

      expect(ingest.ingestVerified).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ MessageSid: 'MM14', leadId: 'lead_1' }),
        }),
      );
    });
  });
});
