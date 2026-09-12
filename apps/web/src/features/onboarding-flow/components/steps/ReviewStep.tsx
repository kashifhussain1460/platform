'use client';

import { AlertTriangle, Check } from 'lucide-react';
import { templateFor } from '../../mockData';
import { computeReadiness, useOnboardingFlow } from '../../state';
import { EmployeeTabs } from '../EmployeeTabs';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function ReviewStep() {
  const { state, dispatch, activeEmployee, nextStep, prevStep, goToStep } = useOnboardingFlow();

  if (!activeEmployee) {
    return (
      <FlowShell heading="Review your AI Employees">
        <p className="text-sm text-app-ink-3">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={prevStep} continueLabel="Back" />
      </FlowShell>
    );
  }

  const readiness = computeReadiness(activeEmployee);
  const isActivated = state.activatedEmployeeIds.includes(activeEmployee.id);
  const allActivated =
    state.employees.length > 0 &&
    state.employees.every((e) => state.activatedEmployeeIds.includes(e.id));

  const fixTarget: Record<string, () => void> = {
    BASIC: () => goToStep('configureEmployees'),
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
              <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${templateFor(activeEmployee.templateKey).colorClass}`}>
                {(() => {
                  const Icon = templateFor(activeEmployee.templateKey).icon;
                  return <Icon className="h-5 w-5" />;
                })()}
              </span>
              <div>
                <p className="text-sm font-semibold text-white">
                  {activeEmployee.name || activeEmployee.role}
                </p>
                <p className="text-xs text-fg-muted">{activeEmployee.role}</p>
              </div>
            </div>
            {isActivated && (
              <span className="rounded-full bg-status-active/15 px-2.5 py-1 text-xs font-medium text-sl-active">
                Activated
              </span>
            )}
          </div>

          <ul className="mt-5 space-y-2.5">
            {readiness.checks.map((check) => (
              <li key={check.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-zinc-300">
                  {check.status === 'PASS' ? (
                    <Check className="h-4 w-4 text-sl-active" />
                  ) : (
                    <AlertTriangle
                      className={`h-4 w-4 ${check.status === 'FAIL' ? 'text-sl-failed' : 'text-sl-warning'}`}
                    />
                  )}
                  {check.label}
                </span>
                {check.status !== 'PASS' && (
                  <button
                    type="button"
                    onClick={fixTarget[check.key]}
                    className="text-xs font-medium text-violet-secondary underline hover:text-violet"
                  >
                    Fix
                  </button>
                )}
              </li>
            ))}
          </ul>

          {readiness.issues.length > 0 && (
            <ul className="mt-4 space-y-1.5 border-t border-white/[0.06] pt-4">
              {readiness.issues.map((issue) => (
                <li
                  key={issue.code}
                  className={`text-xs ${issue.severity === 'BLOCKER' ? 'text-sl-failed' : 'text-sl-warning'}`}
                >
                  {issue.message}
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            disabled={!readiness.ready || isActivated}
            onClick={() => dispatch({ type: 'ACTIVATE_EMPLOYEE', id: activeEmployee.id })}
            className="mt-6 w-full rounded-xl bg-violet px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isActivated ? 'Activated ✓' : readiness.ready ? 'Activate Employee' : 'Not ready'}
          </button>
        </div>
      </div>

      <StepFooter
        onBack={prevStep}
        onContinue={nextStep}
        continueLabel="Finish →"
        continueDisabled={!allActivated}
      />
      {!allActivated && (
        <p className="mt-3 text-center text-[13px] text-fg-muted">
          Activate every AI Employee above to finish onboarding.
        </p>
      )}
    </FlowShell>
  );
}
