'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import type { Plan } from '@vaep/types';
import { useChangePlan, usePlans, useSubscription } from '@/features/billing/hooks';
import { formatPrice } from '@/features/billing/labels';
import { useOnboardingWizardStore } from '../../wizardStore';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

export function PlanStep() {
  const nextStep = useOnboardingWizardStore((s) => s.nextStep);
  const prevStep = useOnboardingWizardStore((s) => s.prevStep);

  const { data: plans = [], isLoading } = usePlans();
  const { data: subscription } = useSubscription();
  const changePlan = useChangePlan();
  // Billing cycle is display-only here — ChangePlanDto has no cycle concept,
  // and PlanDto only carries a monthly price, so nothing about this toggle
  // is persisted.
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  // Visible failure feedback (Tasks 10-13's recurring lesson): there is no
  // global mutation error handler, so a failed plan change must surface here
  // or the button just re-enables with nothing having happened.
  const [actionError, setActionError] = useState<string | null>(null);

  const currentPlan = subscription?.plan;
  const pendingPlan = changePlan.isPending
    ? (changePlan.variables?.plan as Plan | undefined)
    : undefined;

  const onSelectPlan = (plan: Plan) => {
    setActionError(null);
    changePlan.mutate(
      { plan },
      {
        onSuccess: (data) => {
          // useChangePlan already redirects the browser to Stripe checkout
          // internally when data.checkoutUrl is set (see billing/hooks.ts) —
          // don't also advance the wizard in that case. Only move forward for
          // the immediate (mock provider / no checkout) path.
          if (!data.checkoutUrl) nextStep();
        },
        onError: (err) => setActionError(err.message || "Couldn't change your plan."),
      },
    );
  };

  return (
    <FlowShell heading="Choose your plan" subtitle="Start with a plan that fits your needs." wide>
      {actionError && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {actionError}
        </p>
      )}
      <div className="mb-6 flex items-center justify-center gap-2">
        <div className="inline-flex rounded-xl border border-white/[0.1] bg-white/[0.02] p-1">
          {(['monthly', 'yearly'] as const).map((cycle) => (
            <button
              key={cycle}
              type="button"
              onClick={() => setBillingCycle(cycle)}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                billingCycle === cycle
                  ? 'bg-violet text-white'
                  : 'text-zinc-300 hover:text-white'
              }`}
            >
              {cycle === 'monthly' ? 'Monthly' : 'Yearly'}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="text-center text-sm text-fg-muted">Loading plans…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((plan) => {
            const selected = currentPlan === plan.plan;
            const isCustom = plan.priceMonthlyUsd === null;
            const displayPrice =
              plan.priceMonthlyUsd === null
                ? null
                : billingCycle === 'yearly'
                  ? plan.priceMonthlyUsd * 12
                  : plan.priceMonthlyUsd;

            // Marketing chrome, not backend data — mirrors where "Most Popular"
            // sat in the old mock (BUSINESS/"Growth"). Client-derived flag off
            // the stable Plan enum, same technique PlanCatalog.tsx uses for
            // `isCurrent`.
            const isPopular = plan.plan === 'BUSINESS';

            return (
              <div
                key={plan.plan}
                className={`relative flex flex-col rounded-2xl border p-5 ${
                  selected
                    ? 'border-violet-secondary/60 bg-violet/[0.08]'
                    : 'border-white/[0.08] bg-white/[0.02]'
                }`}
              >
                {isPopular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet px-2.5 py-0.5 text-[10px] font-semibold text-white">
                    Most Popular
                  </span>
                )}
                <p className="text-sm font-semibold text-white">{plan.name}</p>
                <p className="mt-2 text-2xl font-bold text-white">
                  {formatPrice(displayPrice)}
                  {!isCustom && (
                    <span className="text-sm font-normal text-fg-muted">
                      {billingCycle === 'yearly' ? '/yr' : '/mo'}
                    </span>
                  )}
                </p>
                <p className="mt-2 text-xs text-fg-muted">
                  {plan.maxRoles === null || plan.maxPerRole === null
                    ? 'Unlimited AI employees and roles'
                    : `${plan.maxEmployees} AI employees — any ${plan.maxRoles} roles, ${plan.maxPerRole} each`}
                </p>
                <ul className="mt-4 flex-1 space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs text-zinc-300">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      {f}
                    </li>
                  ))}
                </ul>
                {isCustom ? (
                  // Enterprise is custom-priced and always rejected by the
                  // billing API (a real 400 every time) — this used to fire
                  // that doomed request on click. A mailto to the real sales
                  // address (the same one contact-sales/pricing pages use) is
                  // what "Contact us" should have been from the start.
                  <a
                    href={`mailto:sales@orlixa.io?subject=${encodeURIComponent('Enterprise plan enquiry')}`}
                    className="mt-5 block rounded-xl border border-white/[0.1] px-4 py-2 text-center text-sm font-medium text-zinc-300 transition-colors hover:border-white/[0.2]"
                  >
                    Contact us
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled={selected || changePlan.isPending}
                    onClick={() => onSelectPlan(plan.plan)}
                    className={`mt-5 rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      selected
                        ? 'bg-violet text-white'
                        : 'border border-white/[0.1] text-zinc-300 hover:border-white/[0.2]'
                    }`}
                  >
                    {selected ? 'Current plan' : pendingPlan === plan.plan ? 'Selecting…' : 'Select'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <StepFooter onBack={prevStep} onContinue={nextStep} continueDisabled={changePlan.isPending} />
    </FlowShell>
  );
}
