import Link from 'next/link';
import { Zap, Bot, Plug, GitBranch, ShieldCheck, PlayCircle, LineChart, Clock } from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { WorkflowDiagram } from '@/components/marketing-dark/WorkflowDiagram';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { DarkSectionHeading, DarkHl, DarkKicker } from '@/components/marketing-dark/DarkSectionHeading';
import { AUTOMATION_CATEGORIES } from '@/features/marketing/automation-categories';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export const metadata = buildMetadata({
  title: 'Workflow Automation — Chain AI Employees into workflows | Orlixa',
  description:
    'Build multi-step business automation with Orlixa Workflows: triggers, AI Employee steps, tool actions, conditions, approvals and monitoring — no code required.',
  path: '/automation',
});

const PIECES = [
  {
    Icon: Zap,
    title: 'Trigger',
    body: 'Start a workflow manually, on a schedule, on a webhook, or when an event fires — like a new email or a form submission.',
  },
  {
    Icon: Bot,
    title: 'AI Employee step',
    body: 'Hand a step to an AI Employee: it can retrieve knowledge, reason about the task, and produce a result.',
  },
  {
    Icon: Plug,
    title: 'Tool action',
    body: 'Call a real skill — send a Slack message, create a Jira issue, update a HubSpot deal — using an installed integration.',
  },
  {
    Icon: GitBranch,
    title: 'Conditions',
    body: 'Branch the workflow based on the result of a previous step, so different outcomes take different paths.',
  },
  {
    Icon: ShieldCheck,
    title: 'Human approval',
    body: 'Gate any step behind a human decision — approve, reject, or modify — before the workflow continues.',
  },
  {
    Icon: LineChart,
    title: 'Monitoring',
    body: 'Every run is logged step by step, so you can see exactly what happened, when, and why.',
  },
];

export default function AutomationPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'Workflows', path: '/automation' }])} />
      <DarkNav />

      <section className="relative overflow-hidden px-6 pb-4 pt-10 sm:pt-16">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <DarkKicker>Workflow automation</DarkKicker>
          <h1 className="mx-auto mt-4 max-w-[22ch] text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            Chain AI employees into <DarkHl>governed workflows</DarkHl>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            A Workflow links triggers, AI Employee steps, tool actions and conditions into one
            automated process — with human approval gating anything risky, and a full run log for
            everything that happens.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Link
              href="/register"
              className="rounded-full bg-violet px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_0_30px_-6px_rgba(94,60,232,0.6)] transition-transform hover:scale-[1.03] hover:bg-violet-hover"
            >
              Start building
            </Link>
            <Link
              href="/demo"
              className="flex items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.04] px-6 py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.08]"
            >
              <PlayCircle className="h-4 w-4" aria-hidden />
              Watch it in action
            </Link>
          </div>
        </div>

        <div className="relative z-10 mt-14">
          <WorkflowDiagram />
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <div className="mx-auto max-w-[1440px] px-8">
          <DarkSectionHeading kicker="Building blocks">
            Everything a <DarkHl>workflow</DarkHl> is made of
          </DarkSectionHeading>
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PIECES.map(({ Icon, title, body }, i) => (
              <FadeIn key={title} delay={(i % 6) * 0.06} className="rounded-xl border border-white/[0.08] bg-void-card p-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet/15 text-violet-bright">
                  <Icon className="h-[18px] w-[18px]" aria-hidden strokeWidth={2} />
                </span>
                <p className="mt-3.5 text-[15px] font-semibold text-white">{title}</p>
                <p className="mt-1 text-sm text-fg-muted">{body}</p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <div className="mx-auto max-w-[1440px] px-8">
          <DarkSectionHeading kicker="What people automate">
            Browse automation by <DarkHl>team</DarkHl>
          </DarkSectionHeading>
          <p className="mx-auto mt-4 max-w-xl text-center text-[15px] leading-relaxed text-zinc-400">
            HR and Marketing Automation are live today, each with 11 ready-to-use workflow
            templates. Every other team is on our roadmap.
          </p>
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AUTOMATION_CATEGORIES.map((category, i) =>
              category.available && category.href ? (
                <FadeIn key={category.name} delay={(i % 6) * 0.05}>
                  <Link
                    href={category.href}
                    className="group flex h-full flex-col rounded-xl border border-violet/30 bg-violet/[0.05] p-6 transition-colors hover:border-violet/60"
                  >
                    <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-violet/20 px-2.5 py-1 text-xs font-semibold text-violet-bright">
                      Available now
                    </span>
                    <p className="mt-3.5 text-[15px] font-semibold text-white">{category.name}</p>
                    <p className="mt-1.5 text-sm text-fg-muted">{category.description}</p>
                    <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-violet-secondary group-hover:text-white">
                      See it in action →
                    </span>
                  </Link>
                </FadeIn>
              ) : (
                <FadeIn key={category.name} delay={(i % 6) * 0.05}>
                  <div
                    aria-disabled="true"
                    className="flex h-full flex-col rounded-xl border border-white/[0.06] bg-void-card/50 p-6 opacity-60"
                  >
                    <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-xs font-semibold text-fg-muted">
                      <Clock className="h-3 w-3" aria-hidden />
                      Coming soon
                    </span>
                    <p className="mt-3.5 text-[15px] font-semibold text-zinc-400">{category.name}</p>
                    <p className="mt-1.5 text-sm text-fg-muted">{category.description}</p>
                  </div>
                </FadeIn>
              ),
            )}
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <FadeIn className="mx-auto max-w-[1440px] px-8">
          <div className="rounded-dark-lg border border-violet/30 bg-violet/[0.06] px-8 py-14 text-center sm:px-16">
            <h2 className="text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
              Ready to <DarkHl>automate</DarkHl> the next step?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-zinc-400">
              Hire an AI Employee, connect the tools it needs, and chain them into a workflow —
              all without writing code.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <Link
                href="/register"
                className="rounded-full bg-violet px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-violet-hover"
              >
                Get started free
              </Link>
              <Link
                href="/pricing"
                className="rounded-full border border-white/[0.14] px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.06]"
              >
                See pricing
              </Link>
            </div>
          </div>
        </FadeIn>
      </section>

      <SiteFooter />
    </div>
  );
}
