import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * SECURITY (kill-switch): disabling a user or changing their role must take
 * effect on the very next request — not only after the access-token TTL. The
 * JWT strategy re-reads status + role from the DB per request, so a still-valid
 * token stops working the instant the account is disabled/demoted.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Security — JWT kill-switch (disable/demote take effect immediately)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const registerOwner = async (tag: string) => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: `KS ${tag} ${ts}`, name: 'Owner', email: `ks_${tag}_${ts}@ex.com`, password: 'password123' })
      .expect(201);
    return { token: reg.body.tokens.accessToken as string, userId: reg.body.user.id as string };
  };

  it('a DISABLED user is rejected (401) on the next request with a still-valid token', async () => {
    const { token, userId } = await registerOwner('disable');
    // The token works now.
    await request(app.getHttpServer()).get('/employees').set(bearer(token)).expect(200);
    // Disable the account directly (simulating an admin kill-switch).
    await prisma.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
    // The SAME token is now rejected — no waiting for TTL.
    await request(app.getHttpServer()).get('/employees').set(bearer(token)).expect(401);
  });

  it('a DEMOTED user loses admin-only access (403) immediately', async () => {
    const { token, userId } = await registerOwner('demote');
    // Owner can reach an OWNER/ADMIN-only route.
    await request(app.getHttpServer()).get('/hr/staff').set(bearer(token)).expect(200);
    // Demote to MEMBER (role is re-read from the DB, not the token).
    await prisma.user.update({ where: { id: userId }, data: { role: 'MEMBER' } });
    // The same token no longer passes the role guard.
    await request(app.getHttpServer()).get('/hr/staff').set(bearer(token)).expect(403);
  });
});
