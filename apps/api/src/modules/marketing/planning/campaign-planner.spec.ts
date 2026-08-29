import {
  CampaignPlanError,
  DEFAULT_CONTENT_PILLARS,
  MAX_CONTENT_ITEMS,
  countCampaignDays,
  planContentCalendar,
  postingTimesFor,
  zonedWallClockToUtc,
} from './campaign-planner';

/**
 * The calendar is the one part of the Marketing AI pipeline that must be exactly
 * right without a model in the loop: it decides how many expensive generation
 * calls happen, and when real posts hit real feeds.
 *
 * The timezone cases are not decoration. §35 says never depend on the server's
 * zone, and this repo has no date library — so the Intl-based conversion is
 * hand-rolled and has to be proven against DST, half-hour offsets, and
 * month/year rollover.
 */
describe('campaign-planner', () => {
  describe('zonedWallClockToUtc', () => {
    it('converts a wall clock in a whole-hour zone', () => {
      // 09:00 in New York on 15 Jan (EST, UTC-5) === 14:00 UTC
      const utc = zonedWallClockToUtc(2026, 1, 15, 9, 0, 'America/New_York');
      expect(utc.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    });

    it('handles a half-hour offset zone', () => {
      // India is UTC+5:30 year-round — a whole-hour assumption breaks here.
      const utc = zonedWallClockToUtc(2026, 6, 10, 9, 30, 'Asia/Kolkata');
      expect(utc.toISOString()).toBe('2026-06-10T04:00:00.000Z');
    });

    it('respects DST — the SAME wall clock is a different instant in summer', () => {
      // 09:00 New York: UTC-5 in January, UTC-4 in July. A naive fixed-offset
      // implementation gets one of these wrong.
      const winter = zonedWallClockToUtc(2026, 1, 15, 9, 0, 'America/New_York');
      const summer = zonedWallClockToUtc(2026, 7, 15, 9, 0, 'America/New_York');
      expect(winter.toISOString()).toBe('2026-01-15T14:00:00.000Z');
      expect(summer.toISOString()).toBe('2026-07-15T13:00:00.000Z');
    });

    it('rejects an unknown timezone rather than silently using the server’s', () => {
      expect(() => zonedWallClockToUtc(2026, 1, 1, 9, 0, 'Mars/Olympus')).toThrow(
        CampaignPlanError,
      );
    });
  });

  describe('countCampaignDays', () => {
    it('counts inclusively — a same-day campaign is one day', () => {
      const d = new Date('2026-03-02T12:00:00Z');
      expect(countCampaignDays(d, d, 'UTC')).toBe(1);
    });

    it('counts a week as 7, not 6', () => {
      expect(
        countCampaignDays(
          new Date('2026-03-02T00:00:00Z'),
          new Date('2026-03-08T00:00:00Z'),
          'UTC',
        ),
      ).toBe(7);
    });
  });

  describe('postingTimesFor', () => {
    it('puts a single daily post mid-window, not at opening time', () => {
      // One post a day is a "when is the audience awake" decision.
      expect(postingTimesFor(1)).toEqual([{ hour: 13, minute: 30 }]);
    });

    it('spreads multiple posts across the window, first and last at the edges', () => {
      const times = postingTimesFor(3);
      expect(times[0]).toEqual({ hour: 9, minute: 0 });
      expect(times[2]).toEqual({ hour: 18, minute: 0 });
      expect(times).toHaveLength(3);
    });

    it('keeps every slot inside business hours', () => {
      for (const count of [2, 4, 5]) {
        for (const t of postingTimesFor(count)) {
          expect(t.hour).toBeGreaterThanOrEqual(9);
          expect(t.hour).toBeLessThanOrEqual(18);
        }
      }
    });
  });

  describe('planContentCalendar', () => {
    const base = {
      startDate: new Date('2026-03-02T00:00:00Z'),
      endDate: new Date('2026-03-08T00:00:00Z'),
      contentPillars: DEFAULT_CONTENT_PILLARS,
      timezone: 'UTC',
    };

    it('produces days x postsPerDay items — the spec’s 7x3 = 21', () => {
      const items = planContentCalendar({ ...base, postsPerDay: 3 });
      expect(items).toHaveLength(21);
      expect(items[0]).toMatchObject({ dayNumber: 1, sequence: 1 });
      expect(items.at(-1)).toMatchObject({ dayNumber: 7, sequence: 3 });
    });

    it('rotates pillars ACROSS the campaign, not restarting each day', () => {
      // The §10 requirement. With 2/day and 6 pillars, restarting daily would
      // use only the first two pillars all week.
      const items = planContentCalendar({ ...base, postsPerDay: 2 });
      const used = new Set(items.map((i) => i.objective));
      expect(used.size).toBe(6);
    });

    it('varies the content type within a repeated pillar', () => {
      // The third "Education" slot must not be the third identical
      // "Educational" post.
      const items = planContentCalendar({
        ...base,
        postsPerDay: 1,
        contentPillars: ['Education'],
      });
      const types = new Set(items.map((i) => i.contentType));
      expect(types.size).toBeGreaterThan(1);
    });

    it('schedules against the campaign timezone, not the server', () => {
      const items = planContentCalendar({
        ...base,
        postsPerDay: 1,
        timezone: 'Asia/Kolkata',
      });
      // 13:30 IST === 08:00 UTC.
      expect(items[0].scheduledAt.toISOString()).toBe('2026-03-02T08:00:00.000Z');
    });

    it('keeps a constant local time across a DST change', () => {
      // US DST starts 8 Mar 2026. Naively adding 24h to an instant would drift
      // the local time by an hour partway through the campaign.
      const items = planContentCalendar({
        startDate: new Date('2026-03-05T12:00:00Z'),
        endDate: new Date('2026-03-11T12:00:00Z'),
        postsPerDay: 1,
        contentPillars: DEFAULT_CONTENT_PILLARS,
        timezone: 'America/New_York',
      });
      const localHours = items.map((i) =>
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          hour12: false,
        }).format(i.scheduledAt),
      );
      expect(new Set(localHours).size).toBe(1);
    });

    it('handles month rollover', () => {
      const items = planContentCalendar({
        startDate: new Date('2026-01-30T00:00:00Z'),
        endDate: new Date('2026-02-02T00:00:00Z'),
        postsPerDay: 1,
        contentPillars: DEFAULT_CONTENT_PILLARS,
        timezone: 'UTC',
      });
      expect(items).toHaveLength(4);
      expect(items.at(-1)?.scheduledAt.toISOString().slice(0, 10)).toBe('2026-02-02');
    });

    it('refuses a plan that would exceed the generation budget', () => {
      // §83/§103: every item fans out to 5-6 model calls, so an unbounded
      // request is a cost incident, not just a big number.
      expect(() =>
        planContentCalendar({
          startDate: new Date('2026-01-01T00:00:00Z'),
          endDate: new Date('2026-03-01T00:00:00Z'),
          postsPerDay: 5,
          contentPillars: DEFAULT_CONTENT_PILLARS,
          timezone: 'UTC',
        }),
      ).toThrow(new RegExp(String(MAX_CONTENT_ITEMS)));
    });

    it('rejects an end date before the start date', () => {
      expect(() =>
        planContentCalendar({
          ...base,
          startDate: new Date('2026-03-08T00:00:00Z'),
          endDate: new Date('2026-03-02T00:00:00Z'),
          postsPerDay: 1,
        }),
      ).toThrow(CampaignPlanError);
    });

    it('rejects a non-positive posts-per-day', () => {
      expect(() => planContentCalendar({ ...base, postsPerDay: 0 })).toThrow(
        CampaignPlanError,
      );
    });

    it('falls back to the default pillars when the strategy produced none', () => {
      const items = planContentCalendar({ ...base, postsPerDay: 1, contentPillars: [] });
      expect(items.every((i) => i.objective.length > 0)).toBe(true);
    });
  });
});
