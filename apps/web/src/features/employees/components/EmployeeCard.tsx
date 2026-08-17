'use client';

import Link from 'next/link';
import { Bot, Trash2 } from 'lucide-react';
import type { AiEmployeeDto, EmployeeStatus } from '@vaep/types';
import { buttonClasses } from '@/components/ui/Button';
import { useDeleteEmployee, useUpdateEmployee } from '../hooks';
import { STATUS_STYLES, formatRole } from '../labels';

const secondaryBtnClass =
  'rounded-lg border border-app-border-strong bg-app-surface px-3 py-1.5 text-xs font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50';

/** One employee card: identity, status badge, lifecycle toggles, open + delete. */
export function EmployeeCard({ employee }: { employee: AiEmployeeDto }) {
  const update = useUpdateEmployee();
  const del = useDeleteEmployee();
  const isTemp = employee.id.startsWith('temp_');

  const setStatus = (status: EmployeeStatus) =>
    update.mutate({ id: employee.id, data: { status } });

  return (
    <div className="flex flex-col rounded-2xl border border-app-border bg-app-surface p-5 transition-colors hover:border-app-border-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet">
            <Bot className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-app-ink">{employee.name}</p>
            <p className="truncate text-xs text-app-ink-2">{formatRole(employee.role)}</p>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[employee.status]}`}
        >
          {employee.status}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {employee.status === 'ACTIVE' && (
          <button
            type="button"
            className={secondaryBtnClass}
            onClick={() => setStatus('PAUSED')}
            disabled={isTemp || update.isPending}
          >
            Pause
          </button>
        )}
        {employee.status === 'PAUSED' && (
          <button
            type="button"
            className={secondaryBtnClass}
            onClick={() => setStatus('ACTIVE')}
            disabled={isTemp || update.isPending}
          >
            Resume
          </button>
        )}
        {employee.status !== 'DISABLED' ? (
          <button
            type="button"
            className={secondaryBtnClass}
            onClick={() => setStatus('DISABLED')}
            disabled={isTemp || update.isPending}
          >
            Disable
          </button>
        ) : (
          <button
            type="button"
            className={secondaryBtnClass}
            onClick={() => setStatus('ACTIVE')}
            disabled={isTemp || update.isPending}
          >
            Enable
          </button>
        )}

        <button
          type="button"
          aria-label="Delete employee"
          className="rounded-lg p-1.5 text-app-ink-3 transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => del.mutate(employee.id)}
          disabled={isTemp || del.isPending}
        >
          <Trash2 className="h-4 w-4" />
        </button>

        <Link
          href={`/employees/${employee.id}`}
          aria-disabled={isTemp}
          className={`ml-auto ${buttonClasses('violet')}`}
        >
          Open
        </Link>
      </div>
    </div>
  );
}
