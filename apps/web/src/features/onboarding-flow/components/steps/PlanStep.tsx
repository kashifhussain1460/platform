'use client';

import { Check } from 'lucide-react';
import { PLANS, PLAN_PRICING_NOTE } from '../../mockData';
import { useOnboardingFlow } from '../../state';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function PlanStep() {
  const { state, dispatch, nextStep, prevStep } = useOnboardingFlow();

  return (
    <FlowShell heading="Choose your plan" subtitle="Start with a plan that fits your needs." wide>
      <div className="mb-6 flex items-center justify-center gap-2">
        <div className="inline-flex rounded-xl border border-white/[0.1] bg-white/[0.02] p-1">
          {(['monthly', 'yearly'] as const).map((cycle) => (
            <button
              key={cycle}
              type="button"
              onClick={() => dispatch({ type: 'SET_BILLING_CYCLE', cycle })}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                state.billingCycle === cycle
                  ? 'bg-violet text-white'
                  : 'text-zinc-300 hover:text-white'
              }`}
            >
              {cycle === 'monthly' ? 'Monthly' : 'Yearly'}
              {cycle === 'yearly' && (
                <span className="ml-1.5 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                  Save 20%
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((plan) => {
          const selected = state.planKey === plan.key;
          const price = state.billingCycle === 'monthly' ? plan.priceMonthly : plan.priceYearly;
          return (
            <div
              key={plan.key}
              className={`relative flex flex-col rounded-2xl border p-5 ${
                selected
                  ? 'border-violet-secondary/60 bg-violet/[0.08]'
                  : 'border-white/[0.08] bg-white/[0.02]'
              }`}
            >
              {plan.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet px-2.5 py-0.5 text-[10px] font-semibold text-white">
                  Most Popular
                </span>
              )}
              <p className="text-sm font-semibold text-white">{plan.displayName}</p>
              <p className="mt-2 text-2xl font-bold text-white">
                {plan.custom ? 'Custom' : `$${price}`}
                {!plan.custom && <span className="text-sm font-normal text-fg-muted">/mo</span>}
              </p>
              <p className="mt-2 text-xs text-fg-muted">{plan.blurb}</p>
              <ul className="mt-4 flex-1 space-y-2">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-zinc-300">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    {f}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => dispatch({ type: 'SET_PLAN', key: plan.key })}
                className={`mt-5 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                  selected
                    ? 'bg-violet text-white'
                    : 'border border-white/[0.1] text-zinc-300 hover:border-white/[0.2]'
                }`}
              >
                {selected ? 'Selected' : plan.custom ? 'Contact us' : 'Select'}
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-center text-[11px] text-fg-muted">{PLAN_PRICING_NOTE}</p>

      <StepFooter onBack={prevStep} onContinue={nextStep} />
    </FlowShell>
  );
}
