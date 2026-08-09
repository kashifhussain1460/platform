import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Verifies the Workflow Builder's one new Save field — node `position` — survives
// the global `whitelist: true` pipe on PATCH (autosave) and comes back on GET.
// Also asserts the optimistic-concurrency 409 the canvas conflict banner relies on.
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Workflow node position (canvas autosave contract)', () => {
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
    // Mirror production exactly: whitelist strips undeclared fields.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Position Co', name: 'Owner', email: `pos_owner_${ts}@ex.com`, password })
      .expect(201);
    token = reg.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('persists node position through PATCH and returns it on GET', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({
        name: `pos-${ts}`,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {} },
            { id: 'n2', type: 'NOOP', config: {} },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(201);
    const id: string = created.body.id;
    const updatedAt: string = created.body.updatedAt;

    // Autosave a manual layout.
    const patched = await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({
        expectedUpdatedAt: updatedAt,
        definition: {
          nodes: [
            { id: 'n1', type: 'TRIGGER', config: {}, position: { x: 120, y: 40 } },
            { id: 'n2', type: 'NOOP', config: {}, position: { x: 200, y: 260 } },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        },
      })
      .expect(200);

    // Position must survive the whitelist pipe on the way in…
    const n1Patched = patched.body.definition.nodes.find((n: { id: string }) => n.id === 'n1');
    expect(n1Patched.position).toEqual({ x: 120, y: 40 });

    // …and be readable back on GET.
    const fetched = await request(app.getHttpServer())
      .get(`/workflows/${id}`)
      .set(bearer(token))
      .expect(200);
    const n2Fetched = fetched.body.definition.nodes.find((n: { id: string }) => n.id === 'n2');
    expect(n2Fetched.position).toEqual({ x: 200, y: 260 });
  });

  it('rejects a stale expectedUpdatedAt with 409 (drives the conflict banner)', async () => {
    const created = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({
        name: `pos-conflict-${ts}`,
        definition: { nodes: [{ id: 'n1', type: 'TRIGGER', config: {} }], edges: [] },
      })
      .expect(201);
    const id: string = created.body.id;
    const staleUpdatedAt: string = created.body.updatedAt;

    // First save moves updatedAt forward.
    await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({
        expectedUpdatedAt: staleUpdatedAt,
        definition: { nodes: [{ id: 'n1', type: 'TRIGGER', config: {}, position: { x: 10, y: 10 } }], edges: [] },
      })
      .expect(200);

    // A second save with the now-stale stamp conflicts.
    await request(app.getHttpServer())
      .patch(`/workflows/${id}`)
      .set(bearer(token))
      .send({
        expectedUpdatedAt: staleUpdatedAt,
        definition: { nodes: [{ id: 'n1', type: 'TRIGGER', config: {}, position: { x: 99, y: 99 } }], edges: [] },
      })
      .expect(409);
  });
});
