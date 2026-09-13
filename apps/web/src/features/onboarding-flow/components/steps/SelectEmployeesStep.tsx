'use client';

import { EMPLOYEE_TEMPLATES } from '../../mockData';
import { useSeatAvailability } from '@/features/product-context/hooks';
import { useOnboardingWizardStore } from '../../wizardStore';
import { CardCheckbox } from '../CardCheckbox';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function SelectEmployeesStep() {
  const selectedTemplateKeys = useOnboardingWizardStore((s) => s.selectedTemplateKeys);
  const toggleTemplateKey = useOnboardingWizardStore((s) => s.toggleTemplateKey);
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const setErrors = useOnboardingWizardStore((s) => s.setErrors);
  const errors = useOnboardingWizardStore((s) => s.errors);
  const clearError = useOnboardingWizardStore((s) => s.clearError);
  const { seats, reasonBlocked } = useSeatAvailability();

  // How many MORE roles this plan allows, on top of whatever's already
  // hired — null = unlimited. Shown next to the selection count so the cap
  // is visible before the user hits it, not just as a per-card grey-out.
  const remaining = (() => {
    if (!seats) return null;
    if (seats.max == null && seats.maxRoles == null) return null;
    const byTotal = seats.max != null ? seats.max - seats.used : Infinity;
    const byRoles = seats.maxRoles != null ? seats.maxRoles - seats.rolesUsed : Infinity;
    return Math.max(0, Math.min(byTotal, byRoles));
  })();

  const onContinue = () => {
    if (selectedTemplateKeys.length === 0) {
      setErrors({ employees: 'Select at least one AI Employee to continue.' });
      return;
    }
    // Defense in depth: card-level greying already prevents selecting past
    // the cap going forward, but a plan downgrade after selecting (or a
    // wizard session resumed from before this check existed) could leave a
    // stale over-cap selection sitting in the persisted store. Re-validate
    // the WHOLE current selection against live entitlements before
    // proceeding, rather than trusting that the UI never let it happen.
    if (remaining !== null && selectedTemplateKeys.length > remaining) {
      setErrors({
        employees: `Your plan only allows ${remaining} more AI employee${remaining === 1 ? '' : 's'} right now — deselect ${selectedTemplateKeys.length - remaining} to continue, or upgrade your plan.`,
      });
      return;
    }
    nextStep();
  };

  return (
    <FlowShell heading="Which AI Employees do you want to hire?" subtitle="You can select multiple. Configure them next." wide>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {EMPLOYEE_TEMPLATES.map((template) => {
          const selected = selectedTemplateKeys.includes(template.key);
          const pendingRoles = selectedTemplateKeys.filter((key) => key !== template.key);
          const blockedReason = selected ? null : reasonBlocked(template.key, pendingRoles);
          const disabled = Boolean(blockedReason);
          return (
            <button
              key={template.key}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => { toggleTemplateKey(template.key); clearError('employees'); }}
              className={`relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${disabled ? 'cursor-not-allowed opacity-40' : ''} ${selected ? 'border-violet-secondary/60 bg-violet/[0.1]' : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.16]'}`}
              title={blockedReason ?? undefined}
            >
              <CardCheckbox checked={selected} className="absolute right-3 top-3" />
              <EmployeeAvatar template={template} />
              <p className="text-sm font-semibold text-white">{template.name}</p>
              <p className="text-xs text-fg-muted">{template.description}</p>
              {blockedReason && <p className="text-[11px] text-amber-400">{blockedReason}</p>}
            </button>
          );
        })}
      </div>
      {errors.employees && <p className="mt-3 text-[13px] text-red-400">{errors.employees}</p>}
      <p className="mt-4 text-sm text-fg-muted">
        {selectedTemplateKeys.length} selected
        {remaining !== null &&
          ` · ${Math.max(0, remaining - selectedTemplateKeys.length)} more available on your plan`}
      </p>
      <StepFooter onBack={prevStep} onContinue={onContinue} />
    </FlowShell>
  );
}
