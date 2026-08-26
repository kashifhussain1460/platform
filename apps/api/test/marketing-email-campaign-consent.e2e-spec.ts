import { ConfigService } from '@nestjs/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ToolIdempotencyService } from '../src/common/idempotency/tool-idempotency.service';
import { ChatwootClientService } from '../src/modules/engines/support/chatwoot-client.service';
import { PostizClientService } from '../src/modules/engines/marketing/postiz-client.service';
import { SuppressionService } from '../src/modules/engines/marketing/suppression.service';
import { PlaneClientService } from '../src/modules/engines/pm/plane-client.service';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service';
import { AutoSkillExecutor } from '../src/modules/skills/executors/auto-skill-executor';
import { MockSkillExecutor } from '../src/modules/skills/executors/mock-skill-executor';
import { RealSkillExecutor } from '../src/modules/skills/executors/real-skill-executor';
import { SKILL_EXECUTOR_TOKEN } from '../src/modules/skills/executors/skill-executor';

/**
 * M-08 — real consent enforcement, end-to-end.
 *
 * Before this, `mkt.email-campaign`'s CONDITION node trusted a caller-supplied
 * `{{trigger.consentVerified}}` boolean — a trigger payload could simply claim
 * `true` without any real MarketingConsent record existing. This proves the
 * new `marketing.check_consent` TOOL_ACTION queries the REAL table instead: a
 * bare `TOOL_ACTION(marketing.check_consent)` → `CONDITION` gate, mirroring
 * the exact shape the template now uses.
 *
 * MUST force the AUTO executor (same convention as engines-support.e2e-spec.ts):
 * under this repo's default e2e SKILL_EXECUTOR=mock, MockSkillExecutor returns
 * a generic `{sandbox:true}` shape with no `allConsented` field at all, which
 * would make EVERY case here evaluate the CONDITION as false and reach FAILED
 * — including the "should succeed" case, for the wrong reason. Verified
 * empirically: this test failed exactly this way before the override was added.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('M-08 — real consent gate for email campaigns', () => {
  let app: INestApplication;
  let suppression: SuppressionService;
  const ts = Date.now();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  let token = '';
  let companyId = '';

  const pollRun = async (id: string): Promise<{ status: string }> => {
    let run = { status: 'PENDING' };
    for (let i = 0; i < 40 && !['WAITING', 'COMPLETED', 'FAILED'].includes(run.status); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const got = await request(app.getHttpServer())
        .get(`/workflows/runs/${id}`)
        .set(bearer(token))
        .expect(200);
      run = got.body;
    }
    return run;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SKILL_EXECUTOR_TOKEN)
      .useFactory({
        factory: (
          config: ConfigService,
          scheduling: SchedulingService,
          postizClient: PostizClientService,
          prismaSvc: PrismaService,
          chatwootClient: ChatwootClientService,
          crypto: CryptoService,
          planeClient: PlaneClientService,
          idempotency: ToolIdempotencyService,
          suppressionSvc: SuppressionService,
        ) => {
          const mock = new MockSkillExecutor();
          return new AutoSkillExecutor(
            new RealSkillExecutor(config, mock, scheduling, postizClient, prismaSvc, chatwootClient, crypto, planeClient, idempotency, suppressionSvc),
            mock,
          );
        },
        inject: [
          ConfigService,
          SchedulingService,
          PostizClientService,
          PrismaService,
          ChatwootClientService,
          CryptoService,
          PlaneClientService,
          ToolIdempotencyService,
          SuppressionService,
        ],
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    suppression = app.get(SuppressionService);
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        companyName: `Consent Gate Co ${ts}`,
        name: 'Owner',
        email: `consentgate_${ts}@example.com`,
        password: 'password123',
      })
      .expect(201);
    token = reg.body.tokens.accessToken;
    companyId = reg.body.company.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const graph = (address: string) => ({
    nodes: [
      { id: 't', type: 'TRIGGER', config: {} },
      {
        id: 'checkConsent',
        type: 'TOOL_ACTION',
        config: {
          skillKey: 'marketing',
          tool: 'check_consent',
          args: { channel: 'EMAIL', addresses: address },
          outputKey: 'consentCheck',
        },
      },
      {
        id: 'consent',
        type: 'CONDITION',
        config: { left: '{{consentCheck.result.allConsented}}', op: 'eq', right: 'true' },
      },
      { id: 'blocked', type: 'TERMINATE', config: { status: 'FAILED', reason: 'Consent not verified.' } },
      { id: 'done', type: 'TERMINATE', config: { status: 'COMPLETED', reason: 'Consent verified.' } },
    ],
    edges: [
      { from: 't', to: 'checkConsent' },
      { from: 'checkConsent', to: 'consent' },
      { from: 'consent', to: 'blocked', branch: 'false' },
      { from: 'consent', to: 'done', branch: 'true' },
    ],
  });

  it('blocks (FAILED) an address with NO MarketingConsent record — a trigger claiming consentVerified would NOT have caught this', async () => {
    const address = `never-consented-${ts}@example.com`;
    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: 'Consent probe (no record)', definition: graph(address) })
      .expect(201);
    const started = await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);

    const run = await pollRun(started.body.id);
    expect(run.status).toBe('FAILED');
  });

  it('proceeds (COMPLETED) once real consent is GRANTED for the address', async () => {
    const address = `granted-${ts}@example.com`;
    await suppression.recordConsent({
      companyId,
      channel: 'EMAIL',
      address,
      status: 'GRANTED',
      source: 'test',
    });

    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: 'Consent probe (granted)', definition: graph(address) })
      .expect(201);
    const started = await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);

    const run = await pollRun(started.body.id);
    expect(run.status).toBe('COMPLETED');
  });

  it('blocks (FAILED) an address that WITHDREW consent, even though it once had a GRANTED record', async () => {
    const address = `withdrawn-${ts}@example.com`;
    await suppression.recordConsent({ companyId, channel: 'EMAIL', address, status: 'GRANTED', source: 'test' });
    await suppression.recordConsent({ companyId, channel: 'EMAIL', address, status: 'WITHDRAWN', source: 'test' });

    const wf = await request(app.getHttpServer())
      .post('/workflows')
      .set(bearer(token))
      .send({ name: 'Consent probe (withdrawn)', definition: graph(address) })
      .expect(201);
    const started = await request(app.getHttpServer())
      .post(`/workflows/${wf.body.id}/run`)
      .set(bearer(token))
      .send({})
      .expect(201);

    const run = await pollRun(started.body.id);
    expect(run.status).toBe('FAILED');
  });
});
