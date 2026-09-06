import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import twilio from 'twilio';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { CanonicalIngestService } from '../../events/ingestion/canonical-ingest.service';
import { AuditLogService } from '../../audit/audit-log.service';

describe('WhatsappWebhookController', () => {
  let app: INestApplication;
  const prisma = { whatsAppAccount: { findFirst: jest.fn() }, lead: { upsert: jest.fn() } };
  const crypto = { decrypt: jest.fn((v: string) => v) };
  const ingest = { ingestVerified: jest.fn().mockResolvedValue({ deduped: false, rawEventId: 'evt_1' }) };
  const audit = { record: jest.fn() };
  const AUTH_TOKEN = 'test-auth-token';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
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
    await app.init();
  });

  afterAll(async () => app.close());

  it('rejects a request with no signature header before touching the database', async () => {
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .send({ MessageSid: 'MM1', From: 'whatsapp:+15550002222', Body: 'hi' })
      .expect(401);
    expect(prisma.whatsAppAccount.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a request for an unknown sender number', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue(null);
    const params = { MessageSid: 'MM1', From: 'whatsapp:+15550002222', To: 'whatsapp:+19990000000', Body: 'hi' };
    // NOTE: matching twilio-whatsapp-client.service.spec.ts's own correction —
    // getExpectedTwilioSignature's actual installed signature is
    // (authToken: string, url, params), NOT ({ authToken } as any, url, params)
    // (the object form throws inside crypto.createHmac). The brief's literal
    // test snippet had the object form; using the bare string here is the
    // corrected, working call.
    const url = 'http://127.0.0.1/engines/whatsapp/webhook';
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
    await request(app.getHttpServer())
      .post('/engines/whatsapp/webhook')
      .set('x-twilio-signature', signature)
      .send(params)
      .expect(401);
  });

  it('accepts a validly-signed request for a known account and ingests it', async () => {
    prisma.whatsAppAccount.findFirst.mockResolvedValue({
      id: 'wa_1',
      companyId: 'c_1',
      twilioAuthToken: AUTH_TOKEN,
      whatsappSenderNumber: '+19990000000',
    });
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
});
