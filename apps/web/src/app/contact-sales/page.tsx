import { ShieldCheck, Building2, Users } from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { ContactSalesForm } from '@/components/marketing-dark/ContactSalesForm';
import { DarkHl, DarkKicker } from '@/components/marketing-dark/DarkSectionHeading';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export const metadata = buildMetadata({
  title: 'Contact Sales — Enterprise AI Workforce | Orlixa',
  description:
    'Talk to Orlixa sales about Enterprise plans: private deployment, custom AI Employees, SLAs, and dedicated support for your AI workforce.',
  path: '/contact-sales',
});

const REASONS = [
  { Icon: Building2, title: 'Enterprise deployment', body: 'Private or VPC deployment options and custom contracts.' },
  { Icon: Users, title: 'Unlimited AI Employees', body: 'No cap on how many roles or workflows your team runs.' },
  { Icon: ShieldCheck, title: 'Dedicated support & SLA', body: 'A dedicated account manager and an uptime guarantee.' },
];

export default function ContactSalesPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'Contact Sales', path: '/contact-sales' }])} />
      <DarkNav />

      <section className="relative overflow-hidden px-6 pb-4 pt-10 sm:pt-16">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <DarkKicker>Contact sales</DarkKicker>
          <h1 className="mx-auto mt-4 max-w-[22ch] text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            Let&apos;s build your <DarkHl>AI workforce</DarkHl> together
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            Tell us about your team, and we&apos;ll help you figure out which AI Employees, Skills
            and plan fit best.
          </p>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <FadeIn className="mx-auto grid max-w-[1000px] gap-10 px-6 lg:grid-cols-[1fr_1.3fr]">
          <div>
            <h2 className="text-xl font-bold text-white">Why teams talk to us</h2>
            <div className="mt-6 space-y-5">
              {REASONS.map(({ Icon, title, body }) => (
                <div key={title} className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet/15 text-violet-bright">
                    <Icon className="h-[18px] w-[18px]" aria-hidden strokeWidth={2} />
                  </span>
                  <div>
                    <p className="text-[15px] font-semibold text-white">{title}</p>
                    <p className="mt-1 text-sm text-fg-muted">{body}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-8 text-sm text-fg-muted">
              Prefer email? Reach us directly at{' '}
              <a href="mailto:sales@orlixa.io" className="text-violet-secondary underline-offset-4 hover:underline">
                sales@orlixa.io
              </a>
              .
            </p>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-void-card p-6 sm:p-8">
            <ContactSalesForm />
          </div>
        </FadeIn>
      </section>

      <SiteFooter />
    </div>
  );
}
