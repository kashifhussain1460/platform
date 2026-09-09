'use client';

import { Check } from 'lucide-react';
import type { Plan } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useChangePlan, usePlans, useSubscription } from '../hooks';
import { changeLabel, formatPrice } from '../labels';

/** Plan catalog cards with a per-plan Upgrade/Change action (optimistic). */
export function PlanCatalog() {
  const { data: plans, isLoading } = usePlans();
  const { data: subscription } = useSubscription();
  const changePlan = useChangePlan();

  if (isLoading || !plans) {
    return <p className="text-sm text-app-ink-3">Loading plans…</p>;
  }

  const current = subscription?.plan;
  const pendingPlan = changePlan.isPending
    ? (changePlan.variables?.plan as Plan | undefined)
    : undefined;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {plans.map((plan) => {
        const isCurrent = current === plan.plan;
        const label = current ? changeLabel(current, plan.plan) : 'Choose';
        return (
          <div
            key={plan.plan}
            className={`relative flex flex-col rounded-2xl border p-5 transition-colors ${
              isCurrent
                ? 'border-violet/60 bg-violet/[0.06] shadow-[0_0_40px_-12px_rgba(94,60,232,0.6)]'
                : 'border-app-border bg-app-surface hover:border-app-border-strong'
            }`}
          >
            {isCurrent && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet px-3 py-1 text-xs font-semibold text-white">
                Current
              </span>
            )}

            <h3 className="text-lg font-bold text-app-ink">{plan.name}</h3>
            <p className="mt-2 text-2xl font-bold text-app-ink">
              {formatPrice(plan.priceMonthlyUsd)}
              {plan.priceMonthlyUsd !== null && plan.priceMonthlyUsd > 0 && (
                <span className="text-sm font-normal text-app-ink-2"> /mo</span>
              )}
            </p>
            {/* Role-based hiring: a plan buys N roles x M each, and a per-employee
                monthly credit ceiling. Say all three, because "2 AI employees" alone
                hides the rule the hire form will enforce. */}
            <p className="mt-1 text-xs text-app-ink-2">
              {plan.maxRoles === null || plan.maxPerRole === null
                ? 'Unlimited AI employees and roles'
                : `${plan.maxEmployees} AI employees - any ${plan.maxRoles} roles, ${plan.maxPerRole} each`}
            </p>
            {plan.creditsPerEmployeePerMonth !== null && (
              <p className="mt-0.5 text-xs text-app-ink-3">
                Up to {plan.creditsPerEmployeePerMonth.toLocaleString()} credits per employee / month
              </p>
            )}

            <ul className="mt-4 flex-1 space-y-2 text-sm text-app-ink-2">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet" strokeWidth={2.5} />
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <Button
              className="mt-5 w-full"
              variant="violet"
              disabled={isCurrent || changePlan.isPending}
              onClick={() => changePlan.mutate({ plan: plan.plan })}
            >
              {pendingPlan === plan.plan ? 'Switching…' : label}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
