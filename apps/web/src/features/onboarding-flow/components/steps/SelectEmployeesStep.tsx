'use client';

import { EMPLOYEE_TEMPLATES, PLANS } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import { CardCheckbox } from '../CardCheckbox';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function SelectEmployeesStep() {
  const { state, dispatch, nextStep, prevStep, setErrors } = useOnboardingFlow();
  const plan = PLANS.find((p) => p.key === state.planKey) ?? PLANS[0];
  const atRoleLimit =
    plan.maxRoles != null && state.selectedTemplateKeys.length >= plan.maxRoles;

  const onContinue = () => {
    if (state.selectedTemplateKeys.length === 0) {
      setErrors({ employees: 'Select at least one AI Employee to continue.' });
      return;
    }
    nextStep();
  };

  return (
    <FlowShell
      heading="Which AI Employees do you want to hire?"
      subtitle="You can select multiple. Configure them next."
      wide
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {EMPLOYEE_TEMPLATES.map((template) => {
          const selected = state.selectedTemplateKeys.includes(template.key);
          const disabled = !selected && atRoleLimit;
          return (
            <button
              key={template.key}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => {
                dispatch({ type: 'TOGGLE_EMPLOYEE_TEMPLATE', key: template.key });
                dispatch({ type: 'CLEAR_ERROR', field: 'employees' });
              }}
              className={`relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${
                disabled ? 'cursor-not-allowed opacity-40' : ''
              } ${
                selected
                  ? 'border-violet-secondary/60 bg-violet/[0.1]'
                  : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]'
              }`}
            >
              <CardCheckbox checked={selected} className="absolute right-3 top-3" />
              <EmployeeAvatar template={template} />
              <p className="text-sm font-semibold text-white">{template.name}</p>
              <p className="text-xs text-fg-muted">{template.description}</p>
            </button>
          );
        })}
      </div>

      {state.errors.employees && (
        <p className="mt-3 text-[13px] text-red-400">{state.errors.employees}</p>
      )}
      {atRoleLimit && (
        <p className="mt-3 text-[13px] text-amber-400">
          Your {plan.displayName} plan includes {plan.maxRoles} AI Employee role
          {plan.maxRoles === 1 ? '' : 's'}. Upgrade to select more.
        </p>
      )}

      <p className="mt-4 text-sm text-fg-muted">
        {state.selectedTemplateKeys.length} selected
      </p>

      <StepFooter onBack={prevStep} onContinue={onContinue} />
    </FlowShell>
  );
}
