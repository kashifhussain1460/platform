import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo';

/**
 * Disallows the authenticated app shell (route group `(app)` — dashboard,
 * workflow builder, billing, etc: all auth-gated, tenant-specific, and of no
 * value to a crawler). `/login` and `/register` are left crawlable — they are
 * public conversion pages, not tenant data.
 */
const DISALLOWED = [
  '/dashboard',
  '/employees',
  '/workflows',
  '/skills',
  '/knowledge',
  '/marketplace',
  '/billing',
  '/team',
  '/organization',
  '/approvals',
  '/runs',
  '/schedules',
  '/scheduling',
  '/assist',
  '/onboarding',
  '/admin',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/account-locked',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: DISALLOWED,
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
