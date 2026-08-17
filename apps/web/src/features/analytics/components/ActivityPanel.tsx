'use client';

import type { AnalyticsRange } from '@vaep/types';
import { useActivityFeed } from '../hooks';
import { formatNumber } from '../labels';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'A';
}

/** "Today's AI Activity": per employee, grouped skill/tool + message counts. */
export function ActivityPanel({ range }: { range: AnalyticsRange }) {
  const { data: feed, isLoading } = useActivityFeed(range);

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading activity…</p>;
  }
  if (!feed || feed.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No AI activity in this window yet. Actions your employees take will show
        up here.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {feed.map((entry) => (
        <li
          key={entry.employeeId}
          className="rounded-2xl border border-app-border bg-app-surface p-4"
        >
          <div className="mb-2.5 flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] text-xs font-semibold text-white">
              {initials(entry.employee)}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-app-ink">
              {entry.employee}
            </span>
            <span className="shrink-0 text-xs text-app-ink-3">{entry.role}</span>
          </div>
          <ul className="flex flex-wrap gap-2">
            {entry.items.map((item) => (
              <li
                key={item.label}
                className="inline-flex items-center gap-1.5 rounded-full bg-app-raised px-2.5 py-1 text-xs text-app-ink-2"
              >
                <span>{item.label}</span>
                <span className="font-semibold text-app-ink">
                  {formatNumber(item.count)}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
