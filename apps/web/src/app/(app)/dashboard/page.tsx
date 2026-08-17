'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AnalyticsRange } from '@vaep/types';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { ActivityPanel } from '@/features/analytics/components/ActivityPanel';
import { KpiTable } from '@/features/analytics/components/KpiTable';
import { StatTile } from '@/features/analytics/components/StatTile';
import { useOverview } from '@/features/analytics/hooks';
import {
  RANGE_OPTIONS,
  formatCurrency,
  formatHours,
  formatNumber,
  formatPercent,
} from '@/features/analytics/labels';
import { useCurrentUser } from '@/features/auth/hooks';
import { useSessionStore } from '@/stores/session.store';

/** Greeting that adapts to the local time of day. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const { data: me, isLoading } = useCurrentUser();
  const shellProps = useAppShellProps();

  const [range, setRange] = useState<AnalyticsRange>('7d');
  const { data: overview, isLoading: overviewLoading } = useOverview(range);

  // Client-side route guard for this slice (server middleware comes later).
  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  const user = me?.user;

  return (
    <AppShell {...shellProps}>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 pt-2">
        <h1 className="text-2xl font-bold text-app-ink">
          {greeting()}
          {user?.name ? `, ${user.name.split(' ')[0]}` : ''} 👋
        </h1>
        <div className="flex gap-1 rounded-xl border border-app-border bg-app-surface p-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRange(opt.value)}
              className={`rounded-lg px-3.5 py-1.5 text-sm font-medium capitalize transition-colors ${
                range === opt.value
                  ? 'bg-violet text-white'
                  : 'text-app-ink-2 hover:text-app-ink'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI tile row */}
      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Tasks Completed"
          value={overviewLoading ? '—' : formatNumber(overview?.tasksCompleted ?? 0)}
          helper="tool + message + workflow"
          estimate
        />
        <StatTile
          label="Hours Saved"
          value={overviewLoading ? '—' : formatHours(overview?.hoursSaved ?? 0)}
          helper="~10 min/task"
          estimate
        />
        <StatTile
          label="Cost Savings"
          value={overviewLoading ? '—' : formatCurrency(overview?.costSavings ?? 0)}
          helper="@ $25/hr"
          estimate
        />
        <StatTile
          label="Success Rate"
          value={overviewLoading ? '—' : formatPercent(overview?.successRate ?? null)}
          helper="tools + workflows"
        />
        <Link href="/approvals" className="contents">
          <StatTile
            label="Pending Approvals"
            value={
              overviewLoading ? '—' : formatNumber(overview?.pendingApprovals ?? 0)
            }
            helper="review queue →"
          />
        </Link>
        <StatTile
          label="Active Employees"
          value={overviewLoading ? '—' : formatNumber(overview?.activeEmployees ?? 0)}
          helper={
            overview ? `of ${formatNumber(overview.employees)} hired` : undefined
          }
        />
      </section>

      {/* Per-employee KPIs + activity feed */}
      <div className="grid gap-6 lg:grid-cols-5">
        {/* `min-w-0` is what makes the table inside actually scroll. A grid item
            defaults to `min-width: auto`, so it refuses to shrink below its
            content — the 7-column performance table pushed this section to
            635px inside a 390px phone and the whole dashboard scrolled
            sideways, taking the nav with it. The wrapper's `overflow-x-auto`
            could never fire because the column simply grew instead. */}
        <section className="min-w-0 lg:col-span-3">
          <h2 className="mb-3 text-sm font-medium text-app-ink-2">AI Employee Performance</h2>
          <KpiTable range={range} />
        </section>
        <section className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-app-ink-2">Today&rsquo;s AI Activity</h2>
          <ActivityPanel range={range} />
        </section>
      </div>

      {isLoading && (
        <p className="mt-8 text-sm text-app-ink-3">Loading your profile…</p>
      )}
    </AppShell>
  );
}
