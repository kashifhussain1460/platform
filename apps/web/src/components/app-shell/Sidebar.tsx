'use client';

import type { ElementType } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Building2,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  LayoutDashboard,
  ListChecks,
  ShoppingBag,
  Sparkles,
  Timer,
  UsersRound,
  WandSparkles,
  Workflow,
  Users,
} from 'lucide-react';
import { OrlixaMark } from '@/components/marketing-dark/OrlixaMark';
import { useAllRuns } from '@/features/workflows/hooks';

interface NavItem {
  href: string;
  label: string;
  icon: ElementType<{ className?: string }>;
  /** Only OWNER/ADMIN can manage the organization + see system health. */
  gated?: boolean;
  /** Renders a small "Beta" chip — set an expectation before the click. */
  beta?: boolean;
}

const NAV_PRIMARY: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/employees', label: 'AI Employees', icon: Users },
  { href: '/skills', label: 'Skills', icon: Sparkles },
  // Sits directly ABOVE Automation: this is where people look for "make me a new
  // one". It does not replace the manual builder — both stay (doc 30 AD-30-09).
  { href: '/assist', label: 'AI Assist', icon: WandSparkles, beta: true },
];

/**
 * Automation (UX plan §22): building it, watching it run, and what runs on a
 * timer. Grouped because they are one job seen from three angles — and because
 * a "Runs" link buried under Workflows is a link nobody finds when something
 * has gone wrong.
 */
const NAV_AUTOMATION: NavItem[] = [
  { href: '/workflows', label: 'Workflows', icon: Workflow },
  { href: '/runs', label: 'Runs', icon: ListChecks },
  { href: '/schedules', label: 'Schedules', icon: Timer },
];

const NAV_SECONDARY: NavItem[] = [
  // NOT the same thing as /schedules — this is interview slots for the HR
  // employees. The labels have to disambiguate, because the routes nearly don't.
  { href: '/scheduling', label: 'Interview scheduling', icon: CalendarClock },
  { href: '/marketplace', label: 'Marketplace', icon: ShoppingBag },
];

const NAV_ADMIN: NavItem[] = [
  { href: '/billing', label: 'Billing', icon: CreditCard },
  { href: '/team', label: 'Team', icon: UsersRound },
  { href: '/organization', label: 'Organization', icon: Building2, gated: true },
  { href: '/admin/health', label: 'System health', icon: Activity, gated: true },
];

function NavLink({
  item,
  active,
  badge = 0,
}: {
  item: NavItem;
  active: boolean;
  /** A live count (e.g. runs in flight). Hidden at zero. */
  badge?: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-violet/20 text-white'
          : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
      }`}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {item.label}
      {item.beta ? (
        <span className="ml-auto rounded-full bg-violet/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-secondary">
          Beta
        </span>
      ) : badge > 0 ? (
        <span className="ml-auto flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-violet px-1.5 text-[11px] font-semibold text-white">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/** Persistent dark sidebar nav — workspace switcher + the app's real routes. */
export function Sidebar({
  companyName,
  pendingApprovals,
  canManageOrg,
}: {
  companyName?: string;
  pendingApprovals: number;
  canManageOrg: boolean;
}) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);
  // Only what's actually executing right now — a badge that counted history
  // would be permanently lit and therefore ignored.
  const { data: running } = useAllRuns({ status: 'RUNNING', limit: 20 });
  const runningRuns = running?.length ?? 0;

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-white/[0.06] bg-[#030510] lg:flex">
      <div className="flex items-center gap-2 px-5 py-6">
        <OrlixaMark size={26} />
        <div>
          {/* <p className="text-base font-bold leading-none text-white">Orlixa</p> */}
          {companyName && <p className="font-bold mt-1 text-xs text-white ">{companyName}</p>}
        </div>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-6">
        <div className="space-y-1">
          {NAV_PRIMARY.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} />
          ))}
        </div>

        <div className="space-y-1 border-t border-white/[0.06] pt-4">
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            Automation
          </p>
          {NAV_AUTOMATION.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              // `/workflows` must not light up while you're on `/runs`, and the
              // prefix rule would do exactly that if these shared a stem.
              active={isActive(item.href)}
              badge={item.href === '/runs' ? runningRuns : 0}
            />
          ))}
        </div>

        <div className="space-y-1 border-t border-white/[0.06] pt-4">
          {NAV_SECONDARY.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} />
          ))}
        </div>

        <div className="space-y-1 border-t border-white/[0.06] pt-4">
          <Link
            href="/approvals"
            className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
              isActive('/approvals')
                ? 'bg-violet/20 text-white'
                : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
            }`}
          >
            <span className="flex items-center gap-3">
              <CheckCircle2 className="h-[18px] w-[18px] shrink-0" />
              Approvals
            </span>
            {pendingApprovals > 0 && (
              <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-violet px-1.5 text-[11px] font-semibold text-white">
                {pendingApprovals}
              </span>
            )}
          </Link>
        </div>

        <div className="space-y-1 border-t border-white/[0.06] pt-4">
          {NAV_ADMIN.filter((item) => !item.gated || canManageOrg).map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} />
          ))}
        </div>
      </nav>
    </aside>
  );
}
