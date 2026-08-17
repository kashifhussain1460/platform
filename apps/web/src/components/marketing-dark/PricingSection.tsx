'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MARKETING_PLANS, priceFor } from '@/features/marketing/plans';
import { DarkSectionHeading, DarkHl } from './DarkSectionHeading';

/**
 * Pricing — Monthly/Annual toggle + 4 plan cards (Business highlighted).
 *
 * The plans come from `features/marketing/plans.ts`, the same list the /pricing
 * page renders. They used to be written out here as well and had drifted: this
 * section sold "Pro $99" while the pricing page sold "Business $99", so which
 * one a visitor believed depended on where they landed.
 *
 * This is the SHORT version — the top four features per plan. The full list,
 * the FAQ and the trial terms live on /pricing.
 */
export function PricingSection() {
  const [annual, setAnnual] = useState(true);

  return (
    <section id="pricing" className="border-t border-white/[0.06] py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-8">
        <DarkSectionHeading kicker="Pricing">
          Simple, transparent pricing that <DarkHl>scales with you</DarkHl>
        </DarkSectionHeading>

        {/* billing toggle */}
        <div className="mt-8 flex justify-center">
          <div className="inline-flex items-center rounded-full border border-white/[0.08] bg-void-card p-1">
            <button
              type="button"
              onClick={() => setAnnual(false)}
              className={cn(
                'rounded-full px-5 py-1.5 text-sm font-medium transition-colors',
                !annual ? 'bg-white/[0.08] text-white' : 'text-zinc-400 hover:text-white',
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setAnnual(true)}
              className={cn(
                'rounded-full px-5 py-1.5 text-sm font-medium transition-colors',
                annual ? 'bg-violet text-white' : 'text-zinc-400 hover:text-white',
              )}
            >
              Annual (Save 20%)
            </button>
          </div>
        </div>

        {/* plan cards */}
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {MARKETING_PLANS.map((plan) => {
            const amount = priceFor(plan, annual);
            const price = amount == null ? 'Custom' : `$${amount}`;
            return (
              <div
                key={plan.name}
                className={cn(
                  'relative flex flex-col rounded-2xl border p-6',
                  plan.popular
                    ? 'border-violet/60 bg-violet/[0.06] shadow-[0_0_40px_-12px_rgba(94,60,232,0.6)]'
                    : 'border-white/[0.08] bg-void-card',
                )}
              >
                {plan.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet px-3 py-1 text-xs font-semibold text-white">
                    Popular
                  </span>
                )}
                <p className="text-[15px] font-semibold text-white">{plan.name}</p>
                <p className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-white">{price}</span>
                  {amount != null && <span className="text-sm text-fg-muted">/mo</span>}
                </p>
                <p className="mt-2 text-sm text-fg-muted">{plan.blurb}</p>

                {/* Four, not all of them — the full list is the job of /pricing. */}
                <ul className="mt-6 space-y-3">
                  {plan.features.slice(0, 4).map((f) => (
                    <li key={f} className="flex items-center gap-2.5 text-sm text-zinc-300">
                      <Check className="h-4 w-4 shrink-0 text-violet-secondary" strokeWidth={2.5} />
                      {f}
                    </li>
                  ))}
                </ul>

                <Link
                  href={plan.ctaHref}
                  className={cn(
                    'mt-8 inline-flex items-center justify-center rounded-full py-2.5 text-sm font-semibold transition-all',
                    plan.popular
                      ? 'bg-violet text-white hover:bg-violet-hover'
                      : 'border border-white/[0.12] text-white hover:bg-white/[0.06]',
                  )}
                >
                  {plan.cta}
                </Link>
              </div>
            );
          })}
        </div>

        <p className="mt-10 text-center text-sm text-fg-muted">
          <Link href="/pricing" className="font-medium text-violet-secondary hover:text-white">
            Compare every plan
          </Link>{' '}
          — full feature lists, trial terms and refunds.
        </p>
      </div>
    </section>
  );
}
