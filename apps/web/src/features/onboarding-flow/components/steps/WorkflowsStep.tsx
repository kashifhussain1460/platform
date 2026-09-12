'use client';

import { Bot, LayoutTemplate, Wrench } from 'lucide-react';
import { WORKFLOW_TEMPLATES, templateFor } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

const BUILD_MODES = [
  { key: 'template', icon: LayoutTemplate, label: 'Use a template', hint: 'Start with a ready-made workflow' },
  { key: 'assist', icon: Bot, label: 'Create with AI Assist', hint: 'Describe what you want in plain English' },
  { key: 'manual', icon: Wrench, label: 'Build manually', hint: 'Create from scratch' },
] as const;

export function WorkflowsStep() {
  const { activeEmployee, dispatch, goToStep, prevStep } = useOnboardingFlow();

  if (!activeEmployee) {
    return (
      <FlowShell heading="Workflows">
        <p className="text-sm text-app-ink-3">No AI Employees selected yet.</p>
        <StepFooter onBack={prevStep} onContinue={() => goToStep('configureEmployees')} />
      </FlowShell>
    );
  }

  const template = templateFor(activeEmployee.templateKey);
  const recommended = template.suggestedWorkflowKeys.map((k) => WORKFLOW_TEMPLATES[k]).filter(Boolean);
  const backToHub = () => goToStep('configureEmployees');

  return (
    <FlowShell
      heading={`Set Up Workflows for ${activeEmployee.name || template.name}`}
      subtitle="Choose how this employee will work — a template, AI Assist, or built by hand."
      wide
    >
      <EmployeeContextHeader employee={activeEmployee} />

      <div className="grid gap-3 sm:grid-cols-3">
        {BUILD_MODES.map(({ key, icon: Icon, label, hint }) => (
          <div
            key={key}
            className="flex flex-col items-start gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.06] text-violet-secondary">
              <Icon className="h-4 w-4" />
            </span>
            <p className="text-sm font-medium text-white">{label}</p>
            <p className="text-xs text-fg-muted">{hint}</p>
          </div>
        ))}
      </div>

      <p className="mb-2 mt-6 text-xs text-fg-muted">
        Recommended templates for {template.name}
      </p>
      {recommended.length === 0 ? (
        <p className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-fg-muted">
          No recommended templates for this role yet — build one manually or with AI Assist.
        </p>
      ) : (
        <ul className="space-y-2">
          {recommended.map((wf) => {
            const checked = activeEmployee.workflowKeys.includes(wf.key);
            return (
              <label
                key={wf.key}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                  checked
                    ? 'border-violet-secondary/60 bg-violet/[0.08]'
                    : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    dispatch({ type: 'TOGGLE_EMPLOYEE_WORKFLOW', employeeId: activeEmployee.id, workflowKey: wf.key })
                  }
                  className="mt-0.5 h-5 w-5 shrink-0 rounded-md border-white/20 bg-white/5 accent-[#6a30ec]"
                />
                <span>
                  <span className="block text-sm font-medium text-white">{wf.name}</span>
                  <span className="block text-xs text-fg-muted">{wf.description}</span>
                </span>
              </label>
            );
          })}
        </ul>
      )}

      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
