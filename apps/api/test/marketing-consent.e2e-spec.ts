import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SuppressionService } from '../src/modules/engines/marketing/suppression.service';
import { SkillsService } from '../src/modules/skills/skills.service';

/**
 * WAVE 3 §3.6 — consent + suppression, enforced.
 *
 * Neither existed before: there was no model, no list and no check anywhere, so
 * nothing stopped an AI Employee emailing someone who had unsubscribed. These
 * tests are the statement that it now cannot.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('WAVE 3 — marketing consent + suppression', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let suppression: SuppressionService;
  let skills: SkillsService;

  const stamp = Date.now();
  let companyId = '';

  const ctx = () => ({ companyId });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    suppression = app.get(SuppressionService);
    skills = app.get(SkillsService);

    const company = await prisma.company.create({
      data: { name: `Consent Co ${stamp}`, slug: `consent-${stamp}` },
    });
    companyId = company.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── the list itself ────────────────────────────────────────────────────────

  it('normalises addresses so case and whitespace cannot defeat it', async () => {
    // A list that misses because the sender wrote `Alice@Example.COM` reports a
    // protection it does not provide.
    await suppression.suppress({
      companyId,
      channel: 'EMAIL',
      address: '  Unsub@Example.COM ',
      reason: 'UNSUBSCRIBED',
    });

    expect(
      await suppression.isSuppressed(companyId, 'EMAIL', 'unsub@example.com'),
    ).toBe(true);
    expect(
      await suppression.isSuppressed(companyId, 'EMAIL', 'UNSUB@EXAMPLE.COM'),
    ).toBe(true);
  });

  it('is idempotent, and keeps the ORIGINAL reason', async () => {
    // Providers send an unsubscribe and a later complaint for the same address;
    // a handler that errored on the second would retry for ever.
    await suppression.suppress({
      companyId,
      channel: 'EMAIL',
      address: 'dupe@example.com',
      reason: 'UNSUBSCRIBED',
      source: 'first',
    });
    await suppression.suppress({
      companyId,
      channel: 'EMAIL',
      address: 'dupe@example.com',
      reason: 'COMPLAINED',
      source: 'second',
    });

    const rows = await prisma.marketingSuppression.findMany({
      where: { companyId, address: 'dupe@example.com' },
    });
    expect(rows).toHaveLength(1);
    // The FIRST suppression is when the obligation started — that is the
    // evidentially meaningful timestamp, so it is not overwritten.
    expect(rows[0].reason).toBe('UNSUBSCRIBED');
    expect(rows[0].source).toBe('first');
  });

  it('is tenant-scoped', async () => {
    const other = await prisma.company.create({
      data: { name: `Consent Other ${stamp}`, slug: `consent-other-${stamp}` },
    });
    expect(
      await suppression.isSuppressed(other.id, 'EMAIL', 'unsub@example.com'),
    ).toBe(false);
  });

  // ── enforcement at the tool boundary ───────────────────────────────────────

  it('BLOCKS an email to a suppressed recipient', async () => {
    const result = await skills.runTool(ctx() as never, 'email', 'send_email', {
      to: 'unsub@example.com',
      subject: 'Special offer',
      body: 'Hello again',
    });

    expect(result.ok).toBe(false);
    // `ToolCallDto` deliberately omits `error` — the reason lives only on the
    // persisted SkillExecution audit row (SkillsService.runTool).
    const row = await prisma.skillExecution.findFirst({
      where: { companyId, skillKey: 'email', status: 'ERROR' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.error).toContain('suppression list');
  });

  it('blocks when a suppressed address is only ONE of several recipients', async () => {
    // Partial delivery is not an option: the send either reaches everyone named
    // or nobody, and reaching a suppressed address is the breach.
    const result = await skills.runTool(ctx() as never, 'email', 'send_email', {
      to: 'fine@example.com, unsub@example.com',
      subject: 'Newsletter',
    });
    expect(result.ok).toBe(false);
  });

  it('allows a send to a clean recipient', async () => {
    const result = await skills.runTool(ctx() as never, 'email', 'send_email', {
      to: 'clean@example.com',
      subject: 'Welcome',
      body: 'Hi',
    });
    expect(result.ok).toBe(true);
  });

  it('does not block a tool that addresses nobody in particular', async () => {
    const result = await skills.runTool(ctx() as never, 'slack', 'send_message', {
      channel: '#general',
      text: 'Suppressed contact unsub@example.com was mentioned',
    });
    // A channel post is a broadcast; the address in the TEXT is not a recipient.
    expect(result.ok).toBe(true);
  });

  it('records the block as a failed SkillExecution, not a silent drop', async () => {
    const row = await prisma.skillExecution.findFirst({
      where: { companyId, skillKey: 'email', status: 'ERROR' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row?.error).toContain('suppression list');
  });

  // ── consent ───────────────────────────────────────────────────────────────

  it('a WITHDRAWN consent suppresses; a GRANTED one lifts only that suppression', async () => {
    const address = 'consent@example.com';

    await suppression.recordConsent({
      companyId,
      channel: 'EMAIL',
      address,
      status: 'GRANTED',
      source: 'FORM',
      evidence: { url: 'https://example.com/signup' },
    });
    expect(await suppression.isSuppressed(companyId, 'EMAIL', address)).toBe(false);

    await suppression.recordConsent({
      companyId,
      channel: 'EMAIL',
      address,
      status: 'WITHDRAWN',
      source: 'FORM',
    });
    // A consent record nothing enforces is decoration.
    expect(await suppression.isSuppressed(companyId, 'EMAIL', address)).toBe(true);

    await suppression.recordConsent({
      companyId,
      channel: 'EMAIL',
      address,
      status: 'GRANTED',
      source: 'DOUBLE_OPT_IN',
    });
    expect(await suppression.isSuppressed(companyId, 'EMAIL', address)).toBe(false);
  });

  it('re-consenting does NOT clear a BOUNCE', async () => {
    // A bounce is a deliverability fact, not a permission one. Letting a new
    // opt-in clear it would send mail to an address that does not exist and
    // damage the sending domain's reputation.
    const address = 'bounced@example.com';
    await suppression.suppress({
      companyId,
      channel: 'EMAIL',
      address,
      reason: 'BOUNCED',
      source: 'provider-webhook',
    });
    await suppression.recordConsent({
      companyId,
      channel: 'EMAIL',
      address,
      status: 'GRANTED',
      source: 'FORM',
    });
    expect(await suppression.isSuppressed(companyId, 'EMAIL', address)).toBe(true);
  });

  it('keeps consent as an append-only history, not a flag', async () => {
    const rows = await prisma.marketingConsent.findMany({
      where: { companyId, address: 'consent@example.com' },
      orderBy: { createdAt: 'asc' },
    });
    // In a dispute the question is "what did they agree to, when, and how do
    // you know" — which a boolean cannot answer.
    expect(rows.map((r) => r.status)).toEqual(['GRANTED', 'WITHDRAWN', 'GRANTED']);
    expect(rows[0].evidence).toMatchObject({ url: 'https://example.com/signup' });
  });
});
