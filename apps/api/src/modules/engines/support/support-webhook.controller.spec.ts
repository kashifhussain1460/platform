import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { SupportWebhookController } from './support-webhook.controller';
import { ChatwootClientService } from './chatwoot-client.service';
import { CryptoService } from '../../../common/crypto/crypto.service';

/**
 * The test that proves the security fix this task exists for: a request with
 * a WRONG signature must be rejected (401) WITHOUT any SupportConversation/
 * SupportMessage read-then-write ever reaching Prisma. Mirrors the exact
 * mistake Marketing/Postiz shipped and had to fix at final review — this
 * suite is written so Support never repeats it.
 */
describe('SupportWebhookController', () => {
  const secret = 'plaintext-webhook-secret';
  const encryptedSecret = `encrypted(${secret})`; // stand-in envelope, decrypted by the fake CryptoService below
  const companyId = 'company-1';
  const chatwootAccountId = '42';
  const chatwootAccountRowId = 'cwacct-1';

  function buildController() {
    const prisma = {
      chatwootAccount: {
        // S-07: the controller now calls findUnique (chatwootAccountId is
        // @unique) — findFirst is deliberately absent from this mock so a
        // regression back to the old, race-prone lookup fails loudly here.
        findUnique: jest.fn().mockResolvedValue({
          id: chatwootAccountRowId,
          companyId,
          chatwootAccountId,
          webhookSecret: encryptedSecret,
        }),
      },
      supportConversation: {
        // Still used by enrichForMapping's isFirstMessage check (unchanged,
        // documented residual — see the report's "P2 follow-up" note).
        findFirst: jest.fn().mockResolvedValue(null),
        // S-07: applyPayload now does one atomic upsert instead of a
        // findFirst-then-create/update.
        upsert: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      },
      supportMessage: {
        create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      },
    };
    const crypto = {
      decrypt: jest.fn((env: string) => env.replace('encrypted(', '').replace(')', '')),
    } as unknown as CryptoService;
    // Only verifyWebhookSignature (pure) is exercised here — breaker/rate
    // limiter are never invoked, so lightweight stubs are enough.
    const chatwootClient = new ChatwootClientService(
      { get: () => undefined } as any,
      crypto,
      {} as any,
      {} as any,
    );
    // WAVE 3 §3.4 — the canonical pipeline stands between verification and the
    // local write. Default: not a duplicate, so existing behaviour is unchanged.
    const ingest = {
      ingestVerified: jest
        .fn()
        .mockResolvedValue({ deduped: false, rawEventId: 'raw-1' }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new SupportWebhookController(
      prisma as any,
      chatwootClient,
      crypto,
      ingest as any,
      audit as any,
    );
    return { controller, prisma, crypto, ingest, audit };
  }

  function sign(body: string, ts: string, withSecret = secret): string {
    const hex = createHmac('sha256', withSecret).update(`${ts}.${body}`).digest('hex');
    return `sha256=${hex}`;
  }

  function fakeReq(body: string) {
    return { rawBody: Buffer.from(body, 'utf8') } as any;
  }

  it('rejects a wrong signature with 401 and makes NO SupportConversation/SupportMessage call', async () => {
    const { controller, prisma } = buildController();
    const body = JSON.stringify({
      account: { id: 42 },
      conversation: { id: 7 },
      message_type: 'incoming',
      content: 'hello',
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const wrongSignature = sign(body, ts, 'not-the-real-secret');

    await expect(
      controller.receive(fakeReq(body), wrongSignature, ts),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.supportConversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.supportConversation.upsert).not.toHaveBeenCalled();
    expect(prisma.supportMessage.create).not.toHaveBeenCalled();
  });

  it('rejects when no ChatwootAccount matches the payload account id, before any Support* write', async () => {
    const { controller, prisma } = buildController();
    prisma.chatwootAccount.findUnique.mockResolvedValueOnce(null);
    const body = JSON.stringify({ account: { id: 999 }, conversation: { id: 7 } });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign(body, ts);

    await expect(
      controller.receive(fakeReq(body), signature, ts),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.supportConversation.upsert).not.toHaveBeenCalled();
    expect(prisma.supportMessage.create).not.toHaveBeenCalled();
  });

  it('rejects with missing signature/timestamp headers', async () => {
    const { controller, prisma } = buildController();
    const body = JSON.stringify({ account: { id: 42 }, conversation: { id: 7 } });

    await expect(
      controller.receive(fakeReq(body), undefined, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.supportConversation.upsert).not.toHaveBeenCalled();
  });

  it('accepts a correctly signed incoming message and creates conversation + IN message', async () => {
    const { controller, prisma } = buildController();
    const body = JSON.stringify({
      account: { id: 42 },
      conversation: { id: 7 },
      sender: { email: 'customer@example.com' },
      message_type: 'incoming',
      content: 'Hi, I need help',
      id: 555,
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign(body, ts);

    const result = await controller.receive(fakeReq(body), signature, ts);

    expect(result).toEqual({ ok: true });
    expect(prisma.supportConversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId_chatwootConversationId: { companyId, chatwootConversationId: '7' } },
        create: expect.objectContaining({
          companyId,
          chatwootAccountId: chatwootAccountRowId,
          chatwootConversationId: '7',
          contactEmail: 'customer@example.com',
        }),
      }),
    );
    expect(prisma.supportMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId,
        conversationId: 'conv-1',
        direction: 'IN',
        content: 'Hi, I need help',
        chatwootMessageId: '555',
      }),
    });
  });

  it('does not create a SupportMessage for an outgoing/activity event (only IN messages from this webhook)', async () => {
    const { controller, prisma } = buildController();
    const body = JSON.stringify({
      account: { id: 42 },
      conversation: { id: 7 },
      message_type: 'outgoing',
      content: 'agent reply',
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign(body, ts);

    const result = await controller.receive(fakeReq(body), signature, ts);

    expect(result).toEqual({ ok: true });
    expect(prisma.supportConversation.upsert).toHaveBeenCalled();
    expect(prisma.supportMessage.create).not.toHaveBeenCalled();
  });

  it('rejects when the request has no raw body at all', async () => {
    const { controller } = buildController();
    await expect(
      controller.receive({ rawBody: undefined } as any, 'sha256=whatever', '123'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // ── WAVE 3 §3.4 — the canonical pipeline + dedup guard ──────────────────────

  it('routes a verified delivery into the canonical pipeline before writing locally', async () => {
    const { controller, ingest, audit } = buildController();
    const body = JSON.stringify({
      account: { id: 42 },
      conversation: { id: 7 },
      message_type: 'incoming',
      content: 'hello',
      id: 1001,
    });
    const ts = String(Math.floor(Date.now() / 1000));

    await controller.receive(fakeReq(body), sign(body, ts), ts);

    expect(ingest.ingestVerified).toHaveBeenCalledTimes(1);
    const arg = ingest.ingestVerified.mock.calls[0][0];
    expect(arg.provider).toBe('chatwoot');
    expect(arg.companyId).toBe('company-1');
    // The mapper is pure and has no database, so the controller resolves the
    // one fact it cannot: first message (NEW_TICKET) vs reply (TICKET_REPLIED).
    expect(arg.payload.__isFirstMessage).toBe(true);
    expect(arg.payload.__conversationId).toBe('7');
    expect(audit.record).toHaveBeenCalled();
  });

  it('a DUPLICATE delivery writes no second SupportMessage', async () => {
    // Every webhook provider redelivers on timeout. Before WAVE 3 this appended
    // the same customer message again, every time, for ever.
    const { controller, prisma, ingest } = buildController();
    ingest.ingestVerified.mockResolvedValueOnce({
      deduped: true,
      rawEventId: 'raw-1',
    });
    const body = JSON.stringify({
      account: { id: 42 },
      conversation: { id: 7 },
      message_type: 'incoming',
      content: 'hello',
      id: 1001,
    });
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await controller.receive(fakeReq(body), sign(body, ts), ts);

    // 200 so the provider stops retrying, and nothing else happens.
    expect(res).toEqual({ ok: true });
    expect(prisma.supportConversation.upsert).not.toHaveBeenCalled();
    expect(prisma.supportMessage.create).not.toHaveBeenCalled();
  });

  it('does not ingest anything when the signature fails', async () => {
    const { controller, ingest } = buildController();
    const body = JSON.stringify({ account: { id: 42 }, conversation: { id: 7 } });
    const ts = String(Math.floor(Date.now() / 1000));
    await expect(
      controller.receive(fakeReq(body), sign(body, ts, 'wrong'), ts),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ingest.ingestVerified).not.toHaveBeenCalled();
  });
});
