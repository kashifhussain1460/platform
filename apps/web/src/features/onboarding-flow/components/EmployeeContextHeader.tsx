'use client';

import { Pencil } from 'lucide-react';
import type { AiEmployeeDto } from '@vaep/types';
import { templateForRole } from '../mockData';
import { useOnboardingWizardStore } from '../wizardStore';
import { EmployeeAvatar } from './EmployeeAvatar';

/** Shared header for the per-employee Skills/Connections/Knowledge screens —
 * makes clear which employee this screen belongs to, and "Edit Employee"
 * returns to that employee's Configure Hub rather than the generic Back. */
export function EmployeeContextHeader({ employee }: { employee: AiEmployeeDto }) {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const template = templateForRole(employee.role);

  return (
    <div className="mb-6 flex items-center justify-between gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
      <div className="flex min-w-0 items-center gap-3">
        <EmployeeAvatar template={template} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-base font-semibold text-white">
              {employee.name || template.name}
            </p>
            <span className="shrink-0 rounded-full bg-white/[0.08] px-2 py-0.5 text-[11px] font-medium text-zinc-300">
              {template.department}
            </span>
          </div>
          <p className="truncate text-sm text-fg-muted">{template.description}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => goToStep('configureEmployees')}
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-white/[0.2] hover:text-white"
      >
        <Pencil className="h-3.5 w-3.5" /> Edit Employee
      </button>
    </div>
  );
}
