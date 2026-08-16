import {
  CRON_SLOT_MS,
  MIN_SCHEDULE_MS,
  scheduleSlotKey,
} from './workflows.constants';

/**
 * WAVE 1 (G-B1) — the SCHEDULE idempotency key.
 *
 * A schedule has two independent drivers (the BullMQ repeatable and the
 * serverless cron sweep). If both are live, both fire. This key is what makes
 * the second fire in one occurrence a database no-op instead of a second run.
 */
describe('scheduleSlotKey', () => {
  it('gives two fires inside one interval the SAME key', () => {
    const config = { everyMs: 60_000 };
    const a = scheduleSlotKey('wf-1', config, 1_800_000_000_000);
    const b = scheduleSlotKey('wf-1', config, 1_800_000_000_000 + 59_999);
    expect(a).toBe(b);
  });

  it('gives the next interval a DIFFERENT key', () => {
    const config = { everyMs: 60_000 };
    const a = scheduleSlotKey('wf-1', config, 1_800_000_000_000);
    const b = scheduleSlotKey('wf-1', config, 1_800_000_000_000 + 60_000);
    expect(a).not.toBe(b);
  });

  it('namespaces by workflow so two schedules never collide', () => {
    const config = { everyMs: 60_000 };
    expect(scheduleSlotKey('wf-1', config, 1_800_000_000_000)).not.toBe(
      scheduleSlotKey('wf-2', config, 1_800_000_000_000),
    );
  });

  it('falls back to a one-minute slot for a cron schedule (no everyMs)', () => {
    // Cron's finest legal granularity is a minute, so two fires inside one
    // minute are always a duplicate delivery, never two occurrences.
    const a = scheduleSlotKey('wf-1', { cron: '* * * * *' } as never, 1_800_000_000_000);
    const b = scheduleSlotKey('wf-1', { cron: '* * * * *' } as never, 1_800_000_000_000 + CRON_SLOT_MS - 1);
    const c = scheduleSlotKey('wf-1', { cron: '* * * * *' } as never, 1_800_000_000_000 + CRON_SLOT_MS);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('ignores an everyMs below the minimum rather than trusting it', () => {
    // A sub-minimum interval is not a legal schedule; honouring it would make
    // the dedup window narrower than the schedule itself.
    const tooSmall = { everyMs: MIN_SCHEDULE_MS - 1 };
    const a = scheduleSlotKey('wf-1', tooSmall, 1_800_000_000_000);
    const b = scheduleSlotKey('wf-1', tooSmall, 1_800_000_000_000 + 30_000);
    expect(a).toBe(b);
  });

  it('handles a null/absent config', () => {
    expect(() => scheduleSlotKey('wf-1', null, Date.now())).not.toThrow();
    expect(scheduleSlotKey('wf-1', null, 1_800_000_000_000)).toContain('schedule:wf-1:');
  });
});
