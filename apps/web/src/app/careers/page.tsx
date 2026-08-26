import { Mail } from 'lucide-react';
import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { HeroGlow } from '@/components/marketing-dark/HeroGlow';
import { FadeIn } from '@/components/marketing-dark/FadeIn';
import { DarkSectionHeading, DarkHl, DarkKicker } from '@/components/marketing-dark/DarkSectionHeading';
import { JOBS } from '@/features/marketing/careers';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export const metadata = buildMetadata({
  title: 'Careers — Work on the AI Workforce Platform | Orlixa',
  description:
    'Open roles at Orlixa, the AI Workforce Platform. No open positions right now? Reach out anyway — we keep every note on file for when a role opens.',
  path: '/careers',
});

export default function CareersPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'Careers', path: '/careers' }])} />
      <DarkNav />

      <section className="relative overflow-hidden px-6 pb-4 pt-10 sm:pt-16">
        <HeroGlow />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <DarkKicker>Careers</DarkKicker>
          <h1 className="mx-auto mt-4 max-w-[22ch] text-[40px] font-bold leading-[1.1] tracking-tight text-white sm:text-[52px]">
            Help build the <DarkHl>AI workforce</DarkHl>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            We&apos;re a small team building AI Employees, Skills and Workflows that real
            businesses put to work every day.
          </p>
        </div>
      </section>

      <section className="border-t border-white/[0.06] py-20 sm:py-28">
        <div className="mx-auto max-w-[1440px] px-8">
          <DarkSectionHeading kicker="Open roles">
            Current <DarkHl>openings</DarkHl>
          </DarkSectionHeading>

          {JOBS.length === 0 ? (
            <FadeIn className="mx-auto mt-12 max-w-xl rounded-2xl border border-white/[0.08] bg-void-card p-10 text-center">
              <p className="text-[15px] font-semibold text-white">No open roles right now</p>
              <p className="mt-2 text-sm text-fg-muted">
                We don&apos;t have a specific position open at the moment. If you think you&apos;d be a
                good fit for where we&apos;re headed, reach out — we keep every note on file for when
                a role opens.
              </p>
              <a
                href="mailto:careers@orlixa.io"
                className="mt-6 inline-flex items-center gap-2 rounded-full bg-violet px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-hover"
              >
                <Mail className="h-4 w-4" aria-hidden />
                Email careers@orlixa.io
              </a>
            </FadeIn>
          ) : (
            <div className="mt-12 space-y-3">
              {JOBS.map((job, i) => (
                <FadeIn key={job.slug} delay={(i % 8) * 0.05}>
                  <a
                    href={`/careers/${job.slug}`}
                    className="flex flex-col justify-between gap-2 rounded-xl border border-white/[0.08] bg-void-card p-5 transition-colors hover:border-violet/40 sm:flex-row sm:items-center"
                  >
                    <div>
                      <p className="text-[15px] font-semibold text-white">{job.title}</p>
                      <p className="mt-1 text-sm text-fg-muted">
                        {job.department} · {job.location} · {job.employmentType}
                      </p>
                    </div>
                  </a>
                </FadeIn>
              ))}
            </div>
          )}
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
