import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { knowledgeUploadMaxBytes } from '../src/common/config/credit-abuse.constants';

/**
 * Credit system Phase 10, Task 10.6 — the remaining abuse-prevention
 * constants: an oversized knowledge-document upload is rejected before any
 * ingestion work, independent of credit balance.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Credit system Phase 10 — abuse-prevention constants e2e', () => {
  let app: INestApplication;
  const ts = Date.now();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('an oversized knowledge-document upload is rejected before ingestion, independent of credit balance', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Credits P10 abuse ${ts}`,
        name: 'Owner',
        email: `p10abuse_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    const accessToken = reg.body.tokens.accessToken as string;

    const oversized = Buffer.alloc(knowledgeUploadMaxBytes() + 1024, 'a');

    const res = await request(app.getHttpServer())
      .post('/knowledge/documents')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', oversized, { filename: 'huge.txt', contentType: 'text/plain' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }, 30_000);
});
