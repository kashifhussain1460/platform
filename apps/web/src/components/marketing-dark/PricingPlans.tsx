'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Briefcase, Building2, CheckCircle2, Rocket, Star, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  MARKETING_PLANS,
  priceFor,
  type MarketingPlan,
  type PlanIcon,
} from '@/features/marketing/plans';

const ICONS: Record<PlanIcon, typeof Rocket> = {
  rocket: Rocket,
  team: Users,
  briefcase: Briefcase,
  building: Building2,
};

/**
 * The plan grid, with the billing period as the one control on the page.
 *
 * Yearly is selected first because it is the cheaper of the two — showing the
 * higher number first and making people hunt for the discount is a small
 * dishonesty. The monthly rate stays visible, struck through, so the saving is
 * something you can see rather than something the badge claims.
 */
export function PricingPlans() {
  const [yearly, setYearly] = useState(true);

  return (
    <div className="mx-auto max-w-[1200px] px-6">
      <BillingToggle yearly={yearly} onChange={setYearly} />

      <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
        {MARKETING_PLANS.map((plan) => (
          <PlanCard key={plan.key} plan={plan} yearly={yearly} />
        ))}
      </div>
    </div>
  );
}

function BillingToggle({
  yearly,
  onChange,
}: {
  yearly: boolean;
  onChange: (yearly: boolean) => void;
}) {
  return (
    <div
      className="flex justify-center"
      role="group"
      aria-label="Billing period"
    >
      <div className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-void-card p-1">
        <button
          type="button"
          onClick={() => onChange(false)}
          aria-pressed={!yearly}
          className={cn(
            'rounded-full px-5 py-2 text-sm font-medium transition-colors',
            yearly ? 'text-zinc-400 hover:text-white' : 'bg-white/[0.08] text-white',
          )}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => onChange(true)}
          aria-pressed={yearly}
          className={cn(
            'flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors',
            yearly ? 'bg-violet text-white' : 'text-zinc-400 hover:text-white',
          )}
        >
          Yearly
          <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">
            Save 20%
          </span>
        </button>
      </div>
    </div>
  );
}

function PlanCard({ plan, yearly }: { plan: MarketingPlan; yearly: boolean }) {
  const Icon = ICONS[plan.icon];
  const price = priceFor(plan, yearly);
  const showsStrikethrough =
    yearly && plan.monthlyUsd != null && plan.monthlyUsd !== plan.yearlyMonthlyUsd;

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl border p-6',
        plan.popular
          ? 'border-violet/60 bg-violet/[0.05] shadow-[0_0_60px_-18px_rgba(94,60,232,0.75)]'
          : 'border-white/[0.08] bg-void-card',
      )}
    >
      {plan.popular && (
        <span className="absolute -top-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-violet px-3 py-1 text-xs font-semibold text-white">
          <Star className="h-3 w-3 fill-current" aria-hidden />
          Most Popular
        </span>
      )}

      <span
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-xl',
          plan.popular ? 'bg-violet/20 text-violet-bright' : 'bg-white/[0.06] text-zinc-300',
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>

      <h2 className="mt-5 text-xl font-bold text-white">{plan.name}</h2>
      {/* Two lines' worth of room whether the blurb needs it or not, so the
          prices and the buttons sit on the same line across all four cards.
          Ragged buttons make a price list look like four separate offers. */}
      <p className="mt-1 min-h-[2.5rem] text-sm text-zinc-400">{plan.blurb}</p>

      <p className="mt-6 flex items-baseline gap-1.5">
        <span className="text-4xl font-bold tracking-tight text-white">
          {price == null ? 'Custom' : `$${price}`}
        </span>
        <span className="text-sm text-fg-muted">
          {price == null ? '' : plan.key === 'free' ? '/forever' : '/month'}
        </span>
      </p>
      <p className="mt-1 h-5 text-sm text-fg-muted">
        {price == null ? (
          'Contact sales for pricing'
        ) : showsStrikethrough ? (
          <>
            Billed yearly <span className="line-through">${plan.monthlyUsd}</span>
          </>
        ) : null}
      </p>

      <Link
        href={plan.ctaHref}
        className={cn(
          'mt-6 inline-flex items-center justify-center rounded-xl py-3 text-sm font-semibold transition-colors',
          plan.popular
            ? 'bg-violet text-white hover:bg-violet-hover'
            : 'border border-white/[0.14] text-white hover:bg-white/[0.06]',
        )}
      >
        {plan.cta}
      </Link>

      <p className="mt-7 text-sm font-medium text-violet-secondary">{plan.featuresLabel}</p>
      <ul className="mt-4 space-y-3">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5 text-sm text-zinc-300">
            <CheckCircle2
              className="mt-0.5 h-4 w-4 shrink-0 text-violet-secondary"
              aria-hidden
            />
            {feature}
          </li>
        ))}
      </ul>
    </div>
  );
}
