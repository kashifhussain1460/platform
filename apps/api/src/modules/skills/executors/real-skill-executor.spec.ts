import { Prisma } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { RealSkillExecutor } from './real-skill-executor';
import type { SkillExecutor } from './skill-executor';
import type { SchedulingService } from '../../scheduling/scheduling.service';
import { ToolIdempotencyService } from '../../../common/idempotency/tool-idempotency.service';

// Minimal stand-ins for the collaborators RealSkillExecutor doesn't exercise in
// these postiz.* cases (no network config lookups, no scheduling, no fallback).
const configMock = {} as unknown as ConfigService;
const fallbackMock = {
  execute: jest.fn().mockResolvedValue({ ok: false, error: 'not implemented' }),
} as unknown as SkillExecutor;
const schedulingMock = {} as unknown as SchedulingService;
const chatwootClientMock = {} as any;
const cryptoMock = {} as any;
const planeClientMock = {} as any;
// Transparent passthrough by default (runs `effect` and returns its result,
// deduped:false) — tests that specifically exercise M-06 idempotency behavior
// (schedule_post, reply_to_conversation) construct their own executor with a
// real ToolIdempotencyService-shaped mock instead of using this one.
const idempotencyMock = {
  runIdempotent: jest.fn(async ({ effect }: { effect: () => Promise<unknown> }) => ({
    result: await effect(),
    deduped: false,
  })),
} as any;
// M-08: only exercised by the 'marketing.check_consent' tests below, which
// construct their own executor with a real SuppressionService-shaped mock.
const suppressionMock = {} as any;

const ctx = { companyId: 'c_1' };

describe('RealSkillExecutor — postiz.*', () => {
  describe('postiz.schedule_post', () => {
    it('delegates to PostizClientService.schedulePost', async () => {
      const postizClient = {
        schedulePost: jest.fn().mockResolvedValue({ postizPostId: 'p_123' }),
      };
      const prisma = {
        socialAccount: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sa_1',
            companyId: 'c_1',
            postizIntegrationId: 'int_1',
          }),
        },
        scheduledPost: {
          create: jest.fn().mockResolvedValue({ id: 'sp_1' }),
        },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'schedule_post',
        { socialAccountId: 'sa_1', content: 'Hello world', publishAt: '2026-08-01T09:00:00Z' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(postizClient.schedulePost).toHaveBeenCalledWith(
        expect.objectContaining({
          postizIntegrationId: 'int_1',
          content: 'Hello world',
          type: 'schedule',
          date: '2026-08-01T09:00:00Z',
        }),
      );
      expect(result.result).toEqual({ scheduledPostId: 'sp_1', postizPostId: 'p_123', deduped: false });
    });

    it('fails without hitting Postiz when the SocialAccount is missing', async () => {
      const postizClient = { schedulePost: jest.fn() };
      const prisma = {
        socialAccount: { findFirst: jest.fn().mockResolvedValue(null) },
        scheduledPost: { create: jest.fn() },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'schedule_post',
        { socialAccountId: 'sa_missing', content: 'Hi', publishAt: '2026-08-01T09:00:00Z' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(postizClient.schedulePost).not.toHaveBeenCalled();
    });

    it('M-06: does NOT schedule twice for a retried identical schedule_post (real ToolIdempotencyService)', async () => {
      // The bug this closes: schedule_post had NO idempotency at all, unlike
      // its sibling publish_now — a retried TOOL_ACTION (queue redelivery, a
      // crash-replay) scheduled the same content to the same account TWICE,
      // a real, duplicate, public post at Postiz.
      const postizClient = {
        schedulePost: jest.fn().mockResolvedValue({ postizPostId: 'p_dup' }),
      };
      let existingRecord: any = null;
      const prisma: any = {
        socialAccount: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sa_1',
            companyId: 'c_1',
            postizIntegrationId: 'int_1',
          }),
        },
        scheduledPost: {
          create: jest.fn().mockResolvedValue({ id: 'sp_dup' }),
        },
        toolIdempotencyRecord: {
          create: jest.fn(async (args: any) => {
            if (existingRecord) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
              });
            }
            existingRecord = { id: 'rec_1', ...args.data, createdAt: new Date() };
            return existingRecord;
          }),
          findUniqueOrThrow: jest.fn(async () => existingRecord),
          update: jest.fn(async (args: any) => {
            existingRecord = { ...existingRecord, ...args.data };
            return existingRecord;
          }),
        },
      };
      const realIdempotency = new ToolIdempotencyService(prisma);
      const args = { socialAccountId: 'sa_1', content: 'Hello world', publishAt: '2026-08-01T09:00:00Z' };

      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        realIdempotency,
        suppressionMock,
      );

      const first = await executor.execute('postiz', 'schedule_post', args, ctx);
      const second = await executor.execute('postiz', 'schedule_post', args, ctx);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect((second.result as any).deduped).toBe(true);
      // The whole point: Postiz and the DB are each touched exactly once.
      expect(postizClient.schedulePost).toHaveBeenCalledTimes(1);
      expect(prisma.scheduledPost.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('postiz.publish_now', () => {
    it('delegates to PostizClientService.schedulePost with type "now"', async () => {
      const postizClient = {
        schedulePost: jest.fn().mockResolvedValue({ postizPostId: 'p_456' }),
      };
      const prisma = {
        socialAccount: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sa_1',
            companyId: 'c_1',
            postizIntegrationId: 'int_1',
          }),
        },
        // WAVE 3 §3.6 — publish_now now TRACKS the publish locally.
        scheduledPost: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'sp_now' }),
          update: jest.fn().mockResolvedValue({ id: 'sp_now' }),
        },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'publish_now',
        { socialAccountId: 'sa_1', content: 'Go live' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(postizClient.schedulePost).toHaveBeenCalledWith(
        expect.objectContaining({ postizIntegrationId: 'int_1', content: 'Go live', type: 'now' }),
      );
      expect(result.result).toEqual({
        scheduledPostId: 'sp_now',
        postizPostId: 'p_456',
      });
      // The intent is recorded BEFORE the call, then completed after it — so a
      // crash mid-call leaves a visible non-PUBLISHED row rather than a post
      // that exists at the provider and nowhere else.
      expect(prisma.scheduledPost.create).toHaveBeenCalled();
      expect(prisma.scheduledPost.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PUBLISHED', postizPostId: 'p_456' }),
        }),
      );
    });

    it('does NOT publish twice for a retried identical publish', async () => {
      // The bug this closes: publish_now wrote no local row, so a retried
      // TOOL_ACTION posted the same content to the same account again —
      // public and irreversible.
      const postizClient = {
        schedulePost: jest.fn().mockResolvedValue({ postizPostId: 'p_456' }),
      };
      const prisma = {
        socialAccount: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sa_1',
            companyId: 'c_1',
            postizIntegrationId: 'int_1',
          }),
        },
        scheduledPost: {
          // A prior publish of the same content, already at the provider.
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'sp_prev', postizPostId: 'p_456' }),
          create: jest.fn(),
          update: jest.fn(),
        },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'publish_now',
        { socialAccountId: 'sa_1', content: 'Go live' },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(result.result).toEqual({
        scheduledPostId: 'sp_prev',
        postizPostId: 'p_456',
        deduped: true,
      });
      // The whole point: the provider is never called a second time.
      expect(postizClient.schedulePost).not.toHaveBeenCalled();
      expect(prisma.scheduledPost.create).not.toHaveBeenCalled();
    });
  });

  describe('postiz.list_connected_accounts', () => {
    it('returns the company\'s CONNECTED social accounts', async () => {
      const postizClient = {};
      const accounts = [{ id: 'sa_1', status: 'CONNECTED' }];
      const prisma = {
        socialAccount: { findMany: jest.fn().mockResolvedValue(accounts) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute('postiz', 'list_connected_accounts', {}, ctx);
      expect(result.ok).toBe(true);
      expect(prisma.socialAccount.findMany).toHaveBeenCalledWith({
        where: { companyId: 'c_1', status: 'CONNECTED' },
      });
      expect(result.result).toEqual({ accounts });
    });
  });

  describe('postiz.start_connect_account', () => {
    it('delegates to PostizClientService.getConnectUrl', async () => {
      const postizClient = {
        getConnectUrl: jest.fn().mockResolvedValue({ url: 'https://postiz.example/connect' }),
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        {} as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'start_connect_account',
        { platform: 'instagram' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(postizClient.getConnectUrl).toHaveBeenCalledWith('instagram');
      expect(result.result).toEqual({ url: 'https://postiz.example/connect' });
    });

    it('fails when platform is missing', async () => {
      const postizClient = { getConnectUrl: jest.fn() };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        {} as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute('postiz', 'start_connect_account', {}, ctx);
      expect(result.ok).toBe(false);
      expect(postizClient.getConnectUrl).not.toHaveBeenCalled();
    });
  });

  describe('postiz.get_post_status', () => {
    it('returns the stored ScheduledPost status when no PublishedPost exists yet', async () => {
      const postizClient = {};
      const prisma = {
        scheduledPost: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sp_1',
            status: 'SCHEDULED',
            postizPostId: 'p_123',
          }),
        },
        publishedPost: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'get_post_status',
        { scheduledPostId: 'sp_1' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(result.result).toEqual({ status: 'SCHEDULED', postizPostId: 'p_123' });
    });

    it('includes platformPostId/permalink when a PublishedPost row exists', async () => {
      const postizClient = {};
      const prisma = {
        scheduledPost: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sp_1',
            status: 'PUBLISHED',
            postizPostId: 'p_123',
          }),
        },
        publishedPost: {
          findUnique: jest.fn().mockResolvedValue({
            platformPostId: 'ig_123',
            permalink: 'https://instagram.com/p/abc',
          }),
        },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'get_post_status',
        { scheduledPostId: 'sp_1' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(result.result).toEqual({
        status: 'PUBLISHED',
        postizPostId: 'p_123',
        platformPostId: 'ig_123',
        permalink: 'https://instagram.com/p/abc',
      });
    });

    it('fails when the ScheduledPost is not found for this company', async () => {
      const postizClient = {};
      const prisma = {
        scheduledPost: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'get_post_status',
        { scheduledPostId: 'sp_missing' },
        ctx,
      );
      expect(result.ok).toBe(false);
    });
  });

  describe('postiz.get_post_analytics (M-10)', () => {
    it('resolves the local ScheduledPost then returns the real Postiz analytics', async () => {
      const postizClient = {
        getPostAnalytics: jest.fn().mockResolvedValue({ likes: 10, impressions: 500 }),
      };
      const prisma = {
        scheduledPost: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sp_1',
            status: 'PUBLISHED',
            postizPostId: 'p_123',
          }),
        },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'get_post_analytics',
        { scheduledPostId: 'sp_1' },
        ctx,
      );
      expect(postizClient.getPostAnalytics).toHaveBeenCalledWith('p_123');
      expect(result.ok).toBe(true);
      expect(result.result).toEqual({
        scheduledPostId: 'sp_1',
        postizPostId: 'p_123',
        analytics: { likes: 10, impressions: 500 },
      });
    });

    it('fails when the ScheduledPost is not found for this company', async () => {
      const postizClient = { getPostAnalytics: jest.fn() };
      const prisma = {
        scheduledPost: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'get_post_analytics',
        { scheduledPostId: 'sp_missing' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(postizClient.getPostAnalytics).not.toHaveBeenCalled();
    });

    it('fails when the post has not been published yet (no postizPostId)', async () => {
      const postizClient = { getPostAnalytics: jest.fn() };
      const prisma = {
        scheduledPost: {
          findFirst: jest.fn().mockResolvedValue({ id: 'sp_1', status: 'SCHEDULED', postizPostId: null }),
        },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'get_post_analytics',
        { scheduledPostId: 'sp_1' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(postizClient.getPostAnalytics).not.toHaveBeenCalled();
    });

    it('surfaces the Postiz client error as a failed result rather than throwing', async () => {
      const postizClient = {
        getPostAnalytics: jest.fn().mockRejectedValue(new Error('Postiz getPostAnalytics failed: 500')),
      };
      const prisma = {
        scheduledPost: {
          findFirst: jest.fn().mockResolvedValue({ id: 'sp_1', status: 'PUBLISHED', postizPostId: 'p_1' }),
        },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClient as any,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'postiz',
        'get_post_analytics',
        { scheduledPostId: 'sp_1' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Postiz getPostAnalytics failed: 500');
    });
  });
});

describe('RealSkillExecutor — chatwoot.*', () => {
  const postizClientMock = {} as any;

  describe('chatwoot.list_open_conversations', () => {
    it("returns the company's OPEN SupportConversation rows", async () => {
      const conversations = [{ id: 'conv_1', status: 'OPEN' }];
      const prisma = {
        supportConversation: { findMany: jest.fn().mockResolvedValue(conversations) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute('chatwoot', 'list_open_conversations', {}, ctx);
      expect(result.ok).toBe(true);
      expect(prisma.supportConversation.findMany).toHaveBeenCalledWith({
        where: { companyId: 'c_1', status: 'OPEN' },
      });
      expect(result.result).toEqual({ conversations });
    });
  });

  describe('chatwoot.get_conversation', () => {
    it('returns the conversation with its ordered messages when found for this company', async () => {
      const conversation = { id: 'conv_1', companyId: 'c_1', messages: [] };
      const prisma = {
        supportConversation: { findFirst: jest.fn().mockResolvedValue(conversation) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'chatwoot',
        'get_conversation',
        { conversationId: 'conv_1' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(prisma.supportConversation.findFirst).toHaveBeenCalledWith({
        where: { id: 'conv_1', companyId: 'c_1' },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
      expect(result.result).toEqual({ conversation });
    });

    it('fails when the conversation is not found for this company (wrong tenant)', async () => {
      const prisma = {
        supportConversation: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'chatwoot',
        'get_conversation',
        { conversationId: 'conv_other_company' },
        ctx,
      );
      expect(result.ok).toBe(false);
    });
  });

  describe('chatwoot.reply_to_conversation', () => {
    it('decrypts the token, sends via ChatwootClientService, and records an OUT message', async () => {
      const conversation = { id: 'conv_1', companyId: 'c_1', chatwootConversationId: 'cw_conv_1' };
      const account = {
        id: 'acct_1',
        companyId: 'c_1',
        chatwootAccountId: 'cw_acct_1',
        agentBotToken: 'v1:encrypted:blob:here',
      };
      const prisma = {
        supportConversation: {
          findFirst: jest.fn().mockResolvedValue(conversation),
          update: jest.fn().mockResolvedValue({ ...conversation, lastMessageAt: new Date() }),
        },
        chatwootAccount: { findFirst: jest.fn().mockResolvedValue(account) },
        supportMessage: { create: jest.fn().mockResolvedValue({ id: 'msg_1' }) },
        $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      };
      const chatwootClient = {
        sendReply: jest.fn().mockResolvedValue({ chatwootMessageId: 'cw_msg_1' }),
      };
      const crypto = { decrypt: jest.fn().mockReturnValue('plaintext-bot-token') };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClient as any,
        crypto as any,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'chatwoot',
        'reply_to_conversation',
        { conversationId: 'conv_1', content: 'Thanks for reaching out!' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(prisma.chatwootAccount.findFirst).toHaveBeenCalledWith({
        where: { companyId: 'c_1' },
      });
      expect(crypto.decrypt).toHaveBeenCalledWith(account.agentBotToken);
      expect(chatwootClient.sendReply).toHaveBeenCalledWith(
        'cw_acct_1',
        'cw_conv_1',
        'plaintext-bot-token',
        'Thanks for reaching out!',
      );
      expect(prisma.supportMessage.create).toHaveBeenCalledWith({
        data: {
          companyId: 'c_1',
          conversationId: 'conv_1',
          direction: 'OUT',
          content: 'Thanks for reaching out!',
          chatwootMessageId: 'cw_msg_1',
        },
      });
      expect(result.result).toEqual({ messageId: 'msg_1', chatwootMessageId: 'cw_msg_1', deduped: false });
    });

    it('fails without calling Chatwoot when there is no ChatwootAccount for this company', async () => {
      const conversation = { id: 'conv_1', companyId: 'c_1', chatwootConversationId: 'cw_conv_1' };
      const prisma = {
        supportConversation: { findFirst: jest.fn().mockResolvedValue(conversation) },
        chatwootAccount: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const chatwootClient = { sendReply: jest.fn() };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClient as any,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'chatwoot',
        'reply_to_conversation',
        { conversationId: 'conv_1', content: 'Hi' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Chatwoot not connected for this company');
      expect(chatwootClient.sendReply).not.toHaveBeenCalled();
    });

    it('fails when the conversation is not found for this company', async () => {
      const prisma = {
        supportConversation: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const chatwootClient = { sendReply: jest.fn() };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClient as any,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'chatwoot',
        'reply_to_conversation',
        { conversationId: 'conv_missing', content: 'Hi' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(chatwootClient.sendReply).not.toHaveBeenCalled();
    });

    it('S-13/C-06: refuses to reply when the conversation is ESCALATED to a human', async () => {
      const conversation = {
        id: 'conv_1',
        companyId: 'c_1',
        chatwootConversationId: 'cw_conv_1',
        status: 'ESCALATED',
      };
      const prisma = {
        supportConversation: { findFirst: jest.fn().mockResolvedValue(conversation) },
        chatwootAccount: { findFirst: jest.fn() },
      };
      const chatwootClient = { sendReply: jest.fn() };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClient as any,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'chatwoot',
        'reply_to_conversation',
        { conversationId: 'conv_1', content: 'Hi' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/escalated to a human/i);
      expect(chatwootClient.sendReply).not.toHaveBeenCalled();
      expect(prisma.chatwootAccount.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('chatwoot.resolve_conversation', () => {
    // S-02: this tool has no live Chatwoot resolve/toggle-status call yet.
    // It must report an honest failure rather than a fake success, and must
    // NOT mutate the local mirror row (a status claiming RESOLVED while the
    // real ticket is still open is a silent-success defect).
    it('returns an honest NOT_IMPLEMENTED failure and does not touch the DB', async () => {
      const conversation = { id: 'conv_1', companyId: 'c_1', status: 'OPEN' };
      const prisma = {
        supportConversation: {
          findFirst: jest.fn().mockResolvedValue(conversation),
          update: jest.fn(),
        },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'chatwoot',
        'resolve_conversation',
        { conversationId: 'conv_1' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/NOT YET IMPLEMENTED/);
      expect(prisma.supportConversation.findFirst).toHaveBeenCalledWith({
        where: { id: 'conv_1', companyId: 'c_1' },
      });
      expect(prisma.supportConversation.update).not.toHaveBeenCalled();
    });

    it('fails when the conversation is not found for this company', async () => {
      const prisma = {
        supportConversation: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'chatwoot',
        'resolve_conversation',
        { conversationId: 'conv_missing' },
        ctx,
      );
      expect(result.ok).toBe(false);
    });
  });
});

describe('RealSkillExecutor — marketing.check_consent (M-08)', () => {
  function build(suppression: any) {
    return new RealSkillExecutor(
      configMock,
      fallbackMock,
      schedulingMock,
      {} as any,
      {} as any,
      chatwootClientMock,
      cryptoMock,
      planeClientMock,
      idempotencyMock,
      suppression,
    );
  }

  it('reports allConsented=true only when every address is GRANTED and not suppressed', async () => {
    const suppression = {
      isSuppressed: jest.fn().mockResolvedValue(false),
      latestConsent: jest.fn().mockResolvedValue({ status: 'GRANTED' }),
    };
    const executor = build(suppression);

    const result = await executor.execute(
      'marketing',
      'check_consent',
      { channel: 'EMAIL', addresses: 'alice@example.com' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      allConsented: true,
      checkedCount: 1,
      missingConsent: [],
      suppressed: [],
    });
    expect(suppression.isSuppressed).toHaveBeenCalledWith('c_1', 'EMAIL', 'alice@example.com');
    expect(suppression.latestConsent).toHaveBeenCalledWith('c_1', 'EMAIL', 'alice@example.com');
  });

  it('never trusts a caller-supplied flag — queries real state per address, mixed batch', async () => {
    // The whole point of M-08: this is a REAL query, not
    // `{{trigger.consentVerified}}`. Three addresses, three different real
    // outcomes, none of them assumed.
    const suppression = {
      isSuppressed: jest.fn(async (_c: string, _ch: string, addr: string) => addr === 'suppressed@example.com'),
      latestConsent: jest.fn(async (_c: string, _ch: string, addr: string) => {
        if (addr === 'granted@example.com') return { status: 'GRANTED' };
        if (addr === 'withdrawn@example.com') return { status: 'WITHDRAWN' };
        return null; // never consented at all
      }),
    };
    const executor = build(suppression);

    const result = await executor.execute(
      'marketing',
      'check_consent',
      { channel: 'EMAIL', addresses: 'granted@example.com, withdrawn@example.com, suppressed@example.com' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      allConsented: false,
      checkedCount: 3,
      missingConsent: ['withdrawn@example.com', 'suppressed@example.com'],
      suppressed: ['suppressed@example.com'],
    });
  });

  it('fails with a clear error when no valid addresses are supplied', async () => {
    const suppression = { isSuppressed: jest.fn(), latestConsent: jest.fn() };
    const executor = build(suppression);

    const result = await executor.execute(
      'marketing',
      'check_consent',
      { channel: 'EMAIL', addresses: '   ' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(suppression.isSuppressed).not.toHaveBeenCalled();
  });

  it('fails on an unknown channel', async () => {
    const suppression = { isSuppressed: jest.fn(), latestConsent: jest.fn() };
    const executor = build(suppression);

    const result = await executor.execute(
      'marketing',
      'check_consent',
      { channel: 'CARRIER_PIGEON', addresses: 'alice@example.com' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(suppression.isSuppressed).not.toHaveBeenCalled();
  });
});

describe('RealSkillExecutor — plane.*', () => {
  const postizClientMock2 = {} as any;

  describe('plane.list_issues', () => {
    it("returns the project's tracked issues (companyId-scoped)", async () => {
      const project = { id: 'proj_1', companyId: 'c_1', planeWorkspaceId: 'ws_1' };
      const issues = [{ id: 'issue_1', planeProjectId: 'proj_1', companyId: 'c_1' }];
      const prisma = {
        planeProject: { findFirst: jest.fn().mockResolvedValue(project) },
        trackedIssue: { findMany: jest.fn().mockResolvedValue(issues) },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock2,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute('plane', 'list_issues', { projectId: 'proj_1' }, ctx);
      expect(result.ok).toBe(true);
      expect(prisma.planeProject.findFirst).toHaveBeenCalledWith({
        where: { id: 'proj_1', companyId: 'c_1' },
      });
      expect(prisma.trackedIssue.findMany).toHaveBeenCalledWith({
        where: { planeProjectId: 'proj_1', companyId: 'c_1' },
      });
      expect(result.result).toEqual({ issues });
    });

    it('fails when the project is not found for this company (wrong tenant)', async () => {
      const prisma = {
        planeProject: { findFirst: jest.fn().mockResolvedValue(null) },
        trackedIssue: { findMany: jest.fn() },
      };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock2,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClientMock,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'plane',
        'list_issues',
        { projectId: 'proj_other_company' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(prisma.trackedIssue.findMany).not.toHaveBeenCalled();
    });
  });

  describe('plane.create_issue', () => {
    it('decrypts the token, calls PlaneClientService.createIssue, and writes a TrackedIssue', async () => {
      const project = { id: 'proj_1', companyId: 'c_1', planeProjectId: 'plane_proj_1', planeWorkspaceId: 'ws_1' };
      const workspace = {
        id: 'ws_1',
        companyId: 'c_1',
        planeWorkspaceSlug: 'acme',
        apiToken: 'v1:encrypted:blob:here',
      };
      const prisma = {
        planeProject: { findFirst: jest.fn().mockResolvedValue(project) },
        planeWorkspace: { findFirst: jest.fn().mockResolvedValue(workspace) },
        trackedIssue: { create: jest.fn().mockResolvedValue({ id: 'issue_1' }) },
      };
      const planeClient = {
        createIssue: jest.fn().mockResolvedValue({ planeIssueId: 'plane_issue_1' }),
      };
      const crypto = { decrypt: jest.fn().mockReturnValue('plaintext-api-token') };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock2,
        prisma as any,
        chatwootClientMock,
        crypto as any,
        planeClient as any,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'plane',
        'create_issue',
        { projectId: 'proj_1', title: 'Fix bug', description: 'Details here' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(prisma.planeWorkspace.findFirst).toHaveBeenCalledWith({
        where: { id: 'ws_1', companyId: 'c_1' },
      });
      expect(crypto.decrypt).toHaveBeenCalledWith(workspace.apiToken);
      expect(planeClient.createIssue).toHaveBeenCalledWith('acme', 'plane_proj_1', 'plaintext-api-token', {
        title: 'Fix bug',
        description: 'Details here',
      });
      expect(prisma.trackedIssue.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          companyId: 'c_1',
          planeProjectId: 'proj_1',
          planeIssueId: 'plane_issue_1',
          title: 'Fix bug',
          status: 'open',
        }),
      });
      expect(result.result).toEqual({ issueId: 'issue_1', planeIssueId: 'plane_issue_1' });
    });

    it('fails without calling Plane when there is no PlaneWorkspace for this company', async () => {
      const project = { id: 'proj_1', companyId: 'c_1', planeProjectId: 'plane_proj_1', planeWorkspaceId: 'ws_1' };
      const prisma = {
        planeProject: { findFirst: jest.fn().mockResolvedValue(project) },
        planeWorkspace: { findFirst: jest.fn().mockResolvedValue(null) },
        trackedIssue: { create: jest.fn() },
      };
      const planeClient = { createIssue: jest.fn() };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock2,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClient as any,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'plane',
        'create_issue',
        { projectId: 'proj_1', title: 'Fix bug' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Plane not connected for this company');
      expect(planeClient.createIssue).not.toHaveBeenCalled();
    });

    it('fails when the project is not found for this company', async () => {
      const prisma = {
        planeProject: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const planeClient = { createIssue: jest.fn() };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock2,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClient as any,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'plane',
        'create_issue',
        { projectId: 'proj_missing', title: 'Fix bug' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(planeClient.createIssue).not.toHaveBeenCalled();
    });
  });

  describe('plane.update_issue_status', () => {
    it('decrypts the token, calls PlaneClientService.updateIssueStatus, and updates the local row', async () => {
      const trackedIssue = {
        id: 'issue_1',
        companyId: 'c_1',
        planeProjectId: 'proj_1',
        planeIssueId: 'plane_issue_1',
        status: 'open',
      };
      const project = { id: 'proj_1', companyId: 'c_1', planeProjectId: 'plane_proj_1', planeWorkspaceId: 'ws_1' };
      const workspace = {
        id: 'ws_1',
        companyId: 'c_1',
        planeWorkspaceSlug: 'acme',
        apiToken: 'v1:encrypted:blob:here',
      };
      const prisma = {
        trackedIssue: {
          findFirst: jest.fn().mockResolvedValue(trackedIssue),
          update: jest.fn().mockResolvedValue({ id: 'issue_1', status: 'Done' }),
        },
        planeProject: { findFirst: jest.fn().mockResolvedValue(project) },
        planeWorkspace: { findFirst: jest.fn().mockResolvedValue(workspace) },
      };
      const planeClient = { updateIssueStatus: jest.fn().mockResolvedValue(undefined) };
      const crypto = { decrypt: jest.fn().mockReturnValue('plaintext-api-token') };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock2,
        prisma as any,
        chatwootClientMock,
        crypto as any,
        planeClient as any,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'plane',
        'update_issue_status',
        { issueId: 'issue_1', status: 'Done' },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(crypto.decrypt).toHaveBeenCalledWith(workspace.apiToken);
      expect(planeClient.updateIssueStatus).toHaveBeenCalledWith(
        'acme',
        'plane_proj_1',
        'plaintext-api-token',
        'plane_issue_1',
        'Done',
      );
      expect(prisma.trackedIssue.update).toHaveBeenCalledWith({
        where: { id: 'issue_1' },
        data: expect.objectContaining({ status: 'Done' }),
      });
      expect(result.result).toEqual({ id: 'issue_1', status: 'Done' });
    });

    it('fails when the TrackedIssue is not found for this company (wrong tenant)', async () => {
      const prisma = {
        trackedIssue: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const planeClient = { updateIssueStatus: jest.fn() };
      const executor = new RealSkillExecutor(
        configMock,
        fallbackMock,
        schedulingMock,
        postizClientMock2,
        prisma as any,
        chatwootClientMock,
        cryptoMock,
        planeClient as any,
        idempotencyMock,
        suppressionMock,
      );
      const result = await executor.execute(
        'plane',
        'update_issue_status',
        { issueId: 'issue_other_company', status: 'Done' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(planeClient.updateIssueStatus).not.toHaveBeenCalled();
    });
  });
});
