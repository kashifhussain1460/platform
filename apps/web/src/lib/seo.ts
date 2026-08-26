import type { Metadata } from 'next';

/**
 * Canonical site origin for absolute URLs (OG/Twitter images, canonical link,
 * JSON-LD `url` fields). `NEXT_PUBLIC_SITE_URL` lets a preview/staging deploy
 * override it; production falls back to the real domain.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://orlixa.io').replace(/\/$/, '');

export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

const DEFAULT_OG_IMAGE = '/orlixa-logo-horizontal.png';

/**
 * One call builds a complete, non-duplicated `Metadata` object for a public
 * page: title, description, canonical, Open Graph, and Twitter card. Every
 * marketing route should export `metadata` via this helper rather than a bare
 * object literal, so canonical/OG never silently drift from the route's real
 * path.
 */
export function buildMetadata({
  title,
  description,
  path,
  noindex = false,
  ogImage = DEFAULT_OG_IMAGE,
}: {
  title: string;
  description: string;
  path: string;
  noindex?: boolean;
  ogImage?: string;
}): Metadata {
  const url = absoluteUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: noindex ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: {
      title,
      description,
      url,
      siteName: 'Orlixa',
      type: 'website',
      images: [{ url: absoluteUrl(ogImage) }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [absoluteUrl(ogImage)],
    },
  };
}
