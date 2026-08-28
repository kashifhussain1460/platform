import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MarketingService } from './marketing.service';

/**
 * The two behaviours worth pinning hardest here are both about the outside
 * world: the import must never adopt another tenant's social account, and no
 * code path may create a post that LOOKS scheduled but was never handed to
 * Postiz (it would silently never publish).
 */
describe('MarketingService', () => {
  const account = {
    id: 'sa_1',
    companyId: 'c_1',
    provider: 'instagram',
    displayName: 'Acme',
    status: 'CONNECTED',
    employeeId: null,
    externalAccountId: null,
    postizIntegrationId: 'pi_1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
  };

  function build() {
    const prisma: any = {
      company: { findUnique: jest.fn().mockResolvedValue({ postizCustomerGroupId: 'grp_1' }) },
      socialAccount: {
        findMany: jest.fn().mockResolvedValue([account]),
        findFirst: jest.fn().mockResolvedValue(account),
        create: jest.fn().mockImplementation(({ data }: any) => ({ ...account, ...data, id: 'sa_new' })),
        update: jest.fn().mockImplementation(({ data }: any) => ({ ...account, ...data })),
      },
      scheduledPost: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn().mockImplementation(({ data }: any) => ({
          id: 'sp_1',
          campaignId: null,
          postizPostId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          socialAccount: { provider: 'instagram', displayName: 'Acme' },
          campaign: null,
          publishedPost: null,
          ...data,
        })),
        update: jest.fn().mockImplementation(({ data }: any) => ({
          id: 'sp_1',
          socialAccountId: 'sa_1',
          campaignId: null,
          content: 'x',
          publishAt: new Date(),
          status: 'DRAFT',
          postizPostId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        delete: jest.fn().mockResolvedValue({}),
      },
      campaign: {
        findFirst: jest.fn().mockResolvedValue({ id: 'cmp_1' }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
      aiEmployee: { findFirst: jest.fn().mockResolvedValue({ id: 'emp_1' }) },
      marketingAnalyticsSnapshot: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const postiz = {
      listIntegrations: jest.fn().mockResolvedValue([]),
      schedulePost: jest.fn().mockResolvedValue({ postizPostId: 'pz_1' }),
      getConnectUrl: jest.fn().mockResolvedValue({ url: 'https://postiz.test/oauth' }),
    };
    const service = new MarketingService(prisma, postiz as any);
    return { service, prisma, postiz };
  }

  const future = () => new Date(Date.now() + 86_400_000).toISOString();

  describe('importAccounts', () => {
    it('refuses to import when the company has no Postiz group', async () => {
      // Fail closed: one shared Postiz instance means an unfiltered import
      // would adopt other tenants' connected accounts.
      const { service, prisma, postiz } = build();
      prisma.company.findUnique.mockResolvedValueOnce({ postizCustomerGroupId: null });
      await expect(service.importAccounts('c_1')).rejects.toThrow(ConflictException);
      expect(postiz.listIntegrations).not.toHaveBeenCalled();
    });

    it('asks Postiz only for this company group', async () => {
      const { service, postiz } = build();
      await service.importAccounts('c_1');
      expect(postiz.listIntegrations).toHaveBeenCalledWith('grp_1');
    });

    it('discards an integration belonging to another group', async () => {
      // Defence in depth: `?group=` is a filter on a server we do not control.
      const { service, prisma, postiz } = build();
      postiz.listIntegrations.mockResolvedValueOnce([
        { id: 'pi_mine', name: 'Mine', identifier: 'instagram', disabled: false, customer: { id: 'grp_1', name: 'A' } },
        { id: 'pi_theirs', name: 'Theirs', identifier: 'linkedin', disabled: false, customer: { id: 'grp_2', name: 'B' } },
        { id: 'pi_untagged', name: 'Untagged', identifier: 'x', disabled: false },
      ]);
      prisma.socialAccount.findFirst.mockResolvedValue(null);

      const result = await service.importAccounts('c_1');

      expect(result.imported).toBe(1);
      expect(prisma.socialAccount.create).toHaveBeenCalledTimes(1);
      expect(prisma.socialAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ companyId: 'c_1', postizIntegrationId: 'pi_mine' }),
      });
    });

    it('mirrors a disabled Postiz integration as DISCONNECTED', async () => {
      // Otherwise the AI picks an account whose token no longer works and the
      // failure only shows up at publish time.
      const { service, prisma, postiz } = build();
      postiz.listIntegrations.mockResolvedValueOnce([
        { id: 'pi_1', name: 'Acme', identifier: 'instagram', disabled: true, customer: { id: 'grp_1', name: 'A' } },
      ]);
      prisma.socialAccount.findFirst.mockResolvedValue(null);
      await service.importAccounts('c_1');
      expect(prisma.socialAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'DISCONNECTED' }),
      });
    });

    it('updates an already-imported account instead of duplicating it', async () => {
      const { service, prisma, postiz } = build();
      postiz.listIntegrations.mockResolvedValueOnce([
        { id: 'pi_1', name: 'Acme Renamed', identifier: 'instagram', disabled: false, customer: { id: 'grp_1', name: 'A' } },
      ]);
      const result = await service.importAccounts('c_1');
      expect(result).toEqual(expect.objectContaining({ imported: 0, updated: 1 }));
      expect(prisma.socialAccount.create).not.toHaveBeenCalled();
    });
  });

  describe('createPost', () => {
    it('saves a draft without touching Postiz', async () => {
      const { service, prisma, postiz } = build();
      const post = await service.createPost('c_1', {
        socialAccountId: 'sa_1',
        content: 'hello',
      });
      expect(postiz.schedulePost).not.toHaveBeenCalled();
      expect(post.status).toBe('DRAFT');
      expect(prisma.scheduledPost.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT' }) }),
      );
    });

    it('never writes SCHEDULED without a postizPostId', async () => {
      // A SCHEDULED row with no provider id is skipped by the reconciliation
      // sweep, so it would sit in the UI looking queued and never publish —
      // a green screen with no side effect.
      const { service, prisma } = build();
      await service.createPost('c_1', {
        socialAccountId: 'sa_1',
        content: 'hi',
        publishAt: future(),
        schedule: true,
      });
      const written = prisma.scheduledPost.create.mock.calls[0][0].data;
      expect(written.status).toBe('SCHEDULED');
      expect(written.postizPostId).toBe('pz_1');
    });

    it('sends to Postiz BEFORE writing the local row', async () => {
      const { service, prisma, postiz } = build();
      const order: string[] = [];
      postiz.schedulePost.mockImplementationOnce(async () => {
        order.push('postiz');
        return { postizPostId: 'pz_1' };
      });
      prisma.scheduledPost.create.mockImplementationOnce(async ({ data }: any) => {
        order.push('db');
        return { id: 'sp_1', createdAt: new Date(), updatedAt: new Date(), ...data };
      });
      await service.createPost('c_1', {
        socialAccountId: 'sa_1',
        content: 'hi',
        publishAt: future(),
        schedule: true,
      });
      expect(order).toEqual(['postiz', 'db']);
    });

    it('refuses to schedule to a disconnected account', async () => {
      const { service, prisma, postiz } = build();
      prisma.socialAccount.findFirst.mockResolvedValueOnce({
        ...account,
        status: 'DISCONNECTED',
      });
      await expect(
        service.createPost('c_1', {
          socialAccountId: 'sa_1',
          content: 'hi',
          publishAt: future(),
          schedule: true,
        }),
      ).rejects.toThrow(ConflictException);
      expect(postiz.schedulePost).not.toHaveBeenCalled();
    });

    it('rejects a past publishAt', async () => {
      const { service } = build();
      await expect(
        service.createPost('c_1', {
          socialAccountId: 'sa_1',
          content: 'hi',
          publishAt: '2020-01-01T00:00:00Z',
          schedule: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an account belonging to another company', async () => {
      const { service, prisma } = build();
      prisma.socialAccount.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.createPost('c_1', { socialAccountId: 'sa_other', content: 'hi' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updatePost / cancelPost', () => {
    it('refuses to edit a SCHEDULED post', async () => {
      // Postiz holds the copy that will actually publish; editing only the
      // local row would show text the followers never see.
      const { service, prisma } = build();
      prisma.scheduledPost.findFirst.mockResolvedValueOnce({ id: 'sp_1', status: 'SCHEDULED' });
      await expect(service.updatePost('c_1', 'sp_1', { content: 'new' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('allows editing a DRAFT', async () => {
      const { service, prisma } = build();
      prisma.scheduledPost.findFirst.mockResolvedValueOnce({ id: 'sp_1', status: 'DRAFT' });
      const post = await service.updatePost('c_1', 'sp_1', { content: 'new' });
      expect(post.content).toBe('new');
    });

    it('refuses to cancel a PUBLISHED post', async () => {
      const { service, prisma } = build();
      prisma.scheduledPost.findFirst.mockResolvedValueOnce({ id: 'sp_1', status: 'PUBLISHED' });
      await expect(service.cancelPost('c_1', 'sp_1')).rejects.toThrow(ConflictException);
      expect(prisma.scheduledPost.delete).not.toHaveBeenCalled();
    });
  });

  describe('deleteCampaign', () => {
    it('detaches posts rather than deleting them', async () => {
      const { service, prisma } = build();
      const result = await service.deleteCampaign('c_1', 'cmp_1');
      expect(result.detachedPosts).toBe(2);
      expect(prisma.scheduledPost.updateMany).toHaveBeenCalledWith({
        where: { companyId: 'c_1', campaignId: 'cmp_1' },
        data: { campaignId: null },
      });
    });

    it('will not delete another company’s campaign', async () => {
      const { service, prisma } = build();
      prisma.campaign.findFirst.mockResolvedValueOnce(null);
      await expect(service.deleteCampaign('c_1', 'cmp_other')).rejects.toThrow(NotFoundException);
      expect(prisma.campaign.delete).not.toHaveBeenCalled();
    });
  });

  describe('tenant scoping', () => {
    it('filters every list by companyId', async () => {
      const { service, prisma } = build();
      await service.listAccounts('c_1');
      await service.listPosts('c_1');
      await service.listCampaigns('c_1');
      await service.listAnalytics('c_1');
      for (const call of [
        prisma.socialAccount.findMany.mock.calls[0][0],
        prisma.scheduledPost.findMany.mock.calls[0][0],
        prisma.campaign.findMany.mock.calls[0][0],
        prisma.marketingAnalyticsSnapshot.findMany.mock.calls[0][0],
      ]) {
        expect(call.where.companyId).toBe('c_1');
      }
    });
  });

  describe('startConnect', () => {
    it('rejects a platform identifier that is not one', async () => {
      const { service, postiz } = build();
      await expect(service.startConnect('../../etc/passwd')).rejects.toThrow(BadRequestException);
      expect(postiz.getConnectUrl).not.toHaveBeenCalled();
    });
  });
});
