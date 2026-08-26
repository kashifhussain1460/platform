import { MarketingSyncService } from './marketing-sync.service';

/**
 * Ported from the former marketing-sync.processor.spec.ts — the reconciliation
 * logic now lives in MarketingSyncService (so the Vercel cron can drive it on
 * serverless). Same behaviour coverage, targeting sweep() directly.
 */
describe('MarketingSyncService.sweep', () => {
  const svc = (prisma: unknown, postizClient: unknown) =>
    new MarketingSyncService(prisma as never, postizClient as never);

  it('does nothing when there are no pending ScheduledPost rows', async () => {
    const prisma = {
      scheduledPost: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      publishedPost: { create: jest.fn() },
    };
    const postizClient = { listPosts: jest.fn() };
    const res = await svc(prisma, postizClient).sweep();
    expect(postizClient.listPosts).not.toHaveBeenCalled();
    expect(res.reconciled).toBe(0);
  });

  it('marks a ScheduledPost PUBLISHED and creates a PublishedPost row when Postiz reports it published', async () => {
    const prisma = {
      scheduledPost: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'sp_1', postizPostId: 'p_1', socialAccountId: 'sa_1', companyId: 'c_1', status: 'SCHEDULED' },
        ]),
        update: jest.fn(),
      },
      publishedPost: { create: jest.fn() },
    };
    const postizClient = {
      listPosts: jest.fn().mockResolvedValue([
        { id: 'p_1', state: 'PUBLISHED', releaseId: 'ig_123', releaseURL: 'https://instagram.com/p/abc' },
      ]),
    };
    const res = await svc(prisma, postizClient).sweep();
    expect(prisma.publishedPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledPostId: 'sp_1',
          platformPostId: 'ig_123',
          permalink: 'https://instagram.com/p/abc',
        }),
      }),
    );
    expect(prisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sp_1' }, data: { status: 'PUBLISHED' } }),
    );
    expect(res.reconciled).toBe(1);
  });

  it('marks a ScheduledPost FAILED when Postiz reports an error state', async () => {
    const prisma = {
      scheduledPost: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'sp_2', postizPostId: 'p_2', socialAccountId: 'sa_1', companyId: 'c_1', status: 'SCHEDULED' },
        ]),
        update: jest.fn(),
      },
      publishedPost: { create: jest.fn() },
    };
    const postizClient = {
      listPosts: jest.fn().mockResolvedValue([{ id: 'p_2', state: 'ERROR' }]),
    };
    await svc(prisma, postizClient).sweep();
    expect(prisma.publishedPost.create).not.toHaveBeenCalled();
    expect(prisma.scheduledPost.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sp_2' }, data: { status: 'FAILED' } }),
    );
  });

  it('leaves a ScheduledPost untouched when Postiz still shows it queued', async () => {
    const prisma = {
      scheduledPost: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'sp_3', postizPostId: 'p_3', socialAccountId: 'sa_1', companyId: 'c_1', status: 'SCHEDULED' },
        ]),
        update: jest.fn(),
      },
      publishedPost: { create: jest.fn() },
    };
    const postizClient = {
      listPosts: jest.fn().mockResolvedValue([{ id: 'p_3', state: 'QUEUE' }]),
    };
    await svc(prisma, postizClient).sweep();
    expect(prisma.publishedPost.create).not.toHaveBeenCalled();
    expect(prisma.scheduledPost.update).not.toHaveBeenCalled();
  });

  it('leaves a ScheduledPost untouched when Postiz has not reported it in this sweep', async () => {
    const prisma = {
      scheduledPost: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'sp_4', postizPostId: 'p_4', socialAccountId: 'sa_1', companyId: 'c_1', status: 'SCHEDULED' },
        ]),
        update: jest.fn(),
      },
      publishedPost: { create: jest.fn() },
    };
    const postizClient = { listPosts: jest.fn().mockResolvedValue([]) };
    await svc(prisma, postizClient).sweep();
    expect(prisma.publishedPost.create).not.toHaveBeenCalled();
    expect(prisma.scheduledPost.update).not.toHaveBeenCalled();
  });
});

describe('MarketingSyncService.snapshotAnalytics (M-10)', () => {
  const svc = (prisma: unknown, postizClient: unknown) =>
    new MarketingSyncService(prisma as never, postizClient as never);

  it('writes one MarketingAnalyticsSnapshot per CONNECTED social account', async () => {
    const prisma = {
      socialAccount: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'sa_1', companyId: 'c_1', postizIntegrationId: 'int_1' },
          { id: 'sa_2', companyId: 'c_2', postizIntegrationId: 'int_2' },
        ]),
      },
      marketingAnalyticsSnapshot: { create: jest.fn().mockResolvedValue({}) },
    };
    const postizClient = {
      getIntegrationAnalytics: jest.fn().mockResolvedValue({ impressions: 100 }),
    };

    const result = await svc(prisma, postizClient).snapshotAnalytics();

    expect(prisma.socialAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'CONNECTED' } }),
    );
    expect(postizClient.getIntegrationAnalytics).toHaveBeenCalledTimes(2);
    expect(prisma.marketingAnalyticsSnapshot.create).toHaveBeenCalledWith({
      data: { companyId: 'c_1', socialAccountId: 'sa_1', metrics: { impressions: 100 } },
    });
    expect(result).toEqual({ snapshotted: 2, failed: 0 });
  });

  it('one account failing does not stop the others, and is counted separately', async () => {
    const prisma = {
      socialAccount: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'sa_1', companyId: 'c_1', postizIntegrationId: 'int_1' },
          { id: 'sa_2', companyId: 'c_2', postizIntegrationId: 'int_2' },
        ]),
      },
      marketingAnalyticsSnapshot: { create: jest.fn().mockResolvedValue({}) },
    };
    const postizClient = {
      getIntegrationAnalytics: jest
        .fn()
        .mockRejectedValueOnce(new Error('Postiz down'))
        .mockResolvedValueOnce({ impressions: 50 }),
    };

    const result = await svc(prisma, postizClient).snapshotAnalytics();

    expect(result).toEqual({ snapshotted: 1, failed: 1 });
    expect(prisma.marketingAnalyticsSnapshot.create).toHaveBeenCalledTimes(1);
  });
});
