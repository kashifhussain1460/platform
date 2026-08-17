import { UserSearch, TrendingUp, Headset, Calculator, Users, ClipboardList, Megaphone, Plus } from 'lucide-react';
import { DarkSectionHeading, DarkHl } from './DarkSectionHeading';

const ROLES = [
  { Icon: UserSearch, title: 'AI Recruiter', body: 'Screen candidates 24/7 and shortlist the best.' },
  { Icon: TrendingUp, title: 'AI Sales', body: 'Find leads, engage and close deals on autopilot.' },
  { Icon: Headset, title: 'AI Support', body: 'Resolve customer issues instantly and intelligently.' },
  { Icon: Calculator, title: 'AI Accountant', body: 'Automate bookkeeping, invoices and reports.' },
  { Icon: Users, title: 'AI HR', body: 'Handle employee queries and HR processes.' },
  { Icon: ClipboardList, title: 'AI Project Manager', body: 'Track tasks, timelines and keep teams aligned.' },
  { Icon: Megaphone, title: 'AI Marketing', body: 'Create content, run campaigns and analyze.' },
];

/** "AI Employees" — one card per role, plus a "More Roles" CTA card. */
export function AiEmployeesGrid() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-28">
      <div className="mx-auto max-w-[1440px] px-8">
        <DarkSectionHeading kicker="AI Employees">
          Hire AI employees for <DarkHl>every business function</DarkHl>
        </DarkSectionHeading>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ROLES.map(({ Icon, title, body }) => (
            <div
              key={title}
              className="rounded-xl border border-white/[0.08] bg-void-card p-5 transition-colors hover:border-white/[0.16]"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet/15 text-violet-bright">
                <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
              </span>
              <p className="mt-3.5 text-[15px] font-semibold text-white">{title}</p>
              <p className="mt-1 text-sm text-fg-muted">{body}</p>
            </div>
          ))}

          <a
            href="/register"
            className="rounded-xl border border-violet/30 bg-violet/10 p-5 transition-colors hover:border-violet/50"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet/20 text-violet-bright">
              <Plus className="h-[18px] w-[18px]" strokeWidth={2} />
            </span>
            <p className="mt-3.5 text-[15px] font-semibold text-violet-secondary">More Roles</p>
            <p className="mt-1 text-sm text-zinc-400">Explore all AI employees in the marketplace.</p>
          </a>
        </div>

        <div className="mt-10 text-center">
          <a href="#" className="text-sm font-medium text-violet-secondary hover:text-white">
            View all AI employees →
          </a>
        </div>
      </div>
    </section>
  );
}
