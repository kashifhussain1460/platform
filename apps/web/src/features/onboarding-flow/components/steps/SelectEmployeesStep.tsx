'use client';

import { Minus, Plus } from 'lucide-react';
import { useEmployees } from '@/features/employees/hooks';
import { EMPLOYEE_TEMPLATES } from '../../mockData';
import { useSeatAvailability } from '@/features/product-context/hooks';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function SelectEmployeesStep() {
  const selectedTemplateKeys = useOnboardingWizardStore((s) => s.selectedTemplateKeys);
  const incrementRole = useOnboardingWizardStore((s) => s.incrementRole);
  const decrementRole = useOnboardingWizardStore((s) => s.decrementRole);
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const employeeOrder = useOnboardingWizardStore((s) => s.employeeOrder);
  const pushEmployeeId = useOnboardingWizardStore((s) => s.pushEmployeeId);
  const setActiveEmployee = useOnboardingWizardStore((s) => s.setActiveEmployee);
  const setErrors = useOnboardingWizardStore((s) => s.setErrors);
  const errors = useOnboardingWizardStore((s) => s.errors);
  const clearError = useOnboardingWizardStore((s) => s.clearError);
  const { seats, reasonBlocked } = useSeatAvailability();
  const { data: existingEmployees = [] } = useEmployees();

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
      // Live-discovered dead end (fixed here): a company already at its
      // plan's full seat/per-role cap has EVERY card greyed out — there is
      // no new role left to pick, ever, so requiring a fresh selection here
      // made this screen a permanent wall with no way forward for a company
      // just revisiting to check on AI Employees it already has. If real
      // employees already exist, there's nothing NEW to configure — bring
      // them into the wizard's roster (Review's tabs need `employeeOrder`
      // populated) and skip straight to Review instead of erroring.
      if (existingEmployees.length > 0) {
        existingEmployees.forEach((e) => {
          if (!employeeOrder.includes(e.id)) pushEmployeeId(e.id);
        });
        setActiveEmployee(existingEmployees[0].id);
        goToStep('review');
        return;
      }
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
    <FlowShell heading="Which AI Employees do you want to hire?" subtitle="You can select multiple — and more than one of the same role, if your plan allows it." wide>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {EMPLOYEE_TEMPLATES.map((template) => {
          // A MULTISET count, not a boolean — the plan's own `maxPerRole` can
          // allow more than one of the same role (Growth: "any 2 roles, 2
          // each"), and this screen previously had no way to select the same
          // role twice at all, making that advertised capacity unreachable in
          // a single pass through the wizard.
          const pendingCount = selectedTemplateKeys.filter((k) => k === template.key).length;
          // Employees of this role already hired from a PREVIOUS pass through
          // the wizard (`(app)/layout.tsx` explicitly supports revisiting to
          // hire more later). The stepper used to display `pendingCount`
          // alone, so a returning company with 1 Support AI already hired saw
          // "0" here with no visible sign the role was already in use — the
          // real count only ever surfaced as fine print once you tried (and
          // failed) to add another. Show the honest total instead.
          const existingCount = seats?.perRole.find((r) => r.role === template.key)?.used ?? 0;
          const displayCount = existingCount + pendingCount;
          const selected = displayCount > 0;
          // Checked against the FULL current selection (including this
          // role's own existing count) — answers "if I add one more of this
          // role on top of everything already picked, would that exceed the
          // plan?"
          const incrementBlockedReason = reasonBlocked(template.key, selectedTemplateKeys);
          const canIncrement = !incrementBlockedReason;
          return (
            <div
              key={template.key}
              className={`relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${
                selected ? 'border-violet-secondary/60 bg-violet/[0.1]' : 'border-white/[0.08] bg-white/[0.02]'
              }`}
            >
              <EmployeeAvatar template={template} />
              <p className="text-sm font-semibold text-white">{template.name}</p>
              <p className="text-xs text-fg-muted">{template.description}</p>

              <div className="mt-2 flex w-full items-center justify-between rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1.5">
                <button
                  type="button"
                  disabled={pendingCount === 0}
                  aria-label={`Remove one ${template.name}`}
                  onClick={() => {
                    decrementRole(template.key);
                    clearError('employees');
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-300 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="text-sm font-semibold text-white">{displayCount}</span>
                <button
                  type="button"
                  disabled={!canIncrement}
                  aria-label={`Add one ${template.name}`}
                  title={incrementBlockedReason ?? undefined}
                  onClick={() => {
                    incrementRole(template.key);
                    clearError('employees');
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-300 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {existingCount > 0 && (
                <p className="text-[11px] text-fg-muted">
                  {existingCount} already hired{pendingCount > 0 ? ` · adding ${pendingCount} more` : ''}
                </p>
              )}
              {incrementBlockedReason && (
                <p className="text-[11px] text-amber-400">{incrementBlockedReason}</p>
              )}
            </div>
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
