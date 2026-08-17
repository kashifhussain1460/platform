import Link from 'next/link';
import { UserPlus, Wrench, Workflow, TrendingUp } from 'lucide-react';
import { DarkSectionHeading, DarkHl } from './DarkSectionHeading';

const STEPS = [
  {
    n: 1,
    Icon: UserPlus,
    title: 'Hire',
    body: 'Choose an AI employee from our marketplace or create your own.',
  },
  {
    n: 2,
    Icon: Wrench,
    title: 'Train',
    body: 'Connect your tools and upload knowledge to train them.',
  },
  {
    n: 3,
    Icon: Workflow,
    title: 'Automate',
    body: 'Build workflows and set goals. Your AI employee gets to work.',
  },
  {
    n: 4,
    Icon: TrendingUp,
    title: 'Scale',
    body: 'Monitor performance and scale your AI workforce.',
  },
];

/** "How it works" — 4-step process on a connected horizontal spine. */
export function HowItWorks() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-8">
        <DarkSectionHeading kicker="How it works">
          From hire to impact in <DarkHl>4 simple steps</DarkHl>
        </DarkSectionHeading>

        <div className="relative mt-16 grid grid-cols-2 gap-x-6 gap-y-12 lg:grid-cols-4">
          <div
            aria-hidden
            className="absolute left-0 right-0 top-6 hidden h-px bg-white/[0.1] lg:block"
            style={{ marginInline: '12.5%' }}
          />
          {STEPS.map(({ n, Icon, title, body }) => (
            <div key={n} className="relative flex flex-col items-center text-center">
              <span className="relative z-10 flex h-12 w-12 items-center justify-center rounded-full bg-violet text-white shadow-[0_0_0_6px_theme(colors.void.DEFAULT)]">
                <Icon className="h-5 w-5" strokeWidth={2} />
              </span>
              <p className="mt-4 text-[15px] font-semibold text-white">
                {n} {title}
              </p>
              <p className="mt-1.5 max-w-[220px] text-sm text-fg-muted">{body}</p>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-wrap justify-center gap-4">
          <Link
            href="/register"
            className="rounded-full bg-violet px-6 py-3 text-[15px] font-semibold text-white transition-transform hover:scale-[1.03] hover:bg-violet-hover"
          >
            Explore All AI Employees
          </Link>
          <Link
            href="/demo"
            className="rounded-full border border-white/[0.12] bg-white/[0.04] px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-white/[0.08]"
          >
            Watch the Full Demo
          </Link>
        </div>
      </div>
    </section>
  );
}
