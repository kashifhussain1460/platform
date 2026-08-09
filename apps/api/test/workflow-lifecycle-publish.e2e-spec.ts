import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Verifies the builder's publish sequence: the canvas autosaves the definition
// column, so publish = PUT /draft {latest definition} → POST /publish. Confirms a
// version is created, publish is idempotent, versions list, and activate.
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Workflow lifecycle — publish from the definition column', () => {
  let app: INestApplication;
  const ts = Date.now();
  const password = 'password123';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Lifecycle Co', name: 'Owner', email: `life_owner_${ts}@ex.com`, password })
      .expect(201);
    token = reg.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  const definition = {
    nodes: [
      { id: 'n1', type: 'TRIGGER', config: {}, position: { x: 100, y: 40 } },
      { id: 'n2', type: 'NOOP', config: {}, position: { x: 100, y: 200 } },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };

  it('publishes the latest saved definition into an immutable version, then activates', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: `life-${ts}`, definition })
      .expect(201);
    const id: string = created.body.id;
    expect(created.body.activeVersionId).toBeNull();

    // What usePublishWorkflow does: PUT /draft {latest definition} → POST /publish.
    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition })
      .expect(200);

    const published = await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({ changeNote: 'First publish' })
      .expect(200);
    expect(published.body.unchanged).toBe(false);
    expect(published.body.version.version).toBe(1);
    expect(published.body.version.status).toBe('PUBLISHED');
    expect(published.body.version.changeNote).toBe('First publish');

    // The workflow now has an active version.
    const afterPublish = await request(app.getHttpServer())
      .get(`/workflows/${id}`)
      .set(bearer(token))
      .expect(200);
    expect(afterPublish.body.activeVersionId).toBe(published.body.version.id);

    // Version history lists it.
    const versions = await request(app.getHttpServer())
      .get(`/workflows/${id}/versions`)
      .set(bearer(token))
      .expect(200);
    expect(versions.body.some((v: { version: number; status: string }) => v.version === 1 && v.status === 'PUBLISHED')).toBe(true);

    // Idempotent: re-publishing the identical graph makes no new PUBLISHED version.
    await request(app.getHttpServer())
      .put(`/workflows/${id}/draft`)
      .set(bearer(token))
      .send({ definition })
      .expect(200);
    const again = await request(app.getHttpServer())
      .post(`/workflows/${id}/publish`)
      .set(bearer(token))
      .send({})
      .expect(200);
    expect(again.body.unchanged).toBe(true);

    // Activate arms the trigger.
    const activated = await request(app.getHttpServer())
      .post(`/workflows/${id}/activate`)
      .set(bearer(token))
      .expect(200);
    expect(activated.body.status).toBe('ACTIVE');
  });
});
