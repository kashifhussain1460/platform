/**
 * Careers/job listings.
 *
 * There is no jobs/ATS data source anywhere in this codebase today. Per the
 * scope for this page, we do not invent open positions to fill the list —
 * `JOBS` stays empty until a real posting exists. The `/careers` page shows
 * an honest "no open roles right now" state instead of fake listings, and
 * `/careers/[slug]` correctly 404s for any slug because none are real.
 */

export interface JobPosting {
  slug: string;
  title: string;
  department: string;
  location: string;
  employmentType: string;
  description: string;
  responsibilities: string[];
  requirements: string[];
}

export const JOBS: JobPosting[] = [];

export function getJobBySlug(slug: string): JobPosting | undefined {
  return JOBS.find((j) => j.slug === slug);
}
