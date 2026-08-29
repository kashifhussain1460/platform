import { CampaignStatus, ContentItemStatus } from '@prisma/client';
import { CampaignGenerationService, ITEMS_PER_PASS } from './campaign-generation.service';
import { MockLlmProvider } from '../../employees/llm/mock-llm.provider';

/**
 * The generation state machine, driven end to end against the offline mock
 * provider — no network, no API key.
 *
 * The property that matters most here is INCREMENTAL progress. A 21-item
 * campaign is 21 model calls and the serverless function ceiling is 300s, so
 * generation must advance a bounded amount per call and be resumable. A version
 * that did everything in one pass would work in this test and time out in
 * production.
 */
describe('CampaignGenerationService', () => {
  const COMPANY = 'co_1';
  const CAMPAIGN = 'camp_1';

  /**
   * A small in-memory stand-in for the tables this service touches. Real Prisma
   * behaviour that the logic depends on is modelled deliberately: `updateMany`
   * returns a count (that is how the concurrency guards work), and it only
   * matches rows whose current status equals the guard.
   */
  function buildPrisma(overrides: Record<string, unknown> = {}) {
    const campaign: Record<string, unknown> = {
      id: CAMPAIGN,
      companyId: COMPANY,
      status: CampaignStatus.ANALYZING,
      brief: 'Create a 7 day campaign. Post 3 times per day on LinkedIn and Instagram.',
      timezone: 'UTC',
      name: 'Draft',
      objective: null,
      platforms: [],
      contentPillars: [],
      startDate: null,
      endDate: null,
      postsPerDayMax: null,
      currentVersion: 1,
      ...overrides,
    };
    const items: Array<Record<string, unknown>> = [];
    const variants: Array<Record<string, unknown>> = [];

    // Annotated because `$transaction` hands `prisma` back to itself, which
    // makes the inferred type circular.
    const prisma: Record<string, any> = {
      campaign: {
        findUnique: jest.fn(async () => campaign),
        findMany: jest.fn(async () => [{ id: CAMPAIGN }]),
        update: jest.fn(async ({ data }: never) => Object.assign(campaign, data)),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.status && campaign.status !== where.status) return { count: 0 };
          Object.assign(campaign, data);
          return { count: 1 };
        }),
      },
      contentItem: {
        findMany: jest.fn(async ({ where, take }: any) => {
          const matched = items.filter(
            (i) => i.campaignId === where.campaignId && i.status === where.status,
          );
          return matched.slice(0, take ?? matched.length);
        }),
        count: jest.fn(
          async ({ where }: any) =>
            items.filter((i) => i.campaignId === where.campaignId && i.status === where.status)
              .length,
        ),
        createMany: jest.fn(async ({ data }: any) => {
          data.forEach((row: Record<string, unknown>, n: number) =>
            items.push({ ...row, id: `item_${items.length + n}`, currentVersion: 1 }),
          );
          return { count: data.length };
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = items.find((i) => i.id === where.id && i.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      creativeVariant: {
        findMany: jest.fn(async () => variants.map((v) => ({ contentAngle: v.contentAngle }))),
        createMany: jest.fn(async ({ data }: any) => {
          variants.push(...data);
          return { count: data.length };
        }),
      },
      company: {
        findUniqueOrThrow: jest.fn(async () => ({
          name: 'Acme Inc',
          industry: 'SaaS',
          description: 'Workflow tooling for operations teams',
          website: 'https://acme.test',
          businessGoals: ['Grow inbound'],
        })),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    return { prisma, campaign, items, variants };
  }

  function build(overrides: Record<string, unknown> = {}) {
    const ctx = buildPrisma(overrides);
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new CampaignGenerationService(
      ctx.prisma as never,
      new MockLlmProvider(),
      audit as never,
    );
    return { ...ctx, audit, service };
  }

  it('ANALYZING reads the brief into a structured plan', async () => {
    const { service, campaign } = build();
    const result = await service.advance(CAMPAIGN);

    expect(result.status).toBe(CampaignStatus.PLANNING);
    expect(result.more).toBe(true);
    expect(campaign.postsPerDayMax).toBe(3);
    expect(campaign.platforms).toEqual(['linkedin', 'instagram']);
    expect(campaign.startDate).toBeInstanceOf(Date);
  });

  it('keeps a timezone the customer chose, over the model’s suggestion', async () => {
    // Silently relocating someone's posting schedule would be a bad surprise.
    const { service, campaign } = build({ timezone: 'Asia/Kolkata' });
    await service.advance(CAMPAIGN);
    expect(campaign.timezone).toBe('Asia/Kolkata');
  });

  it('PLANNING builds the full calendar — 7 days x 3/day = 21 items', async () => {
    const { service, items } = build();
    await service.advance(CAMPAIGN); // ANALYZING -> PLANNING
    const result = await service.advance(CAMPAIGN); // PLANNING -> GENERATING

    expect(result.status).toBe(CampaignStatus.GENERATING);
    expect(items).toHaveLength(21);
    expect(items[0]).toMatchObject({ dayNumber: 1, sequence: 1 });
  });

  it('GENERATING advances a BOUNDED number of items per pass', async () => {
    // The property that keeps this inside a serverless time limit.
    const { service, variants } = build();
    await service.advance(CAMPAIGN);
    await service.advance(CAMPAIGN);

    const result = await service.advance(CAMPAIGN);

    expect(result.status).toBe(CampaignStatus.GENERATING);
    expect(result.more).toBe(true);
    expect(variants.length).toBe(ITEMS_PER_PASS * 6);
    expect(result.detail).toContain('remaining');
  });

  it('reaches READY_FOR_REVIEW only once every item has options', async () => {
    const { service, items, variants, campaign } = build();

    // Drive to completion the way a worker or cron tick would.
    let guard = 0;
    let more = true;
    while (more && guard < 50) {
      const r = await service.advance(CAMPAIGN);
      more = r.more;
      guard += 1;
    }

    expect(campaign.status).toBe(CampaignStatus.READY_FOR_REVIEW);
    expect(items).toHaveLength(21);
    expect(items.every((i) => i.status === ContentItemStatus.READY_FOR_REVIEW)).toBe(true);
    // §13 — every content item carries 5-6 real options.
    expect(variants.length).toBe(21 * 6);
  });

  it('marks exactly one variant per item as recommended, and it is not an approval', async () => {
    const { service, variants } = build();
    await service.advance(CAMPAIGN);
    await service.advance(CAMPAIGN);
    await service.advance(CAMPAIGN);

    const perItem = new Map<string, number>();
    for (const v of variants) {
      if (v.recommended) {
        perItem.set(v.contentItemId as string, (perItem.get(v.contentItemId as string) ?? 0) + 1);
      }
    }
    expect([...perItem.values()].every((n) => n === 1)).toBe(true);
    // A recommendation never sets a selection or an approval (§32).
    expect(variants.every((v) => v.status === 'READY')).toBe(true);
  });

  it('records the reason on the campaign when generation fails', async () => {
    // "It stopped and nobody said why" is the failure this codebase treats as a
    // defect in its own right.
    const { service, prisma, campaign, audit } = build();
    prisma.company.findUniqueOrThrow.mockRejectedValueOnce(new Error('brand lookup exploded'));

    await expect(service.advance(CAMPAIGN)).rejects.toThrow('brand lookup exploded');

    expect(campaign.status).toBe(CampaignStatus.FAILED);
    expect(campaign.generationError).toContain('brand lookup exploded');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'marketing.campaign.generation_failed' }),
    );
  });

  it('does nothing for a campaign in a terminal state', async () => {
    const { service } = build({ status: CampaignStatus.READY_FOR_REVIEW });
    const result = await service.advance(CAMPAIGN);
    expect(result.more).toBe(false);
    expect(result.detail).toContain('Nothing to do');
  });

  it('a concurrent pass that loses the status race does not duplicate work', async () => {
    // Both callers see ANALYZING; the guarded updateMany means only one claims.
    const { service, prisma, campaign } = build();
    prisma.campaign.updateMany.mockImplementationOnce(async () => ({ count: 0 }));

    const result = await service.advance(CAMPAIGN);

    expect(result.detail).toContain('Already claimed');
    expect(campaign.status).toBe(CampaignStatus.ANALYZING);
  });

  it('sweep survives one campaign failing and keeps going', async () => {
    const { service, prisma } = build();
    prisma.campaign.findMany.mockResolvedValueOnce([{ id: 'bad' }, { id: CAMPAIGN }]);
    prisma.campaign.findUnique.mockResolvedValueOnce(null); // 'bad' does not exist

    const result = await service.sweep();

    // One failed, one advanced — a bad tenant must not stall every other one.
    expect(result.advanced).toBe(1);
  });
});
