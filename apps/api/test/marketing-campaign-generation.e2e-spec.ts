import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CampaignGenerationService } from '../src/modules/marketing/generation/campaign-generation.service';

/**
 * The Marketing AI Employee generation pipeline over real HTTP.
 *
 * Runs against the offline mock LLM (`LLM_PROVIDER=mock` in the e2e env), so
 * this exercises the whole chain — brief → plan → calendar → 5–6 options per
 * post → READY_FOR_REVIEW — with no network and no API key.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('Marketing AI campaign generation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let generation: CampaignGenerationService;

  const ts = Date.now();
  const password = 'password123';
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  let ownerToken = '';
  let memberToken = '';
  let companyId = '';
  let otherToken = '';
  let otherCompanyId = '';
  let campaignId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    generation = app.get(CampaignGenerationService);

    const reg = await http()
      .post('/auth/register')
      .send({
        companyName: `Campaign Co ${ts}`,
        name: 'Campaign Owner',
        email: `camp_owner_${ts}@yopmail.com`,
        password,
      })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    companyId = reg.body.user.companyId;

    await http()
      .post('/users')
      .set(bearer(ownerToken))
      .send({ name: 'Camp Member', email: `camp_member_${ts}@yopmail.com`, password, role: 'MEMBER' })
      .expect(201);
    const login = await http()
      .post('/auth/login')
      .send({ email: `camp_member_${ts}@yopmail.com`, password })
      .expect(201);
    memberToken = login.body.tokens.accessToken;

    const other = await http()
      .post('/auth/register')
      .send({
        companyName: `Campaign Other ${ts}`,
        name: 'Other Owner',
        email: `camp_other_${ts}@yopmail.com`,
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

  it('requires authentication', async () => {
    await http().post('/marketing/campaigns/ai').send({ brief: 'anything at all here' }).expect(401);
  });

  it('a MEMBER may not start a campaign', async () => {
    // Generation spends real model budget — marketing:manage, not read.
    await http()
      .post('/marketing/campaigns/ai')
      .set(bearer(memberToken))
      .send({ brief: 'A seven day campaign posting twice a day on LinkedIn.' })
      .expect(403);
  });

  it('rejects a brief too short to plan from', async () => {
    await http()
      .post('/marketing/campaigns/ai')
      .set(bearer(ownerToken))
      .send({ brief: 'hi' })
      .expect(400);
  });

  it('accepts a brief and returns immediately without waiting for generation', async () => {
    // §74 — a 21-post campaign is 21 model calls; the request must not block.
    const started = Date.now();
    const res = await http()
      .post('/marketing/campaigns/ai')
      .set(bearer(ownerToken))
      .send({
        brief: 'Create a 7 day campaign. Post 3 times per day on LinkedIn and Instagram.',
        timezone: 'Asia/Kolkata',
      })
      .expect(201);

    campaignId = res.body.id;
    expect(res.body.generation.status).not.toBe('READY_FOR_REVIEW');
    expect(res.body.brief).toContain('7 day campaign');
    // The customer's explicit timezone survives the AI's own suggestion (§35).
    expect(res.body.timezone).toBe('Asia/Kolkata');
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('generates the plan, the calendar, and 5–6 options for every post', async () => {
    // Drive the pipeline the way a worker tick or the cron sweep would.
    let guard = 0;
    let more = true;
    while (more && guard < 40) {
      const result = await generation.advance(campaignId);
      more = result.more;
      guard += 1;
    }

    const detail = await http()
      .get(`/marketing/campaigns/${campaignId}/detail`)
      .set(bearer(ownerToken))
      .expect(200);

    expect(detail.body.status).toBe('READY_FOR_REVIEW');
    expect(detail.body.generation.inProgress).toBe(false);
    expect(detail.body.generation.error).toBeNull();
    // 7 days x 3 per day.
    expect(detail.body.generation.totalItems).toBe(21);
    expect(detail.body.generation.itemsWithOptions).toBe(21);
    expect(detail.body.platforms).toEqual(
      expect.arrayContaining(['linkedin', 'instagram']),
    );
  }, 120_000);

  it('the calendar omits options, so a 210-variant campaign is not shipped to render it', async () => {
    // §31/§62 progressive disclosure.
    const res = await http()
      .get(`/marketing/campaigns/${campaignId}/content`)
      .set(bearer(ownerToken))
      .expect(200);

    expect(res.body).toHaveLength(21);
    expect(res.body[0].variants).toBeUndefined();
    expect(res.body[0].variantCount).toBeGreaterThanOrEqual(5);
    expect(res.body[0]).toMatchObject({ dayNumber: 1, sequence: 1 });
  });

  it('opening one post returns its 5–6 genuinely distinct options', async () => {
    const list = await http()
      .get(`/marketing/campaigns/${campaignId}/content`)
      .set(bearer(ownerToken))
      .expect(200);

    const res = await http()
      .get(`/marketing/content/${list.body[0].id}`)
      .set(bearer(ownerToken))
      .expect(200);

    const variants = res.body.variants;
    expect(variants.length).toBeGreaterThanOrEqual(5);
    expect(variants.length).toBeLessThanOrEqual(6);

    // Every option is complete (§14).
    for (const v of variants) {
      expect(v.hook).toBeTruthy();
      expect(v.caption).toBeTruthy();
      expect(v.cta).toBeTruthy();
      expect(v.contentAngle).toBeTruthy();
    }
    // And genuinely different (§15) — distinct angles, not rewordings.
    expect(new Set(variants.map((v: { contentAngle: string }) => v.contentAngle)).size).toBe(
      variants.length,
    );

    // Exactly one recommendation, and it is NOT a selection (§32).
    expect(variants.filter((v: { recommended: boolean }) => v.recommended)).toHaveLength(1);
    expect(res.body.selectedVariantId).toBeNull();
  });

  it('selecting an option records the choice WITHOUT approving anything', async () => {
    const list = await http()
      .get(`/marketing/campaigns/${campaignId}/content`)
      .set(bearer(ownerToken))
      .expect(200);
    const item = await http()
      .get(`/marketing/content/${list.body[0].id}`)
      .set(bearer(ownerToken))
      .expect(200);
    const chosen = item.body.variants[2];

    const res = await http()
      .post(`/marketing/content/${list.body[0].id}/select-variant`)
      .set(bearer(ownerToken))
      .send({ variantId: chosen.id })
      .expect(201);

    expect(res.body.selectedVariantId).toBe(chosen.id);
    expect(res.body.variants.find((v: { id: string }) => v.id === chosen.id).status).toBe(
      'SELECTED',
    );
    // Selection is not approval — the post is not APPROVED or SCHEDULED.
    expect(res.body.status).toBe('READY_FOR_REVIEW');
  });

  it('selecting a second option demotes the first, so exactly one stays selected', async () => {
    const list = await http()
      .get(`/marketing/campaigns/${campaignId}/content`)
      .set(bearer(ownerToken))
      .expect(200);
    const item = await http()
      .get(`/marketing/content/${list.body[0].id}`)
      .set(bearer(ownerToken))
      .expect(200);

    const next = item.body.variants.find(
      (v: { id: string }) => v.id !== item.body.selectedVariantId,
    );
    const res = await http()
      .post(`/marketing/content/${list.body[0].id}/select-variant`)
      .set(bearer(ownerToken))
      .send({ variantId: next.id })
      .expect(201);

    const selected = res.body.variants.filter(
      (v: { status: string }) => v.status === 'SELECTED',
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(next.id);
  });

  it('refuses an option belonging to a different content item', async () => {
    const list = await http()
      .get(`/marketing/campaigns/${campaignId}/content`)
      .set(bearer(ownerToken))
      .expect(200);
    const other = await http()
      .get(`/marketing/content/${list.body[1].id}`)
      .set(bearer(ownerToken))
      .expect(200);

    await http()
      .post(`/marketing/content/${list.body[0].id}/select-variant`)
      .set(bearer(ownerToken))
      .send({ variantId: other.body.variants[0].id })
      .expect(404);
  });

  it('never exposes another tenant’s campaign or content', async () => {
    await http()
      .get(`/marketing/campaigns/${campaignId}/detail`)
      .set(bearer(otherToken))
      .expect(404);
    await http()
      .get(`/marketing/campaigns/${campaignId}/content`)
      .set(bearer(otherToken))
      .expect(404);
  });

  it('a MEMBER can read the campaign but cannot select an option', async () => {
    await http()
      .get(`/marketing/campaigns/${campaignId}/detail`)
      .set(bearer(memberToken))
      .expect(200);

    const list = await http()
      .get(`/marketing/campaigns/${campaignId}/content`)
      .set(bearer(memberToken))
      .expect(200);

    await http()
      .post(`/marketing/content/${list.body[0].id}/select-variant`)
      .set(bearer(memberToken))
      .send({ variantId: 'anything' })
      .expect(403);
  });
});
