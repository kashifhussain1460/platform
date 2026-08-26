import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Mail } from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { DarkBreadcrumb } from '@/components/marketing-dark/DarkBreadcrumb';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { DarkHl } from '@/components/marketing-dark/DarkSectionHeading';
import { JOBS, getJobBySlug } from '@/features/marketing/careers';
import { buildMetadata, SITE_URL } from '@/lib/seo';
import { JsonLd } from '@/lib/jsonld';

export function generateStaticParams() {
  return JOBS.map((j) => ({ slug: j.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const job = getJobBySlug(params.slug);
  if (!job) return {};
  return buildMetadata({
    title: `${job.title} — Careers | Orlixa`,
    description: job.description,
    path: `/careers/${job.slug}`,
  });
}

/** Reusable job detail template. Renders nothing today — `JOBS` is empty — but
 * is ready the moment a real posting exists. */
export default function CareerDetailPage({ params }: { params: { slug: string } }) {
  const job = getJobBySlug(params.slug);
  if (!job) notFound();

  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'JobPosting',
          title: job.title,
          description: job.description,
          employmentType: job.employmentType,
          hiringOrganization: { '@type': 'Organization', name: 'Orlixa', sameAs: SITE_URL },
          jobLocation: { '@type': 'Place', address: job.location },
        }}
      />
      <DarkNav />
      <DarkBreadcrumb
        items={[
          { name: 'Home', path: '/' },
          { name: 'Careers', path: '/careers' },
          { name: job.title, path: `/careers/${job.slug}` },
        ]}
      />

      <section className="relative overflow-hidden px-6 pb-4 pt-8 sm:pt-12">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-zinc-300">
            {job.department} · {job.location} · {job.employmentType}
          </span>
          <h1 className="mx-auto mt-6 max-w-2xl text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            <DarkHl>{job.title}</DarkHl>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            {job.description}
          </p>
          <a
            href={`mailto:careers@orlixa.io?subject=${encodeURIComponent(`Application: ${job.title}`)}`}
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-violet px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_0_30px_-6px_rgba(94,60,232,0.6)] transition-transform hover:scale-[1.03] hover:bg-violet-hover"
          >
            <Mail className="h-4 w-4" aria-hidden />
            Apply for this role
          </a>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <FadeIn className="mx-auto grid max-w-[1440px] gap-10 px-8 lg:grid-cols-2">
          <div>
            <h2 className="text-xl font-bold text-white">Responsibilities</h2>
            <ul className="mt-5 space-y-3">
              {job.responsibilities.map((item) => (
                <li key={item} className="text-[15px] text-zinc-300">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Requirements</h2>
            <ul className="mt-5 space-y-3">
              {job.requirements.map((item) => (
                <li key={item} className="text-[15px] text-zinc-300">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </FadeIn>
      </section>

      <section className="border-t border-white/[0.06] py-16 sm:py-20">
        <div className="mx-auto max-w-[1440px] px-8 text-center">
          <Link href="/careers" className="text-sm font-medium text-violet-secondary hover:text-white">
            ← Back to all careers
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
