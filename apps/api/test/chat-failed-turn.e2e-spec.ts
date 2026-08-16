import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PlannerService } from '../src/modules/employees/runtime/planner.service';

const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

/**
 * A chat turn that FAILS must not leave the question behind.
 *
 * The runtime persists the user turn before it plans, retrieves and calls the
 * model, so any failure after that point used to commit half a turn: the
 * question sat in the thread with no reply. The customer asks again and the
 * conversation shows the same sentence twice — the "duplicate message" that was
 * reported. Reproduced in production data as two identical USER rows four
 * seconds apart with a single ASSISTANT row after them.
 */
describeIfDb('Chat turn that fails leaves no orphan message', () => {
  let app: INestApplication;
  const email = `failed_turn_${Date.now()}@example.com`;
  const password = 'password123';
  let accessToken = '';
  let conversationId = '';

  // Fails the very first step of a turn, AFTER the user message is committed.
  const explode = jest
    .fn()
    .mockRejectedValue(new Error('planner unavailable (injected)'));

  const auth = () => ({ Authorization: `Bearer ${accessToken}` });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PlannerService)
      .useValue({ plan: explode })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: 'Failed Turn Co',
        name: 'Turn Owner',
        email,
        password,
      })
      .expect(201);
    accessToken = res.body.tokens.accessToken;

    const employee = await request(app.getHttpServer())
      .post('/employees')
      .set(auth())
      .send({ name: 'Anushka', role: 'HR' })
      .expect(201);

    const conversation = await request(app.getHttpServer())
      .post(`/employees/${employee.body.id}/conversations`)
      .set(auth())
      .send({})
      .expect(201);
    conversationId = conversation.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports the failure to the caller', async () => {
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth())
      .send({ content: 'what are my roles and responsibilities' })
      .expect(500);

    expect(explode).toHaveBeenCalled();
  });

  it('does NOT keep the user message from the failed turn', async () => {
    const res = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set(auth())
      .expect(200);

    // Not "no assistant reply" — the whole turn is gone. A user message with
    // no answer is indistinguishable from one still being worked on, so
    // leaving it is what made the retry look like a duplicate.
    expect(res.body).toEqual([]);
  });

  it('a second attempt reads as one question, not two', async () => {
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth())
      .send({ content: 'what are my roles and responsibilities' })
      .expect(500);

    const res = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}/messages`)
      .set(auth())
      .expect(200);

    const asked = (res.body as { role: string; content: string }[]).filter(
      (m) => m.role === 'USER',
    );
    expect(asked).toHaveLength(0);
  });
});
