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
  ShoppingBag,
  Sparkles,
  UsersRound,
  WandSparkles,
  Workflow,
  Users,
} from 'lucide-react';
import { OrlixaMark } from '@/components/marketing-dark/OrlixaMark';

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
  // Sits directly ABOVE Workflows: this is where people look for "make me a new
  // one". It does not replace the manual builder — both stay (doc 30 AD-30-09).
  { href: '/assist', label: 'AI Assist', icon: WandSparkles, beta: true },
  { href: '/workflows', label: 'Workflows', icon: Workflow },
  { href: '/scheduling', label: 'Scheduling', icon: CalendarClock },
  { href: '/marketplace', label: 'Marketplace', icon: ShoppingBag },
];

const NAV_ADMIN: NavItem[] = [
  { href: '/billing', label: 'Billing', icon: CreditCard },
  { href: '/team', label: 'Team', icon: UsersRound },
  { href: '/organization', label: 'Organization', icon: Building2, gated: true },
  { href: '/admin/health', label: 'System health', icon: Activity, gated: true },
];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
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
