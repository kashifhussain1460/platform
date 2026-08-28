import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PostizClientService } from '../src/modules/engines/marketing/postiz-client.service';

/**
 * The marketing workspace over real HTTP.
 *
 * Postiz itself is stubbed (no shared instance in CI) but everything Orlixa
 * owns is real: guards, the capability floors, tenant filtering, and the
 * refusal to create a post that would never publish.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Marketing workspace', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ts = Date.now();
  const password = 'password123';
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const future = () => new Date(Date.now() + 86_400_000).toISOString();

  const postizStub = {
    listIntegrations: jest.fn(),
    schedulePost: jest.fn(),
    getConnectUrl: jest.fn(),
  };

  let ownerToken = '';
  let memberToken = '';
  let companyId = '';
  let otherToken = '';
  let otherCompanyId = '';
  let accountId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PostizClientService)
      .useValue(postizStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const reg = await http()
      .post('/auth/register')
      .send({
        companyName: `Mkt Co ${ts}`,
        name: 'Mkt Owner',
        email: `mkt_owner_${ts}@example.com`,
        password,
      })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

    await http()
      .post('/users')
      .set(bearer(ownerToken))
      .send({ name: 'Mkt Member', email: `mkt_member_${ts}@example.com`, password, role: 'MEMBER' })
      .expect(201);
    const memberLogin = await http()
      .post('/auth/login')
      .send({ email: `mkt_member_${ts}@example.com`, password })
      .expect(201);
    memberToken = memberLogin.body.tokens.accessToken;

    const other = await http()
      .post('/auth/register')
      .send({
        companyName: `Mkt Other ${ts}`,
        name: 'Other Owner',
        email: `mkt_other_${ts}@example.com`,
        password,
      })
      .expect(201);
    otherToken = other.body.tokens.accessToken;
    otherCompanyId = other.body.user.companyId;
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.company.deleteMany({
        where: { id: { in: [companyId, otherCompanyId].filter(Boolean) } },
      });
    }
    await app?.close();
  });

  beforeEach(() => {
    postizStub.listIntegrations.mockReset();
    postizStub.schedulePost.mockReset();
    postizStub.getConnectUrl.mockReset();
  });

  it('requires authentication', async () => {
    await http().get('/marketing/accounts').expect(401);
  });

  describe('the Postiz tenancy bridge', () => {
    it('refuses to import while no customer group is assigned', async () => {
      // Fail closed. Importing without the group filter would adopt other
      // tenants' connected social accounts off the shared Postiz instance.
      const res = await http()
        .post('/marketing/accounts/import')
        .set(bearer(ownerToken))
        .expect(409);
      expect(res.body.message).toMatch(/customer group/i);
      expect(postizStub.listIntegrations).not.toHaveBeenCalled();
    });

    it('is not assignable through the tenant API', async () => {
      // A tenant able to set this could name a rival's group and import their
      // accounts, so it lives behind PlatformAdminGuard only. A company JWT
      // must not be accepted there.
      await http()
        .patch(`/internal/platform-admin/companies/${companyId}/postiz-group`)
        .set(bearer(ownerToken))
        .send({ postizCustomerGroupId: 'grp_1' })
        .expect(401);
    });
  });

  describe('once the bridge is configured', () => {
    beforeAll(async () => {
      // Set directly: minting a platform-operator token is a different
      // module's concern, already covered by its own suite.
      await prisma.company.update({
        where: { id: companyId },
        data: { postizCustomerGroupId: 'grp_1' },
      });
    });

    it('imports only the integrations tagged to this company', async () => {
      postizStub.listIntegrations.mockResolvedValueOnce([
        { id: 'pi_mine', name: 'Acme IG', identifier: 'instagram', disabled: false, customer: { id: 'grp_1', name: 'Acme' } },
        { id: 'pi_theirs', name: 'Rival LI', identifier: 'linkedin', disabled: false, customer: { id: 'grp_2', name: 'Rival' } },
      ]);

      const res = await http()
        .post('/marketing/accounts/import')
        .set(bearer(ownerToken))
        .expect(201);

      expect(postizStub.listIntegrations).toHaveBeenCalledWith('grp_1');
      expect(res.body.imported).toBe(1);
      expect(res.body.accounts).toHaveLength(1);
      expect(res.body.accounts[0].provider).toBe('instagram');
      accountId = res.body.accounts[0].id;

      const rival = await prisma.socialAccount.findFirst({
        where: { postizIntegrationId: 'pi_theirs' },
      });
      expect(rival).toBeNull();
    });

    it('lets a MEMBER read the workspace but not change it', async () => {
      // Seeing what the AI posted publicly is the point; publishing is not.
      await http().get('/marketing/accounts').set(bearer(memberToken)).expect(200);
      await http().get('/marketing/posts').set(bearer(memberToken)).expect(200);
      await http()
        .post('/marketing/posts')
        .set(bearer(memberToken))
        .send({ socialAccountId: accountId, content: 'from a member' })
        .expect(403);
    });

    it('saves a draft without calling Postiz', async () => {
      const res = await http()
        .post('/marketing/posts')
        .set(bearer(ownerToken))
        .send({ socialAccountId: accountId, content: 'Draft copy' })
        .expect(201);
      expect(res.body.status).toBe('DRAFT');
      expect(res.body.postizPostId).toBeNull();
      expect(postizStub.schedulePost).not.toHaveBeenCalled();
    });

    it('schedules through Postiz and records the provider id', async () => {
      postizStub.schedulePost.mockResolvedValueOnce({ postizPostId: 'pz_1' });
      const res = await http()
        .post('/marketing/posts')
        .set(bearer(ownerToken))
        .send({ socialAccountId: accountId, content: 'Real post', publishAt: future(), schedule: true })
        .expect(201);

      expect(postizStub.schedulePost).toHaveBeenCalledWith(
        expect.objectContaining({ postizIntegrationId: 'pi_mine', type: 'schedule' }),
      );
      expect(res.body.status).toBe('SCHEDULED');
      // Without this the reconciliation sweep skips the row for ever.
      expect(res.body.postizPostId).toBe('pz_1');
    });

    it('never leaves a SCHEDULED row behind when Postiz fails', async () => {
      postizStub.schedulePost.mockRejectedValueOnce(new Error('postiz down'));
      await http()
        .post('/marketing/posts')
        .set(bearer(ownerToken))
        .send({ socialAccountId: accountId, content: 'Doomed', publishAt: future(), schedule: true })
        .expect(500);

      const orphan = await prisma.scheduledPost.findFirst({
        where: { companyId, content: 'Doomed' },
      });
      expect(orphan).toBeNull();
    });

    it('refuses to edit a post Postiz already holds', async () => {
      const scheduled = await prisma.scheduledPost.findFirst({
        where: { companyId, status: 'SCHEDULED' },
      });
      await http()
        .patch(`/marketing/posts/${scheduled?.id}`)
        .set(bearer(ownerToken))
        .send({ content: 'changed my mind' })
        .expect(409);
    });

    it('groups posts under a campaign and keeps them when it is deleted', async () => {
      const campaign = await http()
        .post('/marketing/campaigns')
        .set(bearer(ownerToken))
        .send({ name: 'Autumn launch', goal: 'signups' })
        .expect(201);

      const post = await http()
        .post('/marketing/posts')
        .set(bearer(ownerToken))
        .send({ socialAccountId: accountId, content: 'In a campaign', campaignId: campaign.body.id })
        .expect(201);
      expect(post.body.campaignName).toBe('Autumn launch');

      const del = await http()
        .delete(`/marketing/campaigns/${campaign.body.id}`)
        .set(bearer(ownerToken))
        .expect(200);
      expect(del.body.detachedPosts).toBeGreaterThanOrEqual(1);

      const survivor = await prisma.scheduledPost.findUnique({ where: { id: post.body.id } });
      expect(survivor).not.toBeNull();
      expect(survivor?.campaignId).toBeNull();
    });

    it('never shows another tenant the accounts, posts or campaigns', async () => {
      const accounts = await http().get('/marketing/accounts').set(bearer(otherToken)).expect(200);
      const posts = await http().get('/marketing/posts').set(bearer(otherToken)).expect(200);
      const campaigns = await http().get('/marketing/campaigns').set(bearer(otherToken)).expect(200);
      expect(accounts.body).toEqual([]);
      expect(posts.body).toEqual([]);
      expect(campaigns.body).toEqual([]);

      // And cannot post to an account it does not own.
      await http()
        .post('/marketing/posts')
        .set(bearer(otherToken))
        .send({ socialAccountId: accountId, content: 'not mine' })
        .expect(404);
    });
  });
});
