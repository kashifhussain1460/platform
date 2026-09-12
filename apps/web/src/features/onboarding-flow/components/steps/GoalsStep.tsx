'use client';

import { GOALS } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import { CardCheckbox } from '../CardCheckbox';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function GoalsStep() {
  const { state, dispatch, nextStep, prevStep, setErrors } = useOnboardingFlow();

  const onContinue = () => {
    if (state.goals.length === 0) {
      setErrors({ goals: 'Choose at least one goal so we can tailor your setup.' });
      return;
    }
    nextStep();
  };

  return (
    <FlowShell heading="What are your main goals?" subtitle="Select all that apply.">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {GOALS.map((goal) => {
          const selected = state.goals.includes(goal.key);
          return (
            <button
              key={goal.key}
              type="button"
              onClick={() => {
                dispatch({ type: 'TOGGLE_GOAL', key: goal.key });
                dispatch({ type: 'CLEAR_ERROR', field: 'goals' });
              }}
              aria-pressed={selected}
              className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-4 text-left text-sm font-medium transition-colors ${
                selected
                  ? 'border-violet-secondary/60 bg-violet/[0.1] text-white'
                  : 'border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:border-white/[0.16]'
              }`}
            >
              {goal.label}
              <CardCheckbox checked={selected} className="mt-0.5" />
            </button>
          );
        })}
      </div>
      {state.errors.goals && (
        <p className="mt-3 text-[13px] text-red-400">{state.errors.goals}</p>
      )}

      <StepFooter onBack={prevStep} onContinue={onContinue} />
    </FlowShell>
  );
}
