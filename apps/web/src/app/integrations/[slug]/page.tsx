import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, CheckCircle2, KeyRound, ShieldQuestion, Unplug } from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { DarkBreadcrumb } from '@/components/marketing-dark/DarkBreadcrumb';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { DarkHl } from '@/components/marketing-dark/DarkSectionHeading';
import { INTEGRATIONS, getIntegrationBySlug, relatedIntegrations, type ConnectionType } from '@/features/marketing/integrations';
import { employeesUsingSkill } from '@/features/marketing/ai-employees';
import { buildMetadata } from '@/lib/seo';

export function generateStaticParams() {
  return INTEGRATIONS.map((i) => ({ slug: i.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const integration = getIntegrationBySlug(params.slug);
  if (!integration) return {};
  return buildMetadata({
    title: `${integration.name} integration | Orlixa`,
    description: integration.description,
    path: `/integrations/${integration.slug}`,
  });
}

const CONNECTION_LABEL: Record<ConnectionType, { label: string; Icon: typeof KeyRound }> = {
  oauth: { label: 'Connect with OAuth — no API keys to manage', Icon: Unplug },
  api_key: { label: 'Connect with an API key or credentials', Icon: KeyRound },
  none: { label: 'Built-in capability — no external account to connect', Icon: ShieldQuestion },
};

export default function IntegrationDetailPage({ params }: { params: { slug: string } }) {
  const integration = getIntegrationBySlug(params.slug);
  if (!integration) notFound();

  const related = relatedIntegrations(integration.slug);
  const employees = employeesUsingSkill(integration.slug);
  const connection = CONNECTION_LABEL[integration.connectionType];

  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <DarkNav />
      <DarkBreadcrumb
        items={[
          { name: 'Home', path: '/' },
          { name: 'Integrations', path: '/integrations' },
          { name: integration.name, path: `/integrations/${integration.slug}` },
        ]}
      />

      <section className="relative overflow-hidden px-6 pb-4 pt-8 sm:pt-12">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-zinc-300">
            {integration.category}
          </span>
          <h1 className="mx-auto mt-6 max-w-2xl text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            <DarkHl>{integration.name}</DarkHl>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            {integration.description}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Link
              href="/register"
              className="rounded-full bg-violet px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_0_30px_-6px_rgba(94,60,232,0.6)] transition-transform hover:scale-[1.03] hover:bg-violet-hover"
            >
              Connect {integration.name}
            </Link>
            <Link
              href="/ai-employees"
              className="rounded-full border border-white/[0.12] bg-white/[0.04] px-6 py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.08]"
            >
              Browse AI Employees
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <FadeIn className="mx-auto grid max-w-[1440px] gap-10 px-8 lg:grid-cols-2">
          <div>
            <h2 className="text-xl font-bold text-white">What Orlixa can do with {integration.name}</h2>
            <ul className="mt-5 space-y-3">
              {integration.capabilities.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[15px] text-zinc-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-secondary" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">How it connects</h2>
            <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-void-card p-4 text-sm text-zinc-300">
              <connection.Icon className="mt-0.5 h-4 w-4 shrink-0 text-violet-bright" aria-hidden />
              {connection.label}
            </div>
            <p className="mt-4 text-sm text-fg-muted">
              Every action a skill takes is recorded in an audit log. Actions marked high-risk are
              held for a human to approve or reject before they run.
            </p>
          </div>
        </FadeIn>
      </section>

      {employees.length > 0 && (
        <section className="border-t border-white/[0.06] py-16 sm:py-20">
          <FadeIn className="mx-auto max-w-[1440px] px-8">
            <h2 className="text-xl font-bold text-white">AI Employees that use {integration.name}</h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {employees.map((employee) => (
                <Link
                  key={employee.slug}
                  href={`/ai-employees/${employee.slug}`}
                  className="group rounded-xl border border-white/[0.08] bg-void-card p-5 transition-colors hover:border-violet/40"
                >
                  <p className="text-[15px] font-semibold text-white">{employee.title}</p>
                  <p className="mt-1 text-sm text-fg-muted">{employee.tagline}</p>
                  <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-violet-secondary group-hover:text-white">
                    View role <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </span>
                </Link>
              ))}
            </div>
          </FadeIn>
        </section>
      )}

      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <FadeIn className="mx-auto max-w-[1440px] px-8">
          <h2 className="text-xl font-bold text-white">Other integrations</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {related.map((i) => (
              <Link
                key={i.slug}
                href={`/integrations/${i.slug}`}
                className="group rounded-xl border border-white/[0.08] bg-void-card p-5 transition-colors hover:border-violet/40"
              >
                <p className="text-[15px] font-semibold text-white">{i.name}</p>
                <p className="mt-1 text-sm text-fg-muted">{i.description}</p>
              </Link>
            ))}
          </div>
          <Link
            href="/integrations"
            className="mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-violet-secondary hover:text-white"
          >
            View all integrations <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </FadeIn>
      </section>

      <SiteFooter />
    </div>
  );
}
