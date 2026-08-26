import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { TableOfContents } from '@/components/marketing-dark/TableOfContents';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export const metadata = buildMetadata({
  title: 'Privacy Policy | Orlixa',
  description: 'How Orlixa collects, uses, and protects your information.',
  path: '/privacy-policy',
});

const LAST_UPDATED = 'August 18, 2026';

const TOC = [
  { id: 'introduction', label: '1. Introduction' },
  { id: 'information-we-collect', label: '2. Information we collect' },
  { id: 'how-we-use-information', label: '3. How we use information' },
  { id: 'how-we-share-information', label: '4. How we share information' },
  { id: 'data-security', label: '5. Data security' },
  { id: 'data-retention', label: '6. Data retention' },
  { id: 'your-choices', label: '7. Your choices' },
  { id: 'changes', label: '8. Changes to this policy' },
  { id: 'contact', label: '9. Contact us' },
];

export default function PrivacyPolicyPage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'Privacy Policy', path: '/privacy-policy' }])} />
      <DarkNav />

      <main className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
        <h1 className="text-[32px] font-bold leading-tight tracking-tight text-white sm:text-[40px]">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-fg-muted">Last updated: {LAST_UPDATED}</p>

        <div className="mt-10 grid gap-10 lg:grid-cols-[220px_1fr]">
          <TableOfContents items={TOC} />

          <div className="prose-invert space-y-8 text-[15px] leading-relaxed text-zinc-300">
            <section id="introduction">
              <h2 className="text-lg font-semibold text-white">1. Introduction</h2>
              <p className="mt-3">
                This Privacy Policy describes how Orlixa (&quot;Orlixa&quot;, &quot;we&quot;, &quot;us&quot;) collects, uses,
                and shares information when you use our website and the Orlixa AI Workforce
                Platform (together, the &quot;Service&quot;). It applies to visitors of our marketing site
                and to customers using the product.
              </p>
            </section>

            <section id="information-we-collect">
              <h2 className="text-lg font-semibold text-white">2. Information we collect</h2>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>
                  <strong className="text-white">Account information</strong> — name, work email,
                  company name, and password (stored as a salted hash, never in plain text) when you
                  register.
                </li>
                <li>
                  <strong className="text-white">Content you provide</strong> — knowledge documents,
                  workflow definitions, connected-tool configuration, and messages exchanged with an
                  AI Employee, so the Service can operate the way you&apos;ve configured it.
                </li>
                <li>
                  <strong className="text-white">Usage data</strong> — pages viewed, features used, and
                  basic device/browser information, used to operate and improve the Service.
                </li>
                <li>
                  <strong className="text-white">Connected-account credentials</strong> — where you
                  connect a third-party tool (e.g. Slack, Gmail, HubSpot), we store the access token
                  or credential needed to act on your behalf, encrypted at rest.
                </li>
              </ul>
            </section>

            <section id="how-we-use-information">
              <h2 className="text-lg font-semibold text-white">3. How we use information</h2>
              <p className="mt-3">We use the information above to:</p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>Provide, operate, and maintain the Service, including running your AI Employees and Workflows;</li>
                <li>Authenticate you and secure your account;</li>
                <li>Respond to support requests and communicate with you about the Service;</li>
                <li>Monitor and improve reliability, performance, and security;</li>
                <li>Comply with legal obligations.</li>
              </ul>
              <p className="mt-3">
                We do not sell your personal information, and we do not use the content of your
                workspace to train models shared across other customers.
              </p>
            </section>

            <section id="how-we-share-information">
              <h2 className="text-lg font-semibold text-white">4. How we share information</h2>
              <p className="mt-3">
                We share information with service providers who help us operate the Service (for
                example, cloud hosting and email delivery), and with third-party tools you choose to
                connect (so the connected action can actually happen). We do not share your
                workspace&apos;s data with other customers. We may disclose information if required by
                law or to protect the rights, property, or safety of Orlixa, our users, or the public.
              </p>
            </section>

            <section id="data-security">
              <h2 className="text-lg font-semibold text-white">5. Data security</h2>
              <p className="mt-3">
                We apply tenant isolation, role-based access control, and encryption at rest for
                sensitive fields (including connected-account credentials). No method of
                transmission or storage is 100% secure, and we cannot guarantee absolute security.
                See our <a href="/security" className="text-violet-secondary underline-offset-4 hover:underline">Security page</a> for
                more detail on what&apos;s actually implemented.
              </p>
            </section>

            <section id="data-retention">
              <h2 className="text-lg font-semibold text-white">6. Data retention</h2>
              <p className="mt-3">
                We retain account and workspace information for as long as your account is active,
                and for a reasonable period afterward to comply with legal obligations, resolve
                disputes, and enforce our agreements. You may request deletion of your account data
                by contacting us.
              </p>
            </section>

            <section id="your-choices">
              <h2 className="text-lg font-semibold text-white">7. Your choices</h2>
              <p className="mt-3">
                You can access, correct, or request deletion of your personal information by
                contacting us at the address below. You can disconnect a third-party tool at any
                time from your workspace settings, which stops Orlixa from acting on your behalf
                through that tool.
              </p>
            </section>

            <section id="changes">
              <h2 className="text-lg font-semibold text-white">8. Changes to this policy</h2>
              <p className="mt-3">
                We may update this policy from time to time. We will update the &quot;Last updated&quot;
                date above when we do, and material changes will be communicated to active
                customers.
              </p>
            </section>

            <section id="contact">
              <h2 className="text-lg font-semibold text-white">9. Contact us</h2>
              <p className="mt-3">
                Questions about this policy? Email{' '}
                <a href="mailto:privacy@orlixa.io" className="text-violet-secondary underline-offset-4 hover:underline">
                  privacy@orlixa.io
                </a>
                .
              </p>
            </section>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
