import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, CheckCircle2, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { DarkBreadcrumb } from '@/components/marketing-dark/DarkBreadcrumb';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { DarkHl } from '@/components/marketing-dark/DarkSectionHeading';
import { AI_EMPLOYEES, getAiEmployeeBySlug, relatedAiEmployees } from '@/features/marketing/ai-employees';
import { getIntegrationBySlug } from '@/features/marketing/integrations';
import { buildMetadata } from '@/lib/seo';

export function generateStaticParams() {
  return AI_EMPLOYEES.map((e) => ({ slug: e.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const employee = getAiEmployeeBySlug(params.slug);
  if (!employee) return {};
  return buildMetadata({
    title: `${employee.title} (${employee.name}) — AI Employee | Orlixa`,
    description: employee.tagline,
    path: `/ai-employees/${employee.slug}`,
  });
}

export default function AiEmployeeDetailPage({ params }: { params: { slug: string } }) {
  const employee = getAiEmployeeBySlug(params.slug);
  if (!employee) notFound();

  const skills = employee.suggestedSkillKeys
    .map((key) => getIntegrationBySlug(key))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  const related = relatedAiEmployees(employee.slug);

  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <DarkNav />
      <DarkBreadcrumb
        items={[
          { name: 'Home', path: '/' },
          { name: 'AI Employees', path: '/ai-employees' },
          { name: employee.title, path: `/ai-employees/${employee.slug}` },
        ]}
      />

      {/* Hero */}
      <section className="relative overflow-hidden px-6 pb-4 pt-8 sm:pt-12">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-zinc-300">
            {employee.category}
          </span>
          <h1 className="mx-auto mt-6 max-w-2xl text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            <DarkHl>{employee.title}</DarkHl>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            {employee.summary}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Link
              href="/register"
              className="rounded-full bg-violet px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_0_30px_-6px_rgba(94,60,232,0.6)] transition-transform hover:scale-[1.03] hover:bg-violet-hover"
            >
              Hire {employee.name}
            </Link>
            <Link
              href="/pricing"
              className="rounded-full border border-white/[0.12] bg-white/[0.04] px-6 py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.08]"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>

      {/* Responsibilities + Outcomes */}
      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <FadeIn className="mx-auto grid max-w-[1440px] gap-10 px-8 lg:grid-cols-2">
          <div>
            <h2 className="text-xl font-bold text-white">What {employee.name} does</h2>
            <ul className="mt-5 space-y-3">
              {employee.responsibilities.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[15px] text-zinc-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-secondary" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Business outcomes</h2>
            <ul className="mt-5 space-y-3">
              {employee.outcomes.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[15px] text-zinc-300">
                  <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-violet-secondary" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-void-card p-4 text-sm text-zinc-300">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-bright" aria-hidden />
              High-risk actions this role could take are routed to the Approval Center for a
              human to review before they execute.
            </div>
          </div>
        </FadeIn>
      </section>

      {/* Skills */}
      {skills.length > 0 && (
        <section className="border-t border-white/[0.06] py-16 sm:py-20">
          <FadeIn className="mx-auto max-w-[1440px] px-8">
            <h2 className="text-xl font-bold text-white">Skills &amp; integrations</h2>
            <p className="mt-2 max-w-lg text-sm text-fg-muted">
              {employee.name} typically connects to these tools once installed on your workspace.
            </p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {skills.map((skill) => (
                <Link
                  key={skill.slug}
                  href={`/integrations/${skill.slug}`}
                  className="group rounded-xl border border-white/[0.08] bg-void-card p-5 transition-colors hover:border-white/[0.16]"
                >
                  <p className="text-[15px] font-semibold text-white">{skill.name}</p>
                  <p className="mt-1 text-sm text-fg-muted">{skill.description}</p>
                  <span className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-violet-secondary group-hover:text-white">
                    View integration <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </span>
                </Link>
              ))}
            </div>
          </FadeIn>
        </section>
      )}

      {/* Example workflow */}
      {employee.exampleWorkflow && (
        <section className="border-t border-white/[0.06] py-16 sm:py-20">
          <FadeIn className="mx-auto max-w-[1440px] px-8">
            <h2 className="text-xl font-bold text-white">
              Example workflow: <DarkHl>{employee.exampleWorkflow.name}</DarkHl>
            </h2>
            <ol className="mt-6 space-y-3">
              {employee.exampleWorkflow.steps.map((step, i) => (
                <li key={step} className="flex items-start gap-3 text-[15px] text-zinc-300">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet/20 text-xs font-semibold text-violet-bright">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            <Link
              href="/automation"
              className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-violet-secondary hover:text-white"
            >
              See how the Workflow Builder works <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </FadeIn>
        </section>
      )}

      {/* Related employees */}
      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <FadeIn className="mx-auto max-w-[1440px] px-8">
          <h2 className="text-xl font-bold text-white">Other AI Employees</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {related.map((e) => (
              <Link
                key={e.slug}
                href={`/ai-employees/${e.slug}`}
                className="group rounded-xl border border-white/[0.08] bg-void-card p-5 transition-colors hover:border-violet/40"
              >
                <p className="text-[15px] font-semibold text-white">{e.title}</p>
                <p className="mt-1 text-sm text-fg-muted">{e.tagline}</p>
              </Link>
            ))}
          </div>
          <Link
            href="/ai-employees"
            className="mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-violet-secondary hover:text-white"
          >
            View all AI Employees <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </FadeIn>
      </section>

      <SiteFooter />
    </div>
  );
}
