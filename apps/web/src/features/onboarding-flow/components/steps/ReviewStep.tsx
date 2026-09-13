'use client';

import { AlertTriangle, Check } from 'lucide-react';
import { useEmployeeReadiness } from '@/features/employees/hooks';
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
 *
 * There is no "activate" action on this screen: `EmployeeStatus` has no
 * draft/pending state, and every employee is already `ACTIVE` (and running)
 * from the moment it's created. This screen is a read-only setup-progress
 * readout, not a control that flips the employee on.
 */
export function ReviewStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const { employee } = useActiveEmployee();
  const readinessQuery = useEmployeeReadiness(employee?.id ?? '');
  const readiness = readinessQuery.data;

  if (!employee) {
    return (
      <FlowShell heading="Review your AI Employees">
        <p className="text-sm text-fg-muted">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={prevStep} continueLabel="Back" />
      </FlowShell>
    );
  }

  // Load/error gate (Task 14's own lesson — the fake "Activated" pill it
  // removed was exactly this dishonest-UI anti-pattern): don't render the
  // checklist/readiness readout straight from an in-flight or failed query.
  // Before the query resolves, `readiness` is `undefined` and every field
  // read below is optional-chained, so this would otherwise silently render
  // an empty checklist plus a bare "Not ready" — indistinguishable from a
  // real, resolved "nothing is ready yet".
  if (!readinessQuery.isSuccess) {
    if (readinessQuery.isError) {
      return (
        <FlowShell heading="Review your AI Employees" subtitle="Make sure everything is ready before activating." wide>
          <p className="text-sm text-red-400">
            Couldn't load readiness for {employee.name}. {readinessQuery.error?.message ?? 'Please try again.'}
          </p>
          <StepFooter onBack={prevStep} onContinue={() => void readinessQuery.refetch()} continueLabel="Retry" />
        </FlowShell>
      );
    }
    return (
      <FlowShell heading="Review your AI Employees" subtitle="Make sure everything is ready before activating." wide>
        <p className="text-sm text-fg-muted">Checking readiness…</p>
      </FlowShell>
    );
  }

  const template = templateForRole(employee.role);

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
            {readiness?.setupState === 'READY' && (
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">Ready</span>
            )}
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

          <div
            className={
              readiness?.ready
                ? 'mt-6 w-full rounded-xl bg-violet px-4 py-2.5 text-center text-sm font-medium text-white'
                : 'mt-6 w-full cursor-not-allowed rounded-xl bg-violet px-4 py-2.5 text-center text-sm font-medium text-white opacity-40'
            }
          >
            {readiness?.ready ? 'Ready ✓' : 'Not ready'}
          </div>
        </div>
      </div>
      <StepFooter onBack={prevStep} onContinue={nextStep} continueLabel="Finish →" />
    </FlowShell>
  );
}
