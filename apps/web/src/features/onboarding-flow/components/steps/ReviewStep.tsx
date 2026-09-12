'use client';

import { AlertTriangle, Check } from 'lucide-react';
import { useEmployeeReadiness, useUpdateEmployee } from '@/features/employees/hooks';
import { templateForRole } from '../../mockData';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { EmployeeTabs } from '../EmployeeTabs';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

/**
 * Readiness is sourced entirely from `GET /employees/:id/readiness` — the
 * server computes the same checks (status/skills/connections/knowledge/
 * workflows) the old mock's local `computeReadiness()` faked client-side.
 * No local re-derivation here; if the server's rules change, this screen
 * changes with them automatically instead of drifting.
 */
export function ReviewStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const { data: readiness } = useEmployeeReadiness(employee?.id ?? '');
  const updateEmployee = useUpdateEmployee();

  if (!employee) {
    return (
      <FlowShell heading="Review your AI Employees">
        <p className="text-sm text-fg-muted">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={prevStep} continueLabel="Back" />
      </FlowShell>
    );
  }

  const template = templateForRole(employee.role);
  const isActive = employee.status === 'ACTIVE';

  const fixTarget: Record<string, () => void> = {
    STATUS: () => goToStep('configureEmployees'),
    SKILLS: () => goToStep('skills'),
    CONNECTIONS: () => goToStep('connections'),
    KNOWLEDGE: () => goToStep('knowledge'),
    WORKFLOWS: () => goToStep('workflows'),
  };

  return (
    <FlowShell heading="Review your AI Employees" subtitle="Make sure everything is ready before activating." wide>
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <EmployeeTabs />
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <EmployeeAvatar template={template} />
              <div>
                <p className="text-sm font-semibold text-white">{employee.name}</p>
                <p className="text-xs text-fg-muted">{employee.role}</p>
              </div>
            </div>
            {isActive && <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">Activated</span>}
          </div>

          <ul className="mt-5 space-y-2.5">
            {readiness?.checks.map((check) => (
              <li key={check.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-zinc-300">
                  {check.status === 'PASS' ? <Check className="h-4 w-4 text-emerald-400" /> : <AlertTriangle className={`h-4 w-4 ${check.status === 'FAIL' ? 'text-red-400' : 'text-amber-400'}`} />}
                  {check.label}
                </span>
                {check.status !== 'PASS' && (
                  <button type="button" onClick={fixTarget[check.key]} className="text-xs font-medium text-violet-secondary underline hover:text-violet">Fix</button>
                )}
              </li>
            ))}
          </ul>

          {readiness && readiness.issues.length > 0 && (
            <ul className="mt-4 space-y-1.5 border-t border-white/[0.06] pt-4">
              {readiness.issues.map((issue, i) => (
                <li key={`${issue.code}-${issue.skillKey ?? i}`} className={`text-xs ${issue.severity === 'BLOCKER' ? 'text-red-400' : 'text-amber-400'}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            disabled={!readiness?.ready || isActive}
            onClick={() => updateEmployee.mutate({ id: employee.id, data: { status: 'ACTIVE' } })}
            className="mt-6 w-full rounded-xl bg-violet px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isActive ? 'Activated ✓' : readiness?.ready ? 'Activate Employee' : 'Not ready'}
          </button>
        </div>
      </div>
      <StepFooter onBack={prevStep} onContinue={nextStep} continueLabel="Finish →" />
    </FlowShell>
  );
}
