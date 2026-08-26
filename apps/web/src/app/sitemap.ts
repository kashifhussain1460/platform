import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo';
import { AI_EMPLOYEES } from '@/features/marketing/ai-employees';
import { INTEGRATIONS } from '@/features/marketing/integrations';
import { JOBS } from '@/features/marketing/careers';

const STATIC_PATHS = [
  '/',
  '/ai-employees',
  '/automation',
  '/integrations',
  '/pricing',
  '/security',
  '/about',
  '/careers',
  '/privacy-policy',
  '/terms-of-service',
  '/contact-sales',
  '/demo',
];

export default function sitemap(): MetadataRoute.Sitemap {
  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : 0.7,
  }));

  const employeeEntries: MetadataRoute.Sitemap = AI_EMPLOYEES.map((e) => ({
    url: `${SITE_URL}/ai-employees/${e.slug}`,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  const integrationEntries: MetadataRoute.Sitemap = INTEGRATIONS.map((i) => ({
    url: `${SITE_URL}/integrations/${i.slug}`,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  const jobEntries: MetadataRoute.Sitemap = JOBS.map((j) => ({
    url: `${SITE_URL}/careers/${j.slug}`,
    changeFrequency: 'weekly',
    priority: 0.5,
  }));

  return [...staticEntries, ...employeeEntries, ...integrationEntries, ...jobEntries];
}
