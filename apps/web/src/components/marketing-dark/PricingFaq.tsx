import { ChevronDown } from 'lucide-react';

/**
 * The three questions people actually ask before paying, answered without
 * hedging. `<details>` rather than a JS accordion: it opens with the keyboard,
 * survives a page find (Ctrl+F reaches closed text in modern browsers), and
 * needs no client bundle for a list that only expands.
 */
const FAQS = [
  {
    q: 'Can I change my plan later?',
    a: 'Yes. Move up or down whenever you like, from Billing in your workspace. Moving up takes effect immediately and we charge the difference for the rest of the period; moving down takes effect at your next renewal, so you keep what you have already paid for.',
  },
  {
    q: 'What happens after my trial ends?',
    a: 'Nothing is charged automatically and nothing is deleted. Your AI Employees stop taking new work until you pick a plan, and everything you built — workflows, knowledge, run history — is waiting where you left it.',
  },
  {
    q: 'Do you offer refunds?',
    a: 'Yes, within 14 days of a payment, for any reason. Email support and we will process it — no call, and no questions about why.',
  },
];

export function PricingFaq() {
  return (
    <section className="mx-auto max-w-[820px] px-6 py-20 sm:py-24">
      <h2 className="text-center text-2xl font-bold text-white sm:text-[28px]">
        Frequently Asked Questions
      </h2>

      <div className="mt-8 space-y-3">
        {FAQS.map(({ q, a }) => (
          <details
            key={q}
            className="group rounded-xl border border-white/[0.08] bg-void-card open:bg-void-card-hover"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-secondary">
              {q}
              <ChevronDown
                className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180"
                aria-hidden
              />
            </summary>
            <p className="px-5 pb-5 text-[15px] leading-relaxed text-zinc-400">{a}</p>
          </details>
        ))}
      </div>

      <p className="mt-10 text-center text-sm text-zinc-400">
        Still have questions?{' '}
        <a
          href="mailto:sales@orlixa.io"
          className="font-medium text-violet-secondary underline-offset-4 hover:underline"
        >
          Contact our sales team
        </a>
      </p>
    </section>
  );
}
