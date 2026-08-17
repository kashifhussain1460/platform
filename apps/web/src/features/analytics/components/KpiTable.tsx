'use client';

import type { AnalyticsRange, KpiAttainmentDto } from '@vaep/types';
import { useEmployeeKpis } from '../hooks';
import { formatHours, formatNumber } from '../labels';

/** Attainment badge tone: higher-is-better metrics get a green/amber/red scale. */
function scaleClass(pct: number): string {
  if (pct >= 100) return 'bg-green-500/15 text-green-800';
  if (pct >= 70) return 'bg-amber-500/15 text-amber-800';
  return 'bg-red-500/15 text-red-600';
}

/**
 * Actual-vs-target attainment (P1 #6). Tasks + success rate use the higher-is-
 * better scale; approvals is "% of the pending cap used" and stays neutral.
 * Renders "—" when the employee has no KPI targets configured.
 */
function AttainmentCell({ a }: { a: KpiAttainmentDto | null }) {
  const parts = a
    ? ([
        { label: 'Tasks', pct: a.tasksPct, neutral: false },
        { label: 'Rate', pct: a.successRatePct, neutral: false },
        { label: 'Appr', pct: a.approvalsPct, neutral: true },
      ].filter((p) => p.pct !== null) as {
        label: string;
        pct: number;
        neutral: boolean;
      }[])
    : [];
  if (parts.length === 0) {
    return <span className="text-app-ink-3">—</span>;
  }
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {parts.map((p) => (
        <span
          key={p.label}
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            p.neutral ? 'bg-app-raised text-app-ink-2' : scaleClass(p.pct)
          }`}
          title={`${p.label}: ${p.pct}% of target`}
        >
          {p.label} {p.pct}%
        </span>
      ))}
    </div>
  );
}

/** Per-employee KPI table: name/role, tasks, tool actions, success, attainment. */
export function KpiTable({ range }: { range: AnalyticsRange }) {
  const { data: rows, isLoading } = useEmployeeKpis(range);

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading employee metrics…</p>;
  }
  if (!rows || rows.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No employees yet. Hire an AI employee to see per-employee metrics.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-app-border bg-app-surface">
      <table className="min-w-full divide-y divide-app-border text-sm">
        <thead className="bg-app-surface text-left text-xs font-medium uppercase tracking-wide text-app-ink-3">
          <tr>
            <th className="px-4 py-3">Employee</th>
            <th className="px-4 py-3 text-right">Tasks</th>
            <th className="px-4 py-3 text-right">Tool actions</th>
            <th className="px-4 py-3 text-right">Success</th>
            <th className="px-4 py-3 text-right">Hours saved</th>
            <th className="px-4 py-3 text-right">Attainment</th>
            <th className="px-4 py-3 text-right">Pending</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-app-border">
          {rows.map((r) => (
            <tr key={r.employeeId} className="transition-colors hover:bg-app-raised">
              <td className="px-4 py-3">
                <div className="font-medium text-app-ink">{r.name}</div>
                <div className="text-xs text-app-ink-3">
                  {r.role} · {r.status.toLowerCase()}
                </div>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-app-ink-2">
                {formatNumber(r.tasksCompleted)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-app-ink-2">
                {formatNumber(r.toolActions)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-app-ink-2">
                {formatNumber(r.toolSuccess)}
                {r.toolErrors > 0 && (
                  <span className="text-red-600"> / {formatNumber(r.toolErrors)} err</span>
                )}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-app-ink-2">
                {formatHours(r.hoursSaved)}
              </td>
              <td className="px-4 py-3 text-right">
                <AttainmentCell a={r.attainment} />
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {r.pendingApprovals > 0 ? (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-800">
                    {formatNumber(r.pendingApprovals)}
                  </span>
                ) : (
                  <span className="text-app-ink-3">0</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
