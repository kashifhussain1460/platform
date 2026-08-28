import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * `GET /handoffs` — the inbox that was missing.
 *
 * `escalate` and `resolve` both shipped; nothing listed the queue between
 * them, so an AI could hand a customer conversation to a human and that human
 * had no screen showing it. This proves the whole loop over real HTTP:
 * escalate → appears in the inbox → a human resolves it → the conversation
 * moves to the right state.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Handoff inbox', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ts = Date.now();
  const password = 'password123';
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerToken = '';
  let companyId = '';
  let employeeId = '';
  let conversationId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const reg = await http()
      .post('/auth/register')
      .send({
        companyName: `Handoff Co ${ts}`,
        name: 'Handoff Owner',
        email: `handoff_owner_${ts}@example.com`,
        password,
      })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

    const emp = await http()
      .post('/employees')
      .set(bearer(ownerToken))
      .send({ name: 'Support Bot', role: 'SUPPORT' })
      .expect(201);
    employeeId = emp.body.id;

    // A support conversation needs a ChatwootAccount; created directly because
    // there is no tenant-facing endpoint for it (a gap in its own right).
    const account = await prisma.chatwootAccount.create({
      data: {
        companyId,
        chatwootAccountId: `handoff-${ts}`,
        agentBotId: 'bot-1',
        agentBotToken: 'x',
        webhookSecret: 'shh',
      },
    });
    const conversation = await prisma.supportConversation.create({
      data: {
        companyId,
        chatwootAccountId: account.id,
        chatwootConversationId: `conv-${ts}`,
        contactEmail: 'buyer@example.com',
        status: 'OPEN',
      },
    });
    conversationId = conversation.id;
    // Distinct timestamps, the way real messages arrive.
    await prisma.supportMessage.createMany({
      data: [
        {
          companyId,
          conversationId,
          direction: 'IN',
          content: 'I want a refund',
          createdAt: new Date('2026-08-22T09:58:00.000Z'),
        },
        {
          companyId,
          conversationId,
          direction: 'OUT',
          content: 'One moment',
          createdAt: new Date('2026-08-22T09:59:00.000Z'),
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (prisma && companyId) {
      await prisma.company.deleteMany({ where: { id: companyId } });
    }
    await app?.close();
  });

  it('rejects an anonymous request', async () => {
    await http().get('/handoffs').expect(401);
  });

  it('is empty before anything escalates', async () => {
    const res = await http().get('/handoffs').set(bearer(ownerToken)).expect(200);
    expect(res.body).toEqual([]);
  });

  it('lists a handoff once the AI escalates, with conversation context', async () => {
    await http()
      .post(`/support/conversations/${conversationId}/escalate`)
      .set(bearer(ownerToken))
      .send({ conversationId, employeeId, reason: 'Customer asked for a refund' })
      .expect(201);

    const res = await http().get('/handoffs').set(bearer(ownerToken)).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].reason).toBe('Customer asked for a refund');
    expect(res.body[0].status).toBe('PENDING');
    expect(res.body[0].conversation.contactEmail).toBe('buyer@example.com');
    // Oldest-first, the way a conversation reads.
    expect(
      res.body[0].conversation.recentMessages.map((m: { body: string }) => m.body),
    ).toEqual(['I want a refund', 'One moment']);
  });

  it('is resolvable by an admin when the employee has no manager', async () => {
    // The regression this pins: EMPLOYEE_MANAGER routing with no manager set
    // resolved to an EMPTY assignee, and `canDecide('EMPLOYEE_MANAGER')`
    // needs a concrete one — so every user in the company, owners included,
    // got canResolve: false and the escalated conversation could never be
    // rescued by anyone. Escalate now falls back to ANY_ADMIN.
    const res = await http().get('/handoffs').set(bearer(ownerToken)).expect(200);
    expect(res.body[0].canResolve).toBe(true);

    const row = await prisma.handoffRequest.findFirst({ where: { companyId } });
    expect(row?.approverRuleType).toBe('ANY_ADMIN');
  });

  it('does not let a non-admin member resolve it', async () => {
    // The fallback widens the assignee set to admins — not to everybody.
    const member = await http()
      .post('/users')
      .set(bearer(ownerToken))
      .send({
        name: 'Member',
        email: `handoff_member_${ts}@example.com`,
        password,
        role: 'MEMBER',
      })
      .expect(201);
    expect(member.body.role).toBe('MEMBER');

    const login = await http()
      .post('/auth/login')
      .send({ email: `handoff_member_${ts}@example.com`, password })
      .expect(201);
    const memberToken = login.body.tokens.accessToken;

    const res = await http().get('/handoffs').set(bearer(memberToken)).expect(200);
    // Visible (a queue that hides work stalls), but not actionable by them.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].canResolve).toBe(false);

    const mine = await http()
      .get('/handoffs?assignedToMe=true')
      .set(bearer(memberToken))
      .expect(200);
    expect(mine.body).toEqual([]);

    await http()
      .post(`/handoffs/${res.body[0].id}/resolve`)
      .set(bearer(memberToken))
      .send({ resume: true })
      .expect(403);
  });

  it('filters by status', async () => {
    const pending = await http()
      .get('/handoffs?status=PENDING')
      .set(bearer(ownerToken))
      .expect(200);
    expect(pending.body).toHaveLength(1);
    const done = await http()
      .get('/handoffs?status=RESOLVED')
      .set(bearer(ownerToken))
      .expect(200);
    expect(done.body).toEqual([]);
  });

  it('resolving with resume=true hands the conversation back to the AI', async () => {
    const list = await http().get('/handoffs').set(bearer(ownerToken)).expect(200);
    await http()
      .post(`/handoffs/${list.body[0].id}/resolve`)
      .set(bearer(ownerToken))
      .send({ resume: true, note: 'Refunded manually' })
      .expect(201);

    const conversation = await prisma.supportConversation.findUnique({
      where: { id: conversationId },
    });
    expect(conversation?.status).toBe('OPEN');

    const after = await http()
      .get('/handoffs?status=PENDING')
      .set(bearer(ownerToken))
      .expect(200);
    expect(after.body).toEqual([]);
  });

  it('never leaks another tenant’s queue', async () => {
    const other = await http()
      .post('/auth/register')
      .send({
        companyName: `Handoff Other ${ts}`,
        name: 'Other Owner',
        email: `handoff_other_${ts}@example.com`,
        password,
      })
      .expect(201);

    const res = await http()
      .get('/handoffs')
      .set(bearer(other.body.tokens.accessToken))
      .expect(200);
    expect(res.body).toEqual([]);

    await prisma.company.deleteMany({ where: { id: other.body.user.companyId } });
  });
});
