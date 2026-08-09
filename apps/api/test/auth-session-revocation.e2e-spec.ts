import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Refresh-token rotation + revocation. The refresh JWT is now backed by a
 * revocable store: each refresh rotates (the old token dies), and logout revokes
 * the presented token — so a captured refresh cookie can't be replayed. Real DB.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

const refreshCookie = (res: request.Response): string => {
  const set = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const raw = set.find((c) => c.startsWith('vaep_refresh='));
  return raw ? raw.split(';')[0] : '';
};

describeIfDb('Auth — refresh-token rotation + revocation', () => {
  let app: INestApplication;
  const ts = Date.now();
  const password = 'password123';

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

  const login = async (email: string) => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: `Sess ${email}`, name: 'Owner', email, password })
      .expect(201);
    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
  };

  it('rotates on refresh — the old refresh token is dead after one use', async () => {
    const cookieA = refreshCookie(await login(`rot_${ts}@ex.com`));
    expect(cookieA).toContain('vaep_refresh=');

    // First refresh with A succeeds and mints B.
    const r1 = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieA)
      .expect(201);
    const cookieB = refreshCookie(r1);
    expect(cookieB).not.toBe(cookieA);

    // Reusing A now fails (rotated), while B still works.
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookieA).expect(401);
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookieB).expect(201);
  }, 30_000);

  it('logout revokes the refresh token server-side', async () => {
    const cookieC = refreshCookie(await login(`logout_${ts}@ex.com`));

    await request(app.getHttpServer()).post('/auth/logout').set('Cookie', cookieC).expect(201);
    // The revoked cookie can no longer be exchanged.
    await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookieC).expect(401);
  }, 30_000);
});
