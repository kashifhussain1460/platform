// The "full tool-calling loop" describe block below needs a live Postgres +
// Redis AND a deterministic LLM. This repo's own .env may set LLM_PROVIDER=openai
// for live-testing other features (see employees.e2e-spec.ts's same note) — that
// makes tool-selection a real, non-deterministic model call instead of the mock
// scorer, which will intermittently fail this test for reasons that have nothing
// to do with this feature. Also note: apps/api/.env sets SKILL_EXECUTOR=auto, and
// the chatwoot skill's catalog entry has connection:{type:'none'} (provisioned
// once per company, not per-employee OAuth) — AutoSkillExecutor treats
// connection.type==='none' as always-eligible for the REAL executor, so leaving
// SKILL_EXECUTOR unset here IS DELIBERATE: it is what makes this test actually
// exercise RealSkillExecutor.chatwootReplyToConversation (do NOT add
// SKILL_EXECUTOR=mock — that forces MockSkillExecutor instead and the test
// would no longer touch the real code path at all; verified empirically).
//
// What actually happens end-to-end (verified by running this suite with
// console output, not assumed): MockLlmProvider.deriveArg has NO branch
// matching the parameter name `conversationId` (see mock-llm.provider.ts), so
// it falls through to the generic `clip(userText, 500)` fallback — meaning
// args.conversationId ends up being the (whitespace-collapsed) chat message
// text ITSELF, not the real SupportConversation.id. Embedding the real id as
// a substring of a natural-sounding message ("Reply to conversation <id>
// saying...") does NOT fix this: the fallback copies the WHOLE message
// verbatim, so conversationId still isn't an exact match. Making the ENTIRE
// message just the bare id (so it WOULD be an exact match) doesn't work
// either — selectTool's naive token-overlap scorer can no longer see the word
// "reply" anywhere and can't disambiguate reply_to_conversation from the
// chatwoot skill's other 3 conversation-themed tools (list_open_conversations,
// get_conversation, resolve_conversation); ties fall back to catalog
// declaration order, so list_open_conversations wins instead (also verified
// by running it). So with today's mock LLM there is no single chat message
// that both selects reply_to_conversation AND supplies a real conversation
// id — RealSkillExecutor.chatwootReplyToConversation's
// `prisma.supportConversation.findFirst({where:{id:conversationId,
// companyId}})` always finds nothing here and short-circuits with
// `{ok:false, error:'SupportConversation not found for this company'}` —
// BEFORE the ChatwootAccount lookup, crypto.decrypt, or chatwootClient.sendReply
// are ever reached. The ChatwootAccount row created below is therefore not
// read by this specific assertion today; it stays because it's part of the
// realistic fixture setup and would become live again once MockLlmProvider
// (or a future test-only LLM stub) learns to extract a real id instead of
// echoing the whole message. The assertion below checks the persisted
// SkillExecution audit row's `error` directly, so this is pinned to the true
// reason rather than merely inferred from a comment.
// Always run with:
//   LLM_PROVIDER=mock EMBEDDINGS_PROVIDER=hash STORAGE_PROVIDER=local \
//   DATABASE_URL=postgresql://vaep:vaep@localhost:5433/vaep?schema=public \
//   REDIS_URL=redis://127.0.0.1:6380 JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=...
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { SkillCatalog } from '../../src/modules/skills/catalog';
import { SKILL_EXECUTOR_TOKEN } from '../../src/modules/skills/executors/skill-executor';
import { AutoSkillExecutor } from '../../src/modules/skills/executors/auto-skill-executor';
import { MockSkillExecutor } from '../../src/modules/skills/executors/mock-skill-executor';
import { RealSkillExecutor } from '../../src/modules/skills/executors/real-skill-executor';
import { SchedulingService } from '../../src/modules/scheduling/scheduling.service';
import { PostizClientService } from '../../src/modules/engines/marketing/postiz-client.service';
import { ChatwootClientService } from '../../src/modules/engines/support/chatwoot-client.service';
import { PlaneClientService } from '../../src/modules/engines/pm/plane-client.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CryptoService } from '../../src/common/crypto/crypto.service';

describe('Support engine — schema', () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());

  it('creates a ChatwootAccount scoped to a company', async () => {
    const company = await prisma.company.create({
      data: { name: 'Support Test Co', slug: `support-test-${Date.now()}` },
    });
    const account = await prisma.chatwootAccount.create({
      data: {
        companyId: company.id,
        chatwootAccountId: '1',
        agentBotId: '1',
        agentBotToken: 'encrypted-placeholder',
        webhookSecret: 'encrypted-placeholder',
      },
    });
    expect(account.companyId).toBe(company.id);
  });
});

describe('Support engine — catalog', () => {
  it('registers the chatwoot skill with a reply_to_conversation tool', () => {
    expect(SkillCatalog.has('chatwoot')).toBe(true);
    const tool = SkillCatalog.getTool('chatwoot', 'reply_to_conversation');
    expect(tool).toBeDefined();
  });
});

// --- DB-gated: full tool-calling loop (real executor, no network) -----------
// Same describeIfDb + Test.createTestingModule({imports:[AppModule]}) + supertest
// convention as engines-marketing.e2e-spec.ts / integrations.e2e-spec.ts (this
// suite's own harness.mjs script-style client is for standalone scripts against
// an already-running server, not for jest e2e specs in this directory).
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Support engine — full tool-calling loop', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  const email = `engines_support_e2e_${Date.now()}@example.com`;
  const password = 'password123';
  const auth: Record<string, string> = {};

  jest.setTimeout(60_000);

  beforeAll(async () => {
    // This suite asserts the REAL executor's "SupportConversation not found"
    // short-circuit, so it must not run against the mock executor. It used to
    // rely on the ambient SKILL_EXECUTOR value from apps/api/.env (`auto`),
    // which meant it silently passed locally and would have failed in CI (which
    // pins SKILL_EXECUTOR=mock). Force AUTO here so the suite is hermetic.
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SKILL_EXECUTOR_TOKEN)
      .useFactory({
        factory: (
          config: ConfigService,
          scheduling: SchedulingService,
          postizClient: PostizClientService,
          prisma: PrismaService,
          chatwootClient: ChatwootClientService,
          crypto: CryptoService,
          planeClient: PlaneClientService,
        ) => {
          const mock = new MockSkillExecutor();
          return new AutoSkillExecutor(
            new RealSkillExecutor(config, mock, scheduling, postizClient, prisma, chatwootClient, crypto, planeClient),
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
        ],
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ companyName: 'Support Engine Test Co', name: 'Test Owner', email, password })
      .expect(201);
    auth.Authorization = `Bearer ${res.body.tokens.accessToken}`;

    // chatwootReplyToConversation (Task 4) requires a ChatwootAccount AND a
    // SupportConversation to already exist for the company — provisionAccount
    // is an intentional stub (Task 2), not callable here — so create both rows
    // directly via Prisma, same as engines-marketing.e2e-spec.ts's SocialAccount.
    // (The ChatwootAccount row isn't actually read by this suite's one `it` —
    // see the file header comment for why — but it's kept so the fixture stays
    // an accurate model of the real prerequisite state.)
    const companyId = res.body.company.id as string;
    const chatwootAccount = await prisma.chatwootAccount.create({
      data: {
        companyId,
        chatwootAccountId: '1',
        agentBotId: '1',
        agentBotToken: 'encrypted-placeholder',
        webhookSecret: 'encrypted-placeholder',
      },
    });
    await prisma.supportConversation.create({
      data: {
        companyId,
        chatwootAccountId: chatwootAccount.id,
        chatwootConversationId: 'cw_conv_1',
        contactEmail: 'customer@example.com',
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it('an employee can call chatwoot.reply_to_conversation through the normal chat loop', async () => {
    const employee = await request(app.getHttpServer())
      .post('/employees')
      .set(auth)
      .send({ name: 'Support Bot', role: 'CUSTOM', persona: 'Customer support agent' })
      .expect(201);
    const employeeId = employee.body.id;

    const installed = await request(app.getHttpServer())
      .post('/skills/install')
      .set(auth)
      .send({ skillKey: 'chatwoot' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/employees/${employeeId}/skills`)
      .set(auth)
      .send({ installedSkillId: installed.body.id })
      .expect(201);

    const conversation = await request(app.getHttpServer())
      .post(`/employees/${employeeId}/conversations`)
      .set(auth)
      .send({})
      .expect(201);

    const result = await request(app.getHttpServer())
      .post(`/conversations/${conversation.body.id}/messages`)
      .set(auth)
      .send({ content: "Reply to this conversation saying we'll look into it" })
      .expect(201);

    expect(
      result.body.toolCalls.some(
        (c: { skillKey: string; tool: string }) =>
          c.skillKey === 'chatwoot' && c.tool === 'reply_to_conversation',
      ),
    ).toBe(true);

    // Prove the specific short-circuit, not just "some tool call happened":
    // ToolCallDto (the API response shape) deliberately drops `error` — the
    // real error text only lives on the persisted SkillExecution audit row
    // (see SkillsService.runTool). Assert on that row directly so this test
    // is pinned to the TRUE reason the call fails closed (see file header),
    // and would break loudly if MockLlmProvider ever learned to derive a real
    // conversationId and the failure shifted to a later step (ChatwootAccount
    // lookup / crypto.decrypt / chatwootClient.sendReply).
    const execution = await prisma.skillExecution.findFirst({
      where: {
        companyId: employee.body.companyId,
        skillKey: 'chatwoot',
        tool: 'reply_to_conversation',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(execution?.status).toBe('ERROR');
    expect(execution?.error).toBe('SupportConversation not found for this company');
  });
});
