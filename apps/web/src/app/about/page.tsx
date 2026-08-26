import Link from 'next/link';
import { Target, Users2, ShieldCheck, Sparkles } from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { DarkSectionHeading, DarkHl, DarkKicker } from '@/components/marketing-dark/DarkSectionHeading';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export const metadata = buildMetadata({
  title: 'About Orlixa — The AI Workforce Platform',
  description:
    'Orlixa is the AI Workforce Platform: hire managed AI Employees, connect them to your tools, and automate work through workflows that keep a human in control of anything risky.',
  path: '/about',
});

const VALUES = [
  {
    Icon: Target,
    title: 'Work gets done, not just automated',
    body: 'An AI Employee is judged the way any employee is: by the outcomes it delivers, grounded in your knowledge and your criteria — not by how impressive the automation looks.',
  },
  {
    Icon: ShieldCheck,
    title: 'Control before scale',
    body: 'We gate anything risky behind human approval before we let it run at scale. Trust is earned action by action, not assumed on day one.',
  },
  {
    Icon: Users2,
    title: 'Built for real teams',
    body: 'Every AI Employee, Skill and Workflow we ship is built against real business functions — recruiting, sales, support, HR, finance and more — not hypothetical ones.',
  },
];

export default function AboutPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'About', path: '/about' }])} />
      <DarkNav />

      <section className="relative overflow-hidden px-6 pb-4 pt-10 sm:pt-16">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <DarkKicker>About Orlixa</DarkKicker>
          <h1 className="mx-auto mt-4 max-w-[22ch] text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            Building the <DarkHl>AI workforce</DarkHl> companies actually need
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            Orlixa is the AI Workforce Platform: hire managed AI Employees, equip them with
            Skills, brief them with your Knowledge, chain them into Workflows, and gate every
            risky move behind human Approvals.
          </p>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <FadeIn className="mx-auto max-w-[1440px] px-8">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <DarkKicker>Why we exist</DarkKicker>
              <h2 className="mt-3 text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
                Software that <DarkHl>does</DarkHl> the work, not just tracks it
              </h2>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-zinc-400">
                Most business software helps a person do their job faster. Orlixa hires an AI
                Employee to do parts of the job directly — screening a resume, drafting a reply,
                chasing a status update — while keeping a human in charge of anything that matters.
              </p>
            </div>
            <div>
              <DarkKicker>How it fits together</DarkKicker>
              <h2 className="mt-3 text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
                Employees, <DarkHl>Skills</DarkHl>, Knowledge, Workflows
              </h2>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-zinc-400">
                An AI Employee is briefed with your company&apos;s Knowledge, equipped with Skills
                that connect to your tools, and put to work inside Workflows — multi-step
                processes with triggers, conditions, and approval gates.
              </p>
            </div>
          </div>
        </FadeIn>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <div className="mx-auto max-w-[1440px] px-8">
          <DarkSectionHeading kicker="What we believe">
            The <DarkHl>principles</DarkHl> behind the product
          </DarkSectionHeading>
          <div className="mt-14 grid gap-5 sm:grid-cols-3">
            {VALUES.map(({ Icon, title, body }, i) => (
              <FadeIn key={title} delay={i * 0.08} className="rounded-xl border border-white/[0.08] bg-void-card p-6">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet/15 text-violet-bright">
                  <Icon className="h-[18px] w-[18px]" aria-hidden strokeWidth={2} />
                </span>
                <h3 className="mt-4 text-[15px] font-semibold text-white">{title}</h3>
                <p className="mt-1.5 text-sm text-fg-muted">{body}</p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <FadeIn className="mx-auto max-w-[1440px] px-8">
          <div className="rounded-dark-lg border border-violet/30 bg-violet/[0.06] px-8 py-14 text-center sm:px-16">
            <Sparkles className="mx-auto h-8 w-8 text-violet-bright" aria-hidden />
            <h2 className="mt-4 text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
              Come build the <DarkHl>AI workforce</DarkHl> with us
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-zinc-400">
              Whether you&apos;re hiring your first AI Employee or hiring your next teammate,
              we&apos;d like to talk to you.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <Link
                href="/careers"
                className="rounded-full bg-violet px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-violet-hover"
              >
                View careers
              </Link>
              <Link
                href="/contact-sales"
                className="rounded-full border border-white/[0.14] px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.06]"
              >
                Talk to sales
              </Link>
            </div>
          </div>
        </FadeIn>
      </section>

      <SiteFooter />
    </div>
  );
}
