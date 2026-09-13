'use client';

import { useEmployees } from '@/features/employees/hooks';
import { templateForRole } from '../mockData';
import { useOnboardingWizardStore } from '../wizardStore';
import { EmployeeAvatar } from './EmployeeAvatar';

/**
 * Left-column employee list for every per-employee step (Configure, Skills,
 * Connections, Workflows, Review). Skills/Connections/Knowledge/Workflows are
 * NOT company-wide — they belong to one AI Employee — so every one of those
 * screens needs this same "which employee am I configuring" switch, and it
 * has to be the SAME component so switching between those steps doesn't lose
 * track of which employee was selected.
 *
 * Ordered by `wizardStore.employeeOrder` (the order the wizard hired them
 * in), not the raw `useEmployees()` fetch order — the roster query has no
 * guaranteed order and a company may have pre-existing employees outside
 * this wizard run.
 */
export function EmployeeTabs() {
  const { data: employees = [] } = useEmployees();
  const employeeOrder = useOnboardingWizardStore((s) => s.employeeOrder);
  const activeEmployeeId = useOnboardingWizardStore((s) => s.activeEmployeeId);
  const setActiveEmployee = useOnboardingWizardStore((s) => s.setActiveEmployee);

  const ordered = employeeOrder
    .map((id) => employees.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));

  if (ordered.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No AI Employees selected yet — go back and choose at least one.
      </p>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
      {ordered.map((e) => {
        const template = templateForRole(e.role);
        const isActive = activeEmployeeId === e.id;
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => setActiveEmployee(e.id)}
            className={`flex shrink-0 items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm font-medium transition-colors lg:shrink lg:w-full ${
              isActive
                ? 'border-violet-secondary/60 bg-violet/[0.1] text-white'
                : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16]'
            }`}
          >
            <EmployeeAvatar template={template} size="sm" />
            <span className="min-w-0 flex-1 truncate">{e.name || template.name}</span>
          </button>
        );
      })}
    </div>
  );
}
