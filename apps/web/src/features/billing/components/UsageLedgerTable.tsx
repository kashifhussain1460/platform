'use client';

import { useState } from 'react';
import { DEFAULT_CREDITS_PER_USD } from '@vaep/types';
import { useEmployees } from '@/features/employees/hooks';
import { useCreditLedger } from '../credits-hooks';
import type { CreditLedgerFilters } from '../credits-api';

const SOURCES = ['SYSTEM', 'USER', 'WEBHOOK', 'ADMIN'] as const;

/**
 * §22 CREATE NEW — row-level ledger table (Task 9.5). Column spec: date,
 * employee, workflow, action, credits, actual cost. `since`/`until` are
 * plain `<input type="date">` — no client-side date library dependency.
 */
export function UsageLedgerTable() {
  const [filters, setFilters] = useState<CreditLedgerFilters>({ limit: 50 });
  const { data: employees } = useEmployees();
  const { data: entries, isLoading } = useCreditLedger(filters);

  const employeeName = (id: string | null) =>
    id ? employees?.find((e) => e.id === id)?.name ?? id : '—';

  return (
    <div className="rounded-2xl border border-app-border bg-app-surface p-6">
      <h2 className="text-base font-bold text-app-ink">Usage Ledger</h2>

      <div className="mt-4 flex flex-wrap gap-3">
        <select
          value={filters.employeeId ?? ''}
          onChange={(e) =>
            setFilters((f) => ({ ...f, employeeId: e.target.value || undefined }))
          }
          className="rounded-lg border border-app-border-strong bg-app-raised px-3 py-1.5 text-sm text-app-ink"
        >
          <option value="">All employees</option>
          {employees?.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.name}
            </option>
          ))}
        </select>

        <select
          value={filters.source ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value || undefined }))}
          className="rounded-lg border border-app-border-strong bg-app-raised px-3 py-1.5 text-sm text-app-ink"
        >
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={filters.since ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value || undefined }))}
          className="rounded-lg border border-app-border-strong bg-app-raised px-3 py-1.5 text-sm text-app-ink"
          aria-label="Since"
        />
        <input
          type="date"
          value={filters.until ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, until: e.target.value || undefined }))}
          className="rounded-lg border border-app-border-strong bg-app-raised px-3 py-1.5 text-sm text-app-ink"
          aria-label="Until"
        />
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-app-border text-xs uppercase tracking-wide text-app-ink-3">
              <th className="py-2 pr-4">Date</th>
              <th className="py-2 pr-4">Employee</th>
              <th className="py-2 pr-4">Workflow</th>
              <th className="py-2 pr-4">Action</th>
              <th className="py-2 pr-4">Credits</th>
              <th className="py-2 pr-4">Actual Cost</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="py-4 text-app-ink-3">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && entries?.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-app-ink-3">
                  No usage in this range.
                </td>
              </tr>
            )}
            {entries?.map((entry) => (
              <tr key={entry.id} className="border-b border-app-border/50">
                <td className="py-2 pr-4 text-app-ink-2">
                  {new Date(entry.createdAt).toLocaleString()}
                </td>
                <td className="py-2 pr-4 text-app-ink-2">{employeeName(entry.employeeId)}</td>
                <td className="py-2 pr-4 text-app-ink-2">{entry.workflowId ?? '—'}</td>
                <td className="py-2 pr-4 text-app-ink-2">
                  {entry.transactionType}
                  {entry.grantKind ? ` · ${entry.grantKind}` : ''}
                </td>
                <td className="py-2 pr-4 tabular-nums text-app-ink">{entry.amount}</td>
                <td className="py-2 pr-4 tabular-nums text-app-ink-3">
                  ${(Math.abs(entry.amount) / DEFAULT_CREDITS_PER_USD).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-app-ink-3">
        Actual cost is illustrative (derived from the credits amount), not an exact bill.
      </p>
    </div>
  );
}
