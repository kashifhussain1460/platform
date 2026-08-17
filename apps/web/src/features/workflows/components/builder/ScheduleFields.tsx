'use client';

import type { TriggerConfig } from '@vaep/types';
import {
  describeInterval,
  formatTime,
  fromTriggerConfig,
  nextRunAt,
  toTriggerConfig,
  WEEKDAY_NAMES,
  type FriendlySchedule,
  type ScheduleFrequency,
} from '../../schedule';

const inputCls =
  'w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-ink outline-none placeholder:text-app-ink-3 focus-visible:ring-2 focus-visible:ring-wf-focus disabled:opacity-60';

const FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: 'DAILY', label: 'Every day' },
  { value: 'WEEKDAYS', label: 'Every weekday (Mon–Fri)' },
  { value: 'WEEKLY', label: 'Every week' },
  { value: 'MONTHLY', label: 'Every month' },
  { value: 'HOURLY', label: 'Every hour' },
  { value: 'INTERVAL', label: 'Every so many minutes' },
  { value: 'CUSTOM', label: 'Custom (cron expression)' },
];

/** Sensible starting point when someone switches frequency — never a blank. */
function defaultFor(frequency: ScheduleFrequency): FriendlySchedule {
  switch (frequency) {
    case 'HOURLY':
      return { frequency: 'HOURLY', minute: 0 };
    case 'WEEKDAYS':
      return { frequency: 'WEEKDAYS', hour: 9, minute: 0 };
    case 'WEEKLY':
      return { frequency: 'WEEKLY', weekday: 1, hour: 9, minute: 0 };
    case 'MONTHLY':
      return { frequency: 'MONTHLY', day: 1, hour: 9, minute: 0 };
    case 'INTERVAL':
      return { frequency: 'INTERVAL', everyMs: 15 * 60_000 };
    case 'CUSTOM':
      return { frequency: 'CUSTOM', cron: '0 9 * * 1' };
    default:
      return { frequency: 'DAILY', hour: 9, minute: 0 };
  }
}

/** THE default when a workflow first becomes scheduled. */
export const DEFAULT_SCHEDULE: FriendlySchedule = defaultFor('DAILY');

/**
 * SCHEDULE CONFIGURATION, inside the trigger (UX plan §18).
 *
 * "Every Monday at 9am", not `0 9 * * 1` — though the cron field is still there
 * for anyone who wants it. Every control writes a COMPLETE schedule: the API
 * rejects a SCHEDULE trigger with no time at save time (400), so a half-filled
 * form would be unsaveable rather than merely incomplete.
 *
 * ── About the timezone ──────────────────────────────────────────────────────
 * The scheduler evaluates the expression in the SERVER's timezone. There is no
 * per-workflow timezone column, so this does not offer one. It shows which zone
 * the times are read in, and resolves "Next run" to a real instant in the
 * viewer's local time — which is the honest version of what the plan asks for.
 */
export function ScheduleFields({
  value,
  onChange,
  timeZone,
  disabled,
}: {
  value: TriggerConfig | null;
  onChange: (config: TriggerConfig) => void;
  /** The zone the times are written in. Falls back to the viewer's own. */
  timeZone?: string;
  disabled?: boolean;
}) {
  const zone =
    timeZone ||
    (typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'UTC');

  const schedule = fromTriggerConfig(value) ?? DEFAULT_SCHEDULE;
  const set = (next: FriendlySchedule) => onChange(toTriggerConfig(next));

  const hour = 'hour' in schedule ? schedule.hour : 9;
  const minute = 'minute' in schedule ? schedule.minute : 0;

  const next = nextRunAt(toTriggerConfig(schedule), new Date(), zone);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-app-ink-2">
          How often?
        </span>
        <select
          className={inputCls}
          value={schedule.frequency}
          disabled={disabled}
          onChange={(e) => set(defaultFor(e.target.value as ScheduleFrequency))}
        >
          {FREQUENCIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      {schedule.frequency === 'WEEKLY' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-app-ink-2">Day</span>
          <select
            className={inputCls}
            value={schedule.weekday}
            disabled={disabled}
            onChange={(e) =>
              set({ ...schedule, weekday: Number(e.target.value) })
            }
          >
            {WEEKDAY_NAMES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}

      {schedule.frequency === 'MONTHLY' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-app-ink-2">
            Day of the month
          </span>
          <select
            className={inputCls}
            value={schedule.day}
            disabled={disabled}
            onChange={(e) => set({ ...schedule, day: Number(e.target.value) })}
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-app-ink-3">
            Days 29–31 aren&apos;t offered — they&apos;d skip short months.
          </span>
        </label>
      )}

      {schedule.frequency === 'HOURLY' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-app-ink-2">
            Minutes past the hour
          </span>
          <input
            type="number"
            min={0}
            max={59}
            className={inputCls}
            value={schedule.minute}
            disabled={disabled}
            onChange={(e) =>
              set({
                frequency: 'HOURLY',
                minute: clamp(Number(e.target.value), 0, 59),
              })
            }
          />
        </label>
      )}

      {(schedule.frequency === 'DAILY' ||
        schedule.frequency === 'WEEKDAYS' ||
        schedule.frequency === 'WEEKLY' ||
        schedule.frequency === 'MONTHLY') && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-app-ink-2">
            Time
          </span>
          <input
            type="time"
            className={inputCls}
            value={formatTime(hour, minute)}
            disabled={disabled}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              if (Number.isNaN(h) || Number.isNaN(m)) return;
              set({ ...schedule, hour: h, minute: m } as FriendlySchedule);
            }}
          />
        </label>
      )}

      {schedule.frequency === 'INTERVAL' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-app-ink-2">
            Every how many minutes?
          </span>
          <input
            type="number"
            min={1}
            className={inputCls}
            value={Math.max(1, Math.round(schedule.everyMs / 60_000))}
            disabled={disabled}
            onChange={(e) =>
              set({
                frequency: 'INTERVAL',
                everyMs: Math.max(1, Number(e.target.value) || 1) * 60_000,
              })
            }
          />
          <span className="mt-1 block text-xs text-app-ink-3">
            The shortest allowed gap is 15 seconds.
          </span>
        </label>
      )}

      {schedule.frequency === 'CUSTOM' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-app-ink-2">
            Cron expression
          </span>
          <input
            type="text"
            className={`${inputCls} font-mono`}
            value={schedule.cron}
            disabled={disabled}
            placeholder="0 9 * * 1"
            onChange={(e) => set({ frequency: 'CUSTOM', cron: e.target.value })}
          />
        </label>
      )}

      <div className="rounded-lg border border-app-border bg-app-surface px-3 py-2">
        <p className="text-xs text-app-ink-3">
          Times are read in <span className="text-app-ink-2">{zone}</span>.
        </p>
        <p className="mt-0.5 text-xs text-app-ink-2">
          Next run:{' '}
          {next ? (
            <span className="text-app-ink">
              {next.toLocaleString(undefined, {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          ) : schedule.frequency === 'CUSTOM' ? (
            // Refusing to guess beats a confidently wrong prediction.
            <span className="text-app-ink-3">
              can&apos;t be worked out from a custom expression
            </span>
          ) : (
            <span className="text-app-ink-3">—</span>
          )}
          {schedule.frequency === 'INTERVAL' && (
            <span className="text-app-ink-3">
              {' '}
              (then every {describeInterval(schedule.everyMs)})
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
