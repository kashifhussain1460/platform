import Link from 'next/link';
import {
  ShieldCheck,
  Lock,
  Users,
  FileClock,
  KeyRound,
  GitCommitHorizontal,
  Building2,
  Check,
} from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { DarkSectionHeading, DarkHl, DarkKicker } from '@/components/marketing-dark/DarkSectionHeading';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export const metadata = buildMetadata({
  title: 'Security — How Orlixa protects your data | Orlixa',
  description:
    'How Orlixa secures your workspace: tenant isolation, role-based access control, human approval on risky AI actions, encrypted credentials, and a full audit trail.',
  path: '/security',
});

const CAPABILITIES = [
  {
    Icon: Building2,
    title: 'Tenant isolation',
    body: 'Every company is a separate tenant. Data, AI Employees, workflows and knowledge are scoped to your workspace and never shared across tenants.',
  },
  {
    Icon: Users,
    title: 'Role-based access control',
    body: 'Users are assigned roles that govern what they can see and do, enforced on every request — not just hidden in the UI.',
  },
  {
    Icon: ShieldCheck,
    title: 'Human approval on risky actions',
    body: 'Actions the platform considers high-risk — moving money, publishing content publicly — are automatically routed to an Approval Center. A human approves, rejects, or modifies before anything executes.',
  },
  {
    Icon: KeyRound,
    title: 'Encrypted credentials',
    body: 'Connected-account credentials and other sensitive fields are encrypted at rest (AES-GCM), never stored or returned as plaintext.',
  },
  {
    Icon: FileClock,
    title: 'Full audit trail',
    body: 'Every skill execution and approval decision is logged, so you can see exactly what an AI Employee did, when, and who approved it.',
  },
  {
    Icon: GitCommitHorizontal,
    title: 'Resilient by design',
    body: 'Outbound calls to connected tools run behind rate limiting and circuit breakers, so a failing third party degrades gracefully instead of taking your workspace down with it.',
  },
];

const FAQS = [
  {
    q: 'Is Orlixa SOC 2 or ISO 27001 certified?',
    a: 'Not yet. Formal third-party compliance certification is on our roadmap. If your organization requires it before purchase, contact sales — we’ll walk through our current architecture and timeline.',
  },
  {
    q: 'Where is my data stored?',
    a: 'In the region your deployment is provisioned in. Enterprise plans support private/VPC deployment for organizations with residency requirements — contact sales to discuss your setup.',
  },
  {
    q: 'Can an AI Employee take an action without anyone knowing?',
    a: 'No. Every skill execution is recorded in an audit log, and anything flagged high-risk stops for a named human to approve before it runs.',
  },
];

export default function SecurityPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'Security', path: '/security' }])} />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FAQS.map(({ q, a }) => ({
            '@type': 'Question',
            name: q,
            acceptedAnswer: { '@type': 'Answer', text: a },
          })),
        }}
      />
      <DarkNav />

      <section className="relative overflow-hidden px-6 pb-4 pt-10 sm:pt-16">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <DarkKicker>Security</DarkKicker>
          <h1 className="mx-auto mt-4 max-w-[22ch] text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            Built for <DarkHl>enterprise control</DarkHl>, not just enterprise scale
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            An AI workforce needs guardrails a normal SaaS tool doesn&apos;t. Here&apos;s exactly what
            Orlixa does today — and what we&apos;re honest about not having yet.
          </p>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <div className="mx-auto max-w-[1440px] px-8">
          <DarkSectionHeading kicker="What's actually built">
            Security <DarkHl>capabilities</DarkHl>
          </DarkSectionHeading>
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map(({ Icon, title, body }, i) => (
              <FadeIn key={title} delay={(i % 6) * 0.06} className="rounded-xl border border-white/[0.08] bg-void-card p-6">
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
        <FadeIn className="mx-auto grid max-w-[1440px] items-start gap-10 px-8 lg:grid-cols-2">
          <div>
            <DarkKicker>Capability vs. certification</DarkKicker>
            <h2 className="mt-3 text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
              We distinguish the <DarkHl>two</DarkHl> on purpose
            </h2>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-zinc-400">
              A security <em>capability</em> is something the product actually does — like routing
              a payment action through human approval. A <em>certification</em> is an independent
              audit confirming a set of controls. We don&apos;t claim a certification we don&apos;t hold.
            </p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-void-card/70 p-6">
            <ul className="space-y-4">
              {[
                'Tenant isolation — capability, implemented',
                'Role-based access control — capability, implemented',
                'Human approval on high-risk actions — capability, implemented',
                'Encrypted credentials at rest — capability, implemented',
                'SOC 2 / ISO 27001 — certification, not yet held',
              ].map((g) => (
                <li key={g} className="flex items-center gap-3 text-[15px] text-zinc-200">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet/20 text-violet-bright">
                    <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                  </span>
                  {g}
                </li>
              ))}
            </ul>
          </div>
        </FadeIn>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-24">
        <FadeIn className="mx-auto max-w-[820px] px-6">
          <h2 className="text-center text-2xl font-bold text-white sm:text-[28px]">
            Security FAQ
          </h2>
          <div className="mt-8 space-y-3">
            {FAQS.map(({ q, a }) => (
              <details
                key={q}
                className="group rounded-xl border border-white/[0.08] bg-void-card open:bg-void-card-hover"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-secondary">
                  {q}
                </summary>
                <p className="px-5 pb-5 text-[15px] leading-relaxed text-zinc-400">{a}</p>
              </details>
            ))}
          </div>
        </FadeIn>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <FadeIn className="mx-auto max-w-[1440px] px-8">
          <div className="rounded-dark-lg border border-violet/30 bg-violet/[0.06] px-8 py-14 text-center sm:px-16">
            <Lock className="mx-auto h-8 w-8 text-violet-bright" aria-hidden />
            <h2 className="mt-4 text-[28px] font-bold leading-tight tracking-tight text-white sm:text-4xl">
              Need a security review for <DarkHl>procurement</DarkHl>?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-zinc-400">
              Talk to our team about deployment options, data residency, and our security
              roadmap.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <Link
                href="/contact-sales"
                className="rounded-full bg-violet px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-violet-hover"
              >
                Contact sales
              </Link>
              <Link
                href="/pricing"
                className="rounded-full border border-white/[0.14] px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.06]"
              >
                See Enterprise plan
              </Link>
            </div>
          </div>
        </FadeIn>
      </section>

      <SiteFooter />
    </div>
  );
}
