import type { Metadata } from 'next';
import { Tag } from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { DarkHl } from '@/components/marketing-dark/DarkSectionHeading';
import { PricingPlans } from '@/components/marketing-dark/PricingPlans';
import { PricingFaq } from '@/components/marketing-dark/PricingFaq';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';

export const metadata: Metadata = {
  title: 'Pricing — Orlixa',
  description:
    'Plans for individuals, small teams, growing departments and large organizations. Every plan includes the platform, workflow automation and the AI Employee marketplace.',
};

export default function PricingPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <DarkNav />

      <section className="px-6 pb-4 pt-10 sm:pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-zinc-300">
            <Tag className="h-3.5 w-3.5 text-violet-secondary" aria-hidden />
            Simple, transparent pricing
          </span>

          {/* Held narrower than the column so the line breaks after "that",
              keeping "fits your team." whole — the phrase is the promise. */}
          <h1 className="mx-auto mt-6 max-w-[21ch] text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            Choose the plan that fits <DarkHl>your team</DarkHl>.
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            All plans include the core platform, workflow automation, and access to our AI
            Employee marketplace.
          </p>
        </div>
      </section>

      <div className="pb-4 pt-8">
        <PricingPlans />
      </div>

      <PricingFaq />
      <SiteFooter />
    </div>
  );
}
