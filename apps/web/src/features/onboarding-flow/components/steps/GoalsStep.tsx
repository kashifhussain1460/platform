'use client';

import { useState, useEffect } from 'react';
import { useOnboardingStatus, useSaveOnboardingGoals } from '@/features/onboarding/hooks';
import { GOALS } from '../../mockData';
import { useOnboardingWizardStore } from '../../wizardStore';
import { CardCheckbox } from '../CardCheckbox';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function GoalsStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);
  const setErrors = useOnboardingWizardStore((s) => s.setErrors);
  const errors = useOnboardingWizardStore((s) => s.errors);
  const clearError = useOnboardingWizardStore((s) => s.clearError);

  const { data: status } = useOnboardingStatus();
  const saveGoals = useSaveOnboardingGoals();
  const [selected, setSelected] = useState<string[]>([]);
  // Visible failure feedback (Tasks 10-13's recurring lesson): there is no
  // global mutation error handler, so a failed save must surface here or the
  // Continue button just re-enables with nothing having happened.
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (status?.goals) setSelected(status.goals);
  }, [status?.goals]);

  const toggle = (key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((g) => g !== key) : [...prev, key]));
    clearError('goals');
  };

  const onContinue = () => {
    if (selected.length === 0) {
      setErrors({ goals: 'Choose at least one goal so we can tailor your setup.' });
      return;
    }
    setActionError(null);
    saveGoals.mutate(selected, {
      onSuccess: () => nextStep(),
      onError: (err) => setActionError(err.message || "Couldn't save your goals."),
    });
  };

  return (
    <FlowShell heading="What are your main goals?" subtitle="Select all that apply.">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {GOALS.map((goal) => {
          const isSelected = selected.includes(goal.key);
          return (
            <button
              key={goal.key}
              type="button"
              onClick={() => toggle(goal.key)}
              aria-pressed={isSelected}
              className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-4 text-left text-sm font-medium transition-colors ${
                isSelected ? 'border-violet-secondary/60 bg-violet/[0.1] text-white' : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16]'
              }`}
            >
              {goal.label}
              <CardCheckbox checked={isSelected} className="mt-0.5" />
            </button>
          );
        })}
      </div>
      {errors.goals && <p className="mt-3 text-[13px] text-red-400">{errors.goals}</p>}
      {actionError && (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {actionError}
        </p>
      )}
      <StepFooter onBack={prevStep} onContinue={onContinue} continueDisabled={saveGoals.isPending} />
    </FlowShell>
  );
}
