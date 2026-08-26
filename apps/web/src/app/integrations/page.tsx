import Link from 'next/link';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { IntegrationsBrowser } from '@/components/marketing-dark/IntegrationsBrowser';
import { DarkHl, DarkKicker } from '@/components/marketing-dark/DarkSectionHeading';
import { INTEGRATIONS } from '@/features/marketing/integrations';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export const metadata = buildMetadata({
  title: 'Integrations — Connect your tools | Orlixa',
  description:
    'Every tool Orlixa AI Employees can connect to today — Slack, Gmail, HubSpot, Jira, Stripe, Google Drive, GitHub and more. Browse by category and see exactly what each integration can do.',
  path: '/integrations',
});

export default function IntegrationsPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'Integrations', path: '/integrations' }])} />
      <DarkNav />

      <section className="relative overflow-hidden px-6 pb-4 pt-10 sm:pt-16">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <DarkKicker>Integrations</DarkKicker>
          <h1 className="mx-auto mt-4 max-w-[22ch] text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            Connect with the <DarkHl>tools</DarkHl> you already use
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            Each integration below is a real, working Skill your AI Employees can be equipped
            with — not a roadmap item. Every action it takes is logged, and anything high-risk is
            routed to a human for approval first.
          </p>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-14 sm:py-16">
        <div className="mx-auto max-w-[1440px] px-8">
          <IntegrationsBrowser integrations={INTEGRATIONS} />
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <FadeIn className="mx-auto max-w-[1440px] px-8">
          <div className="rounded-dark-lg border border-violet/30 bg-violet/[0.06] px-8 py-14 text-center sm:px-16">
            <h2 className="text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
              Put these tools to work in a <DarkHl>Workflow</DarkHl>
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-zinc-400">
              Chain an AI Employee, a Skill, and a condition together — triggered on a schedule,
              an event, or on demand.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <Link
                href="/ai-employees"
                className="rounded-full border border-white/[0.14] px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.06]"
              >
                Browse AI Employees
              </Link>
              <Link
                href="/automation"
                className="rounded-full bg-violet px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-violet-hover"
              >
                See how workflows work
              </Link>
            </div>
          </div>
        </FadeIn>
      </section>

      <SiteFooter />
    </div>
  );
}
