'use client';

import Link from 'next/link';
import { useUsage } from '../hooks';
import { formatLimit, formatNumber } from '../labels';

/** "Used / total" row with a progress bar — only meaningful when a real plan limit exists. */
function UsageBar({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max === null ? null : Math.min(100, (used / max) * 100);
  const barColor = pct !== null && pct >= 70 ? 'bg-violet' : 'bg-green-500';

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-app-ink-2">{label}</p>
        <p className="text-xs tabular-nums text-app-ink-3">
          {formatNumber(used)} / {formatLimit(max)}
        </p>
      </div>
      {pct !== null && (
        <div className="mt-2 h-2 rounded-full bg-app-raised">
          <div style={{ width: `${pct}%` }} className={`h-2 rounded-full ${barColor}`} />
        </div>
      )}
    </div>
  );
}

/** Plain count row for usage metrics that have no configured plan limit. */
function UsageCount({ label, value, helper }: { label: string; value: number; helper?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <div>
        <p className="text-sm text-app-ink-2">{label}</p>
        {helper && <p className="mt-0.5 text-xs text-app-ink-3">{helper}</p>}
      </div>
      <p className="text-sm font-semibold tabular-nums text-app-ink">{formatNumber(value)}</p>
    </div>
  );
}

/** Usage summary: employees vs limit (with soft over-limit hint), skills, tasks. */
export function UsageSummary() {
  const { data: usage, isLoading } = useUsage();

  if (isLoading || !usage) {
    return (
      <div className="flex h-full flex-col rounded-2xl border border-app-border bg-app-surface p-6">
        <p className="text-sm text-app-ink-3">Loading usage…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border border-app-border bg-app-surface p-6">
      <h2 className="text-base font-bold text-app-ink">Usage This Month</h2>

      <div className="mt-5 space-y-5">
        <UsageBar label="AI Employees" used={usage.employees} max={usage.maxEmployees} />
        <UsageCount label="Installed Skills" value={usage.installedSkills} />
        <UsageCount label="Tasks" value={usage.tasks} helper="tools + messages + workflows" />
        <UsageCount
          label="AI Tokens Used"
          value={usage.tokens}
          helper={`~$${usage.estimatedCostUsd.toFixed(2)} estimated — illustrative, not an exact bill`}
        />
      </div>

      {usage.overEmployeeLimit && (
        <div className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
          <span>
            You&rsquo;re over your plan&rsquo;s AI employee limit
            {usage.maxEmployees !== null
              ? ` (${formatNumber(usage.employees)} of ${formatNumber(usage.maxEmployees)})`
              : ''}
            . Upgrade for more capacity.
          </span>
          <Link
            href="#plans"
            className="shrink-0 font-semibold text-amber-700 underline underline-offset-2"
          >
            Upgrade
          </Link>
        </div>
      )}

      <p className="mt-5 text-xs text-app-ink-3">
        Voice-minute metering is coming soon.
      </p>
    </div>
  );
}
