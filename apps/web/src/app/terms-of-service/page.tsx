import { DarkNav } from '@/components/marketing-dark/DarkNav';
import { SiteFooter } from '@/components/marketing-dark/SiteFooter';
import { TableOfContents } from '@/components/marketing-dark/TableOfContents';
import { buildMetadata } from '@/lib/seo';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export const metadata = buildMetadata({
  title: 'Terms of Service | Orlixa',
  description: 'The terms that govern your use of the Orlixa AI Workforce Platform.',
  path: '/terms-of-service',
});

const LAST_UPDATED = 'August 18, 2026';

const TOC = [
  { id: 'agreement', label: '1. Agreement to terms' },
  { id: 'the-service', label: '2. The Service' },
  { id: 'accounts', label: '3. Accounts' },
  { id: 'acceptable-use', label: '4. Acceptable use' },
  { id: 'human-responsibility', label: '5. Human responsibility for AI actions' },
  { id: 'billing', label: '6. Subscriptions and billing' },
  { id: 'your-content', label: '7. Your content' },
  { id: 'termination', label: '8. Termination' },
  { id: 'disclaimers', label: '9. Disclaimers' },
  { id: 'liability', label: '10. Limitation of liability' },
  { id: 'changes', label: '11. Changes to these terms' },
  { id: 'contact', label: '12. Contact us' },
];

export default function TermsOfServicePage() {
  return (
    <div className="font-marketing min-h-screen overflow-x-hidden bg-dark-hero">
      <JsonLd data={breadcrumbSchema([{ name: 'Home', path: '/' }, { name: 'Terms of Service', path: '/terms-of-service' }])} />
      <DarkNav />

      <main className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
        <h1 className="text-[32px] font-bold leading-tight tracking-tight text-white sm:text-[40px]">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-fg-muted">Last updated: {LAST_UPDATED}</p>

        <div className="mt-10 grid gap-10 lg:grid-cols-[220px_1fr]">
          <TableOfContents items={TOC} />

          <div className="prose-invert space-y-8 text-[15px] leading-relaxed text-zinc-300">
            <section id="agreement">
              <h2 className="text-lg font-semibold text-white">1. Agreement to terms</h2>
              <p className="mt-3">
                These Terms of Service (&quot;Terms&quot;) govern your access to and use of the Orlixa
                website and the Orlixa AI Workforce Platform (together, the &quot;Service&quot;), operated
                by Orlixa (&quot;we&quot;, &quot;us&quot;). By creating an account or using the Service, you agree
                to these Terms. If you are using the Service on behalf of a company, you are
                agreeing on that company&apos;s behalf and confirm you have authority to do so.
              </p>
            </section>

            <section id="the-service">
              <h2 className="text-lg font-semibold text-white">2. The Service</h2>
              <p className="mt-3">
                Orlixa lets you create and configure &quot;AI Employees&quot; — AI-driven workers equipped
                with Skills (integrations), Knowledge, and Workflows — to perform tasks on your
                behalf. You control what tools an AI Employee can access and what actions require
                your approval before they execute.
              </p>
            </section>

            <section id="accounts">
              <h2 className="text-lg font-semibold text-white">3. Accounts</h2>
              <p className="mt-3">
                You are responsible for maintaining the confidentiality of your account credentials
                and for all activity under your account. You must provide accurate information when
                registering and keep it up to date.
              </p>
            </section>

            <section id="acceptable-use">
              <h2 className="text-lg font-semibold text-white">4. Acceptable use</h2>
              <p className="mt-3">You agree not to use the Service to:</p>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>Violate any applicable law or third party&apos;s rights;</li>
                <li>Configure an AI Employee to send unsolicited communications or engage in fraud, harassment, or deception;</li>
                <li>Attempt to gain unauthorized access to the Service, other accounts, or connected systems;</li>
                <li>Reverse-engineer, resell, or use the Service to build a competing product;</li>
                <li>Upload content you do not have the right to upload.</li>
              </ul>
            </section>

            <section id="human-responsibility">
              <h2 className="text-lg font-semibold text-white">5. Human responsibility for AI actions</h2>
              <p className="mt-3">
                You are responsible for the actions your AI Employees take, including the tools they
                are connected to and the approvals your team grants. High-risk actions are routed to
                your workspace&apos;s Approval Center — reviewing and deciding on those requests is your
                responsibility, not ours.
              </p>
            </section>

            <section id="billing">
              <h2 className="text-lg font-semibold text-white">6. Subscriptions and billing</h2>
              <p className="mt-3">
                Paid plans are billed in advance on the cadence shown at checkout. Prices and plan
                features are described on our{' '}
                <a href="/pricing" className="text-violet-secondary underline-offset-4 hover:underline">
                  Pricing
                </a>{' '}
                page and are subject to change with notice. You may cancel a paid plan at any time;
                cancellation takes effect at the end of the current billing period.
              </p>
            </section>

            <section id="your-content">
              <h2 className="text-lg font-semibold text-white">7. Your content</h2>
              <p className="mt-3">
                You retain ownership of the content you upload to the Service (knowledge documents,
                workflow definitions, and similar). You grant us a license to host, process, and
                display that content solely to provide the Service to you.
              </p>
            </section>

            <section id="termination">
              <h2 className="text-lg font-semibold text-white">8. Termination</h2>
              <p className="mt-3">
                You may stop using the Service and close your account at any time. We may suspend or
                terminate access if you materially violate these Terms. On termination, your right
                to use the Service ends; provisions that by their nature should survive
                (e.g. payment obligations, limitations of liability) will survive.
              </p>
            </section>

            <section id="disclaimers">
              <h2 className="text-lg font-semibold text-white">9. Disclaimers</h2>
              <p className="mt-3">
                The Service is provided &quot;as is&quot; without warranties of any kind, express or
                implied. We do not warrant that AI-generated output will be accurate, complete, or
                fit for a particular purpose — you are responsible for reviewing AI Employee output
                before relying on it, particularly for legal, medical, or financial decisions.
              </p>
            </section>

            <section id="liability">
              <h2 className="text-lg font-semibold text-white">10. Limitation of liability</h2>
              <p className="mt-3">
                To the fullest extent permitted by law, Orlixa will not be liable for indirect,
                incidental, special, consequential, or punitive damages arising from your use of the
                Service.
              </p>
            </section>

            <section id="changes">
              <h2 className="text-lg font-semibold text-white">11. Changes to these terms</h2>
              <p className="mt-3">
                We may update these Terms from time to time. We will update the &quot;Last updated&quot;
                date above when we do, and material changes will be communicated to active
                customers.
              </p>
            </section>

            <section id="contact">
              <h2 className="text-lg font-semibold text-white">12. Contact us</h2>
              <p className="mt-3">
                Questions about these Terms? Email{' '}
                <a href="mailto:legal@orlixa.io" className="text-violet-secondary underline-offset-4 hover:underline">
                  legal@orlixa.io
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
