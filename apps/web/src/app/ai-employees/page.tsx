import Link from 'next/link';
import {
  ArrowRight,
  ShieldCheck,
  Workflow,
  Plug,
  UserSearch,
  TrendingUp,
  Headset,
  Users,
  Calculator,
  ClipboardList,
  Megaphone,
  ShoppingCart,
  Settings,
  Scale,
} from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { DarkSectionHeading, DarkHl, DarkKicker } from '@/components/marketing-dark/DarkSectionHeading';
import { AI_EMPLOYEES } from '@/features/marketing/ai-employees';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

const ROLE_ICONS: Record<string, typeof UserSearch> = {
  'recruit-ai': UserSearch,
  'sales-ai': TrendingUp,
  'support-ai': Headset,
  'hr-ai': Users,
  'finance-ai': Calculator,
  'pm-ai': ClipboardList,
  'marketing-ai': Megaphone,
  'procurement-ai': ShoppingCart,
  'operations-ai': Settings,
  'legal-ai': Scale,
};

export const metadata = buildMetadata({
  title: 'AI Employees — Hire an AI workforce | Orlixa',
  description:
    'Browse every AI Employee role Orlixa ships — recruiting, sales, support, HR, finance, project management, marketing, procurement, operations and legal. Each one comes with skills, workflows and human approval built in.',
  path: '/ai-employees',
});

const WHY = [
  {
    Icon: Plug,
    title: 'Connected to your tools',
    body: 'Each AI Employee can be equipped with Skills — Slack, email, HubSpot, Jira, Google Drive and more — so it works where your team already works.',
  },
  {
    Icon: Workflow,
    title: 'Chained into workflows',
    body: 'Combine AI Employees, triggers and conditions into multi-step Workflows that run on a schedule, an event, or on demand.',
  },
  {
    Icon: ShieldCheck,
    title: 'Human approval on risky actions',
    body: 'High-risk actions — moving money, publishing content — are automatically routed to the Approval Center before they execute.',
  },
];

export default function AiEmployeesPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'AI Employees', path: '/ai-employees' }])} />
      <DarkNav />

      <section className="relative overflow-hidden px-6 pb-4 pt-10 sm:pt-16">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <DarkKicker>AI Employees</DarkKicker>
          <h1 className="mx-auto mt-4 max-w-[22ch] text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            Hire AI employees for <DarkHl>every business function</DarkHl>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            An AI Employee is a managed AI worker with a role, a memory, and a set of tools it&apos;s
            allowed to use. Brief it with your Knowledge, equip it with Skills, and put it to work in
            a Workflow — with a human always able to review the risky parts.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Link
              href="/register"
              className="rounded-full bg-violet px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_0_30px_-6px_rgba(94,60,232,0.6)] transition-transform hover:scale-[1.03] hover:bg-violet-hover"
            >
              Hire an AI Employee
            </Link>
            <Link
              href="/demo"
              className="rounded-full border border-white/[0.12] bg-white/[0.04] px-6 py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.08]"
            >
              Watch the demo
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <div className="mx-auto max-w-[1440px] px-8">
          <div className="grid gap-5 sm:grid-cols-3">
            {WHY.map(({ Icon, title, body }, i) => (
              <FadeIn key={title} delay={i * 0.08} className="rounded-xl border border-white/[0.08] bg-void-card p-6">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet/15 text-violet-bright">
                  <Icon className="h-[18px] w-[18px]" aria-hidden strokeWidth={2} />
                </span>
                <h2 className="mt-4 text-[15px] font-semibold text-white">{title}</h2>
                <p className="mt-1.5 text-sm text-fg-muted">{body}</p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <div className="mx-auto max-w-[1440px] px-8">
          <DarkSectionHeading kicker="The roster">
            Every role, <DarkHl>ready to hire</DarkHl>
          </DarkSectionHeading>

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AI_EMPLOYEES.map((employee, i) => {
              const Icon = ROLE_ICONS[employee.slug] ?? Users;
              return (
                <FadeIn key={employee.slug} delay={(i % 6) * 0.06}>
                  <Link
                    href={`/ai-employees/${employee.slug}`}
                    className="group flex h-full flex-col rounded-xl border border-white/[0.08] bg-void-card p-6 transition-colors hover:border-violet/40"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet/15 text-violet-bright">
                      <Icon className="h-[18px] w-[18px]" aria-hidden strokeWidth={2} />
                    </span>
                    <span className="mt-3.5 text-xs font-semibold uppercase tracking-[0.1em] text-violet-secondary">
                      {employee.category}
                    </span>
                    <h3 className="mt-2 text-lg font-bold text-white">{employee.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-fg-muted">{employee.tagline}</p>
                    <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-violet-secondary group-hover:text-white">
                      See what {employee.name} does
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  </Link>
                </FadeIn>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <FadeIn className="mx-auto max-w-[1440px] px-8">
          <div className="rounded-dark-lg border border-violet/30 bg-violet/[0.06] px-8 py-14 text-center sm:px-16">
            <h2 className="text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
              Equip them with <DarkHl>Skills</DarkHl> and put them in a <DarkHl>Workflow</DarkHl>
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-zinc-400">
              See the tools every AI Employee can connect to, or explore how Workflows chain them
              together with triggers, conditions and human approval.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <Link
                href="/integrations"
                className="rounded-full border border-white/[0.14] px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.06]"
              >
                Browse integrations
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
