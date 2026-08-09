import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/modules/mail/mail.service';

/**
 * OTP-based forgot / reset password against the real stack. Only the EXTERNAL
 * mail sender is stubbed; the OTP hashing, the reset-token model, the DB, and
 * every endpoint are real. The dev OTP is the fixed 123456 (mail disabled).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const DEV_OTP = '123456';
const otpSends: string[] = []; // emails that were sent a reset OTP
const mailStub = {
  enabled: () => false,
  generateOtp: () => DEV_OTP,
  sendVerificationOtp: jest.fn(async () => undefined),
  sendPasswordResetOtp: jest.fn(async (to: string) => {
    otpSends.push(to);
  }),
  sendPasswordChanged: jest.fn(async () => undefined),
  send: jest.fn(async () => undefined),
};

describeIfDb('Auth — forgot / reset password', () => {
  let app: INestApplication;
  const ts = Date.now();
  const email = `reset_${ts}@ex.com`;
  const oldPassword = 'password123';
  const newPassword = 'newpassword456';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue(mailStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: `Reset Co ${ts}`, name: 'Owner', email, password: oldPassword })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('forgot → OTP → reset → login with the new password (old password no longer works)', async () => {
    // A live session BEFORE the reset — it must be revoked by the reset.
    const preLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: oldPassword })
      .expect(201);
    const preResetCookie = ((preLogin.headers['set-cookie'] as unknown as string[]) ?? [])
      .find((c) => c.startsWith('vaep_refresh='))
      ?.split(';')[0] as string;

    otpSends.length = 0;
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(201);
    expect(otpSends).toContain(email);

    // A wrong code is rejected (generic 400) …
    await request(app.getHttpServer())
      .post('/auth/verify-reset-otp')
      .send({ email, code: '000000' })
      .expect(400);

    // … the right code returns a single-use token.
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-reset-otp')
      .send({ email, code: DEV_OTP })
      .expect(201);
    const token: string = verified.body.token;
    expect(token.length).toBeGreaterThan(20);

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, password: newPassword })
      .expect(201);

    // New password works; old one is rejected.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: newPassword })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: oldPassword })
      .expect(401);

    // The token is single-use — reusing it now fails.
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, password: 'anotherpass789' })
      .expect(400);

    // The reset revoked all prior sessions — the pre-reset refresh cookie is dead.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', preResetCookie)
      .expect(401);
  }, 30_000);

  it('anti-enumeration: an unknown email returns the same 201 and sends nothing', async () => {
    otpSends.length = 0;
    const unknown = `nobody_${ts}@ex.com`;
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: unknown })
      .expect(201);
    expect(otpSends.length).toBe(0);
    // …and verifying a code for a non-existent email fails generically (no oracle).
    await request(app.getHttpServer())
      .post('/auth/verify-reset-otp')
      .send({ email: unknown, code: DEV_OTP })
      .expect(400);
  });

  it('a garbage token is rejected with a generic 400', async () => {
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: 'not-a-real-token', password: newPassword })
      .expect(400);
  });
});
