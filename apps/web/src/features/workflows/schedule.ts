import type { TriggerConfig } from '@vaep/types';

/**
 * FRIENDLY SCHEDULES (UX plan §18, §19).
 *
 * A business operator picks "Every Monday at 9am". The backend stores a cron
 * expression (or a repeat interval). This module is the codec between the two,
 * plus a next-run calculation for the "Next run" line.
 *
 * ── Why no cron library ──────────────────────────────────────────────────────
 * `nextRunAt` only handles the shapes `toTriggerConfig` itself emits. Anything
 * else — an expression an advanced user typed by hand — returns `null` and the
 * UI shows the raw expression instead of a predicted time. That is deliberate:
 * a wrong "Next run: Monday 9am" is worse than no prediction, and pulling in a
 * full cron parser to be confidently wrong about DST edge cases is not a trade
 * worth making for a hint line.
 *
 * ── Timezone honesty ─────────────────────────────────────────────────────────
 * The scheduler evaluates cron in the SERVER's timezone; there is no per-workflow
 * timezone column. So `timezone` here is used to *display* the resulting instant
 * in the company's zone, and the UI states which zone the schedule is written
 * in. We do not pretend each workflow carries its own zone.
 */

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type ScheduleFrequency =
  | 'HOURLY'
  | 'DAILY'
  | 'WEEKDAYS'
  | 'WEEKLY'
  | 'MONTHLY'
  | 'INTERVAL'
  | 'CUSTOM';

export type FriendlySchedule =
  | { frequency: 'HOURLY'; minute: number }
  | { frequency: 'DAILY'; hour: number; minute: number }
  | { frequency: 'WEEKDAYS'; hour: number; minute: number }
  | { frequency: 'WEEKLY'; weekday: number; hour: number; minute: number }
  | { frequency: 'MONTHLY'; day: number; hour: number; minute: number }
  | { frequency: 'INTERVAL'; everyMs: number }
  | { frequency: 'CUSTOM'; cron: string };

/** BullMQ refuses a repeat interval below this, and so do we. */
export const MIN_INTERVAL_MS = 15_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** "09:00" for an hour/minute pair. */
export function formatTime(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

// ── Encode ───────────────────────────────────────────────────────────────────

export function toTriggerConfig(schedule: FriendlySchedule): TriggerConfig {
  switch (schedule.frequency) {
    case 'HOURLY':
      return { cron: `${schedule.minute} * * * *` };
    case 'DAILY':
      return { cron: `${schedule.minute} ${schedule.hour} * * *` };
    case 'WEEKDAYS':
      return { cron: `${schedule.minute} ${schedule.hour} * * 1-5` };
    case 'WEEKLY':
      return { cron: `${schedule.minute} ${schedule.hour} * * ${schedule.weekday}` };
    case 'MONTHLY':
      return { cron: `${schedule.minute} ${schedule.hour} ${schedule.day} * *` };
    case 'INTERVAL':
      return { everyMs: Math.max(MIN_INTERVAL_MS, schedule.everyMs) };
    case 'CUSTOM':
      return { cron: schedule.cron };
  }
}

// ── Decode ───────────────────────────────────────────────────────────────────

/**
 * Read a stored trigger config back into the friendly form. Returns `null` when
 * nothing has been configured yet, and `CUSTOM` for any cron shape this module
 * did not write.
 */
export function fromTriggerConfig(
  config: TriggerConfig | null | undefined,
): FriendlySchedule | null {
  if (!config) return null;

  if (typeof config.cron === 'string' && config.cron.trim() !== '') {
    return parseCron(config.cron.trim());
  }
  const everyMs = Number(config.everyMs);
  if (Number.isFinite(everyMs) && everyMs > 0) {
    return { frequency: 'INTERVAL', everyMs };
  }
  return null;
}

function parseCron(cron: string): FriendlySchedule {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return { frequency: 'CUSTOM', cron };

  const [min, hr, dom, month, dow] = parts;
  const minute = Number(min);
  const hour = Number(hr);
  const isNum = (v: string) => /^\d+$/.test(v);

  if (month !== '*') return { frequency: 'CUSTOM', cron };

  // Hourly: "M * * * *"
  if (isNum(min) && hr === '*' && dom === '*' && dow === '*') {
    return { frequency: 'HOURLY', minute };
  }
  if (!isNum(min) || !isNum(hr)) return { frequency: 'CUSTOM', cron };

  // Monthly: "M H D * *"
  if (isNum(dom) && dow === '*') {
    return { frequency: 'MONTHLY', day: Number(dom), hour, minute };
  }
  if (dom !== '*') return { frequency: 'CUSTOM', cron };

  // Daily: "M H * * *"
  if (dow === '*') return { frequency: 'DAILY', hour, minute };
  // Weekdays: "M H * * 1-5"
  if (dow === '1-5') return { frequency: 'WEEKDAYS', hour, minute };
  // Weekly: "M H * * D"
  if (isNum(dow) && Number(dow) <= 6) {
    return { frequency: 'WEEKLY', weekday: Number(dow), hour, minute };
  }
  return { frequency: 'CUSTOM', cron };
}

// ── Describe ─────────────────────────────────────────────────────────────────

/** A one-line human summary, e.g. "Every Monday · 09:00". */
export function describeSchedule(
  config: TriggerConfig | null | undefined,
): string {
  const schedule = fromTriggerConfig(config);
  if (!schedule) return 'Not set yet';

  switch (schedule.frequency) {
    case 'HOURLY':
      return `Every hour at ${pad(schedule.minute)} past`;
    case 'DAILY':
      return `Every day · ${formatTime(schedule.hour, schedule.minute)}`;
    case 'WEEKDAYS':
      return `Every weekday · ${formatTime(schedule.hour, schedule.minute)}`;
    case 'WEEKLY':
      return `Every ${WEEKDAY_NAMES[schedule.weekday]} · ${formatTime(schedule.hour, schedule.minute)}`;
    case 'MONTHLY':
      return `Day ${schedule.day} of every month · ${formatTime(schedule.hour, schedule.minute)}`;
    case 'INTERVAL':
      return `Every ${describeInterval(schedule.everyMs)}`;
    case 'CUSTOM':
      return `Custom schedule (${schedule.cron})`;
  }
}

export function describeInterval(everyMs: number): string {
  const minutes = Math.round(everyMs / 60_000);
  if (minutes < 1) return `${Math.round(everyMs / 1000)} seconds`;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// ── Next run ─────────────────────────────────────────────────────────────────

/**
 * The next instant this schedule fires, or `null` when we cannot say (a custom
 * cron expression, or nothing configured).
 *
 * `from` is the reference instant. Times are interpreted in `timeZone` — the
 * zone the caller states the schedule is written in — so the returned Date is a
 * real instant the caller can render however it likes.
 */
export function nextRunAt(
  config: TriggerConfig | null | undefined,
  from: Date,
  timeZone = 'UTC',
): Date | null {
  const schedule = fromTriggerConfig(config);
  if (!schedule) return null;

  if (schedule.frequency === 'INTERVAL') {
    return new Date(from.getTime() + schedule.everyMs);
  }
  if (schedule.frequency === 'CUSTOM') {
    return null;
  }

  // Walk forward one candidate at a time. A schedule fires at most once a day
  // (except HOURLY), so scanning 60 days is plenty and stays exact through DST
  // without any date arithmetic of our own.
  if (schedule.frequency === 'HOURLY') {
    for (let i = 0; i <= 48; i += 1) {
      const candidate = new Date(from.getTime() + i * 3_600_000);
      const parts = zonedParts(candidate, timeZone);
      const at = instantFor(
        { ...parts, hour: parts.hour, minute: schedule.minute },
        timeZone,
      );
      if (at.getTime() > from.getTime()) return at;
    }
    return null;
  }

  for (let dayOffset = 0; dayOffset <= 62; dayOffset += 1) {
    const probe = new Date(from.getTime() + dayOffset * 86_400_000);
    const parts = zonedParts(probe, timeZone);

    if (schedule.frequency === 'WEEKDAYS' && (parts.weekday === 0 || parts.weekday === 6)) {
      continue;
    }
    if (schedule.frequency === 'WEEKLY' && parts.weekday !== schedule.weekday) {
      continue;
    }
    if (schedule.frequency === 'MONTHLY' && parts.day !== schedule.day) {
      continue;
    }

    const at = instantFor(
      { ...parts, hour: schedule.hour, minute: schedule.minute },
      timeZone,
    );
    if (at.getTime() > from.getTime()) return at;
  }
  return null;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/** Break an instant into calendar fields as seen in `timeZone`. */
function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.weekday,
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // "24" is how Intl reports midnight with hour12:false in some engines.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdayIndex,
  };
}

/**
 * The instant at which `timeZone` shows these calendar fields. Solved by
 * measuring the zone's offset at an approximate instant and correcting — two
 * passes converge even across a DST boundary.
 */
function instantFor(parts: ZonedParts, timeZone: string): Date {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0,
  );
  let guess = asUtc;
  for (let i = 0; i < 2; i += 1) {
    const seen = zonedParts(new Date(guess), timeZone);
    const seenAsUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      0,
      0,
    );
    guess += asUtc - seenAsUtc;
  }
  return new Date(guess);
}
