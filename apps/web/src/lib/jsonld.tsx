import { SITE_URL, absoluteUrl } from './seo';

/**
 * JSON-LD is emitted as a plain `<script type="application/ld+json">`. All
 * inputs here are our own static marketing content (never user input), so
 * `dangerouslySetInnerHTML` carries no injection risk — the `</script>`
 * escape below is defense-in-depth only, in case a copy string ever contains
 * that substring.
 */
export function JsonLd({ data }: { data: object }) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

export function organizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Orlixa',
    url: SITE_URL,
    logo: absoluteUrl('/orlixa-mark.png'),
    description:
      'Orlixa is the AI Workforce Platform — hire managed AI Employees, equip them with Skills, brief them with your Knowledge, chain them into Workflows, and gate every risky move behind human Approvals.',
    sameAs: [],
  };
}

export function websiteSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Orlixa',
    url: SITE_URL,
  };
}

export function softwareApplicationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Orlixa',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description:
      'Orlixa is the AI Workforce Platform for hiring managed AI Employees, connecting them to your tools, and automating work through governed, human-approved workflows.',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  };
}

export function breadcrumbSchema(items: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function faqPageSchema(faqs: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}
