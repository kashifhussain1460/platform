import {
  LayoutDashboard,
  Users,
  Workflow,
  BookOpen,
  Plug,
  BarChart3,
  Settings,
} from 'lucide-react';

const NAV_ITEMS = [
  { label: 'Dashboard', Icon: LayoutDashboard, active: true },
  { label: 'AI Employees', Icon: Users },
  { label: 'Workflows', Icon: Workflow },
  { label: 'Knowledge', Icon: BookOpen },
  { label: 'Integrations', Icon: Plug },
  { label: 'Analytics', Icon: BarChart3 },
  { label: 'Settings', Icon: Settings },
];

interface EmployeeRow {
  name: string;
  task: string;
  initials: string;
  ring: string;
}

const EMPLOYEES: EmployeeRow[] = [
  // `violet/30` is the heaviest tint of the four, so `secondary` drops to 3.68
  // on it while the amber/sky/emerald siblings clear AA on their /20.
  { name: 'AI Recruiter', task: 'Screening candidates', initials: 'AR', ring: 'bg-violet/30 text-violet-bright' },
  { name: 'AI Sales Executive', task: 'Following up with leads', initials: 'SE', ring: 'bg-amber-400/20 text-amber-300' },
  { name: 'AI Support Agent', task: 'Answering tickets', initials: 'SA', ring: 'bg-sky-400/20 text-sky-300' },
  { name: 'AI Accountant', task: 'Processing invoices', initials: 'AC', ring: 'bg-emerald-400/20 text-emerald-300' },
];

/** Sparkline built from a fixed point set — decorative, no chart lib needed. */
function Sparkline() {
  return (
    <svg viewBox="0 0 160 40" className="mt-3 h-10 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline
        points="0,30 20,26 40,29 60,18 80,22 100,10 120,14 140,4 160,8"
        fill="none"
        stroke="#8B6EF2"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The product screenshot mockup — sidebar + AI-employee list + stat cards. */
export function DashboardMock() {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] gap-4 rounded-2xl border border-white/[0.08] bg-void-card p-4 shadow-dark-card sm:p-5">
      {/* Sidebar */}
      <nav className="hidden w-36 shrink-0 flex-col gap-1 sm:flex">
        {NAV_ITEMS.map(({ label, Icon, active }) => (
          <div
            key={label}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium ${
              active ? 'bg-violet text-white' : 'text-zinc-400'
            }`}
          >
            <Icon className="h-4 w-4" strokeWidth={2} />
            {label}
          </div>
        ))}
      </nav>

      {/* AI Employees list */}
      <div className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <p className="text-sm font-semibold text-white">AI Employees</p>
        <ul className="mt-3 space-y-2">
          {EMPLOYEES.map((e) => (
            <li
              key={e.name}
              className="flex items-center gap-3 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2.5"
            >
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${e.ring}`}>
                {e.initials}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-white">{e.name}</p>
                <p className="truncate text-xs text-fg-muted">{e.task}</p>
              </div>
              <span className="shrink-0 rounded-full bg-emerald-400/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400">
                Active
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Stat cards */}
      <div className="hidden w-40 shrink-0 flex-col gap-3 md:flex">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <p className="text-xs text-fg-muted">Tasks Completed</p>
          <p className="mt-1.5 text-2xl font-bold text-white">1,248</p>
          <p className="mt-1 text-xs font-medium text-emerald-400">+18.6%</p>
          <Sparkline />
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-baseline justify-between">
            <p className="text-xs text-fg-muted">Success Rate</p>
            <p className="text-xs font-medium text-emerald-400">+3.2%</p>
          </div>
          <p className="mt-1.5 text-2xl font-bold text-white">98.6%</p>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full w-[98.6%] rounded-full bg-emerald-400" />
          </div>
        </div>
      </div>
    </div>
  );
}
