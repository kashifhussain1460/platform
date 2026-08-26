import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter, Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';
// React Flow base styles for the Workflow Builder canvas (doc 29 §3.B). Global
// third-party stylesheet — must load in the root layout, not a client component.
import '@xyflow/react/dist/style.css';
import { Providers } from './providers';
import { MotionFlag } from '@/components/system/MotionFlag';
import { SITE_URL } from '@/lib/seo';
import { JsonLd, organizationSchema, websiteSchema } from '@/lib/jsonld';

// Self-hosted at build time (no runtime request to fonts.googleapis.com) —
// exposed as a CSS variable and opted into ONLY by the dark marketing
// sections (see `font-marketing` in globals.css). The rest of the app keeps
// the Workforce Ledger system-font stack on purpose.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

// Workflow Builder faces (doc 29). Space Grotesk = display (node/employee names,
// panel titles); JetBrains Mono = literals ({{templates}}, ids, config values).
// Opted into via `font-display`/`font-mono` in the builder only.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
  display: 'swap',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

// No `title.template` here on purpose: existing pages (pricing, demo) already
// spell out their own full "X — Orlixa" title, and a template would double
// the suffix. Each page's own `metadata`/`buildMetadata()` call owns its full
// title string.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Orlixa — Build your AI workforce',
  description:
    'Orlixa is the AI Workforce Platform — hire managed AI Employees, equip them with Skills, brief them with your Knowledge, chain them into Workflows, and gate every risky move behind human Approvals.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <JsonLd data={organizationSchema()} />
        <JsonLd data={websiteSchema()} />
        <MotionFlag />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
