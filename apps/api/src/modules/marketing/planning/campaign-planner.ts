/**
 * Campaign content-calendar planning — PURE functions, no I/O.
 *
 * Architecture doc §10/§11: the AI produces a strategy (content pillars), and
 * that strategy is turned into a dated calendar of content items BEFORE any
 * content is generated. Keeping this deterministic and side-effect free means
 * the shape of a campaign is testable without a model, a database, or a clock.
 *
 * The LLM decides *what to say*; this file decides *how many items, on which
 * days, at what times, covering which pillars*. Those are different problems,
 * and only the first one benefits from a model.
 */

/**
 * Hard ceiling on a single campaign's content items.
 *
 * §83/§103 require cost controls, and this is where an unbounded request turns
 * into real money: every item fans out to 5–6 variants, each a model call. A
 * year-long campaign at 5 posts/day would be 1,825 items → ~11,000 calls from
 * one API request. 120 items is generous for the spec's own worked example
 * (7 days × 5 = 35) while making that failure mode impossible.
 */
export const MAX_CONTENT_ITEMS = 120;

/** Longest campaign we will plan, so a typo'd end date cannot mean "3 years". */
export const MAX_CAMPAIGN_DAYS = 90;

/**
 * Default posting window in the campaign's OWN timezone.
 *
 * Business hours rather than round-the-clock: a marketing calendar that
 * schedules 03:00 posts is technically valid and practically wrong.
 */
export const POSTING_WINDOW = { startHour: 9, endHour: 18 } as const;

/**
 * Content pillars we know how to vary (§10). An AI-proposed pillar outside this
 * set still works — it just uses the generic rotation, because inventing a
 * plausible-looking type list for an unknown pillar would be guessing.
 */
const PILLAR_CONTENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  EDUCATION: ['Educational', 'How-to', 'Tips'],
  PRODUCT: ['Feature', 'Demo', 'Product'],
  CUSTOMER_PROBLEM: ['Pain Point', 'Myth Buster', 'Use Case'],
  SOCIAL_PROOF: ['Customer Story', 'Testimonial', 'Case Study'],
  ENGAGEMENT: ['Question', 'Poll', 'Prompt'],
  PROMOTION: ['Offer', 'Announcement', 'Launch'],
};

const GENERIC_CONTENT_TYPES: readonly string[] = ['Educational', 'Product', 'Engagement'];

/** Fallback pillars when the strategy step produced none (§10). */
export const DEFAULT_CONTENT_PILLARS: readonly string[] = [
  'Education',
  'Product',
  'Customer Problem',
  'Social Proof',
  'Engagement',
  'Promotion',
];

export interface CampaignPlanInput {
  /** First day of the campaign, as an instant. */
  startDate: Date;
  /** Last day INCLUSIVE — a one-day campaign has startDate === endDate. */
  endDate: Date;
  postsPerDay: number;
  contentPillars: readonly string[];
  /** IANA zone, e.g. "Asia/Kolkata". §35: never the server's zone. */
  timezone: string;
}

export interface PlannedContentItem {
  /** 1-based day within the campaign. */
  dayNumber: number;
  /** 1-based ordinal within that day. */
  sequence: number;
  objective: string;
  contentType: string;
  /** UTC instant. The wall-clock time it represents is in `timezone`. */
  scheduledAt: Date;
}

export class CampaignPlanError extends Error {}

/** Normalise a pillar label to a `PILLAR_CONTENT_TYPES` key. */
function pillarKey(pillar: string): string {
  return pillar.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * Convert a wall-clock time in an IANA zone to the UTC instant it refers to.
 *
 * There is no dependency for this and none is added — the codebase already
 * prefers built-ins over a date library (see the workflow schedule codec, which
 * refuses to add a cron parser). `Intl.DateTimeFormat` knows every zone's rules
 * including DST, so the job is inverting it: guess an instant, ask what
 * wall-clock the zone shows for it, and correct by the difference.
 *
 * Two passes, not one: a single correction can land on the far side of a DST
 * transition, where the offset differs from the one just measured. The second
 * pass settles it. A wall-clock time that does not exist (the skipped hour of a
 * spring-forward) resolves to the instant just after the jump, which is the
 * least surprising answer for scheduling.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let instant = target;
  for (let pass = 0; pass < 2; pass += 1) {
    // Compare what the zone SHOWS against the wall clock we WANT — not against
    // the current guess. Measuring drift from the guess makes the second pass
    // undo the first and lands an extra offset out.
    const drift = wallClockInZone(new Date(instant), timeZone) - target;
    if (drift === 0) break;
    instant -= drift;
  }
  return new Date(instant);
}

/**
 * What wall-clock does `zone` show for this instant, expressed as a UTC-based
 * timestamp of those same numbers? (i.e. 14:00 in Tokyo → Date.UTC(...14:00).)
 */
function wallClockInZone(instant: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
  } catch {
    throw new CampaignPlanError(
      `Unknown timezone "${timeZone}". Use an IANA name such as "Asia/Kolkata".`,
    );
  }

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((p) => p.type === type)?.value ?? '0';
    return Number(raw);
  };
  // `hour12: false` renders midnight as 24 in some ICU versions.
  const hour = get('hour') % 24;
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
}

/** Whole days from start to end INCLUSIVE, counted in the campaign's zone. */
export function countCampaignDays(startDate: Date, endDate: Date, timeZone: string): number {
  const start = wallClockInZone(startDate, timeZone);
  const end = wallClockInZone(endDate, timeZone);
  const startDay = Math.floor(start / 86_400_000);
  const endDay = Math.floor(end / 86_400_000);
  return endDay - startDay + 1;
}

/**
 * Posting times for `count` slots inside the day's window, in local hours.
 *
 * One post lands mid-window rather than at 09:00 — a single daily post is a
 * "when is my audience awake" decision, not "as early as possible". Multiple
 * posts spread evenly across the window.
 */
export function postingTimesFor(count: number): Array<{ hour: number; minute: number }> {
  const { startHour, endHour } = POSTING_WINDOW;
  if (count <= 0) return [];
  if (count === 1) {
    const mid = (startHour + endHour) / 2;
    return [{ hour: Math.floor(mid), minute: mid % 1 === 0 ? 0 : 30 }];
  }
  const spanMinutes = (endHour - startHour) * 60;
  const step = spanMinutes / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const minutesFromStart = Math.round(i * step);
    const total = startHour * 60 + minutesFromStart;
    return { hour: Math.floor(total / 60), minute: total % 60 };
  });
}

/**
 * Build the calendar (§11).
 *
 * Pillars rotate across the WHOLE campaign rather than restarting each day, so
 * a 2-posts/day week cycles through all six pillars instead of hammering the
 * first two every morning — that is the "distribute content types rather than
 * repeating the same format" requirement in §10. Content types rotate
 * independently within a pillar so the third Education post is not the third
 * identical "Educational" slot.
 */
export function planContentCalendar(input: CampaignPlanInput): PlannedContentItem[] {
  const { startDate, endDate, postsPerDay, timezone } = input;

  if (!Number.isInteger(postsPerDay) || postsPerDay < 1) {
    throw new CampaignPlanError('postsPerDay must be a whole number of at least 1.');
  }
  if (endDate.getTime() < startDate.getTime()) {
    throw new CampaignPlanError('The campaign end date is before its start date.');
  }

  const days = countCampaignDays(startDate, endDate, timezone);
  if (days > MAX_CAMPAIGN_DAYS) {
    throw new CampaignPlanError(
      `A campaign can span at most ${MAX_CAMPAIGN_DAYS} days; this one spans ${days}.`,
    );
  }

  const total = days * postsPerDay;
  if (total > MAX_CONTENT_ITEMS) {
    throw new CampaignPlanError(
      `That plan is ${total} posts (${days} days x ${postsPerDay}/day), over the ` +
        `${MAX_CONTENT_ITEMS} limit. Shorten the campaign or reduce posts per day.`,
    );
  }

  const pillars = input.contentPillars.length > 0
    ? input.contentPillars
    : DEFAULT_CONTENT_PILLARS;

  const times = postingTimesFor(postsPerDay);
  // Per-pillar counters, so each pillar walks its own type list.
  const pillarUse = new Map<string, number>();
  const items: PlannedContentItem[] = [];

  // The campaign's first day in its own zone — every later day is derived from
  // this calendar date, NOT by adding 24h to an instant (which drifts across a
  // DST boundary).
  const firstDayWall = new Date(wallClockInZone(startDate, timezone));

  let slot = 0;
  for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
    // Advance the calendar DATE, then resolve that date's wall-clock back to an
    // instant. Date.UTC normalises month/year rollover for us.
    const dayDate = new Date(
      Date.UTC(
        firstDayWall.getUTCFullYear(),
        firstDayWall.getUTCMonth(),
        firstDayWall.getUTCDate() + dayIndex,
      ),
    );

    for (let seq = 0; seq < postsPerDay; seq += 1) {
      const pillar = pillars[slot % pillars.length];
      const key = pillarKey(pillar);
      const used = pillarUse.get(key) ?? 0;
      pillarUse.set(key, used + 1);

      const types = PILLAR_CONTENT_TYPES[key] ?? GENERIC_CONTENT_TYPES;
      const { hour, minute } = times[seq];

      items.push({
        dayNumber: dayIndex + 1,
        sequence: seq + 1,
        objective: pillar,
        contentType: types[used % types.length],
        scheduledAt: zonedWallClockToUtc(
          dayDate.getUTCFullYear(),
          dayDate.getUTCMonth() + 1,
          dayDate.getUTCDate(),
          hour,
          minute,
          timezone,
        ),
      });
      slot += 1;
    }
  }

  return items;
}
