import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Email verification (OTP). Mail is DISABLED in tests (MAIL_ENABLED unset), so
 * the OTP is the fixed dev code 123456 — the verify flow works end-to-end with
 * no live mailbox. Real DB/Redis; nothing mocked internally.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Auth — email verification (OTP, mail disabled → dev code 123456)', () => {
  let app: INestApplication;
  const ts = Date.now();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

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

  const registerFresh = async (tag: string) => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: `Verify ${tag} ${ts}`, name: 'Owner', email: `verify_${tag}_${ts}@ex.com`, password: 'password123' })
      .expect(201);
    return res.body.tokens.accessToken as string;
  };

  const me = async (token: string) => {
    const res = await request(app.getHttpServer()).get('/auth/me').set(bearer(token)).expect(200);
    return res.body as { user: { emailVerified: boolean } };
  };

  it('a new user starts unverified, a wrong code is rejected, 123456 verifies, and it is idempotent', async () => {
    const token = await registerFresh('happy');
    expect((await me(token)).user.emailVerified).toBe(false);

    // Wrong code → 400, still unverified.
    await request(app.getHttpServer())
      .post('/auth/verify-email')
      .set(bearer(token))
      .send({ code: '000000' })
      .expect(400);
    expect((await me(token)).user.emailVerified).toBe(false);

    // The dev OTP verifies.
    const ok = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .set(bearer(token))
      .send({ code: '123456' })
      .expect(201);
    expect(ok.body.verified).toBe(true);
    expect((await me(token)).user.emailVerified).toBe(true);

    // Verifying again is a safe no-op.
    const again = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .set(bearer(token))
      .send({ code: '123456' })
      .expect(201);
    expect(again.body.verified).toBe(true);
  }, 30_000);

  it('resend is cooldown-guarded right after register (429/409), and no-op once verified', async () => {
    const token = await registerFresh('resend');
    // register just issued a code → immediate resend hits the cooldown.
    await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .set(bearer(token))
      .expect(409);

    // Verify, then resend is a no-op (already verified).
    await request(app.getHttpServer())
      .post('/auth/verify-email')
      .set(bearer(token))
      .send({ code: '123456' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/auth/resend-verification')
      .set(bearer(token))
      .expect(201);
    expect(res.body.sent).toBe(false);
  }, 30_000);
});
