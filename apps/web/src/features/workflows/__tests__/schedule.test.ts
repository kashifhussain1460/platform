import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  fromTriggerConfig,
  nextRunAt,
  toTriggerConfig,
} from '../schedule';

describe('schedule codec', () => {
  it('round-trips every friendly frequency', () => {
    const cases = [
      { frequency: 'HOURLY', minute: 15 },
      { frequency: 'DAILY', hour: 9, minute: 0 },
      { frequency: 'WEEKDAYS', hour: 10, minute: 30 },
      { frequency: 'WEEKLY', weekday: 1, hour: 9, minute: 0 },
      { frequency: 'MONTHLY', day: 1, hour: 8, minute: 5 },
      { frequency: 'INTERVAL', everyMs: 900_000 },
    ] as const;

    for (const schedule of cases) {
      expect(fromTriggerConfig(toTriggerConfig(schedule))).toEqual(schedule);
    }
  });

  it('writes the cron expressions the backend expects', () => {
    expect(toTriggerConfig({ frequency: 'WEEKLY', weekday: 1, hour: 9, minute: 0 }))
      .toEqual({ cron: '0 9 * * 1' });
    expect(toTriggerConfig({ frequency: 'WEEKDAYS', hour: 10, minute: 0 }))
      .toEqual({ cron: '0 10 * * 1-5' });
  });

  it('never writes an interval below the scheduler minimum', () => {
    expect(toTriggerConfig({ frequency: 'INTERVAL', everyMs: 1_000 })).toEqual({
      everyMs: 15_000,
    });
  });

  it('falls back to CUSTOM for a cron it did not write', () => {
    expect(fromTriggerConfig({ cron: '*/7 3 2 4 5' })).toEqual({
      frequency: 'CUSTOM',
      cron: '*/7 3 2 4 5',
    });
  });

  it('returns null when nothing is configured', () => {
    expect(fromTriggerConfig(null)).toBeNull();
    expect(fromTriggerConfig({})).toBeNull();
  });
});

describe('describeSchedule', () => {
  it('describes each frequency in plain language', () => {
    expect(describeSchedule({ cron: '0 9 * * 1' })).toBe('Every Monday · 09:00');
    expect(describeSchedule({ cron: '0 10 * * 1-5' })).toBe('Every weekday · 10:00');
    expect(describeSchedule({ cron: '30 6 * * *' })).toBe('Every day · 06:30');
    expect(describeSchedule({ cron: '0 8 1 * *' })).toBe(
      'Day 1 of every month · 08:00',
    );
    expect(describeSchedule({ everyMs: 3_600_000 })).toBe('Every 1 hour');
    expect(describeSchedule(null)).toBe('Not set yet');
  });
});

describe('nextRunAt', () => {
  it('picks tomorrow when today’s time has passed', () => {
    const next = nextRunAt(
      { cron: '0 9 * * *' },
      new Date('2026-08-14T10:00:00Z'),
      'UTC',
    );
    expect(next?.toISOString()).toBe('2026-08-15T09:00:00.000Z');
  });

  it('picks today when the time is still ahead', () => {
    const next = nextRunAt(
      { cron: '0 9 * * *' },
      new Date('2026-08-14T06:00:00Z'),
      'UTC',
    );
    expect(next?.toISOString()).toBe('2026-08-14T09:00:00.000Z');
  });

  it('finds the next Monday for a weekly schedule', () => {
    // 2026-08-14 is a Friday.
    const next = nextRunAt(
      { cron: '0 9 * * 1' },
      new Date('2026-08-14T12:00:00Z'),
      'UTC',
    );
    expect(next?.toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  it('skips the weekend for a weekdays schedule', () => {
    const next = nextRunAt(
      { cron: '0 9 * * 1-5' },
      new Date('2026-08-15T12:00:00Z'), // Saturday
      'UTC',
    );
    expect(next?.toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  it('resolves the wall-clock time in the requested zone', () => {
    // 09:00 in Asia/Kolkata (UTC+5:30) is 03:30 UTC.
    const next = nextRunAt(
      { cron: '0 9 * * *' },
      new Date('2026-08-14T00:00:00Z'),
      'Asia/Kolkata',
    );
    expect(next?.toISOString()).toBe('2026-08-14T03:30:00.000Z');
  });

  it('adds the interval for an interval schedule', () => {
    const next = nextRunAt(
      { everyMs: 900_000 },
      new Date('2026-08-14T10:00:00Z'),
      'UTC',
    );
    expect(next?.toISOString()).toBe('2026-08-14T10:15:00.000Z');
  });

  it('refuses to guess for a cron it cannot parse', () => {
    expect(nextRunAt({ cron: '*/7 3 2 4 5' }, new Date(), 'UTC')).toBeNull();
    expect(nextRunAt(null, new Date(), 'UTC')).toBeNull();
  });
});
