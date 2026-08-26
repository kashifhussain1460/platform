'use client';

import type { ElementType, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BookOpen,
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
import type { ProductArea, ResolvedNavItemDto } from '@vaep/types';
import { PRODUCT_AREA_NAV } from '@vaep/types';
import { useAllRuns } from '@/features/workflows/hooks';
import { useProductContext } from '@/features/product-context/hooks';
import { CreditBadge } from './CreditBadge';

interface NavItem {
  href: string;
  label: string;
  icon: ElementType<{ className?: string }>;
  /** Renders a small "Beta" chip — set an expectation before the click. */
  beta?: boolean;
}

/**
 * Presentation for a resolved product area: its icon and, where the product's
 * own wording is better than the server's, its label.
 *
 * This is the ONLY thing the sidebar still owns. Which areas exist, whether a
 * company is entitled to them, and whether this user may reach them are all
 * decided by `GET /product-context` — one answer, shared with every other
 * surface. Before Phase 4 this file held four hardcoded arrays and its own
 * plan rule (which it had forgotten to apply, so STARTER customers were shown
 * an AI Assist link that answered 403).
 *
 * An icon is a presentation concern and genuinely belongs here. A capability
 * decision does not.
 */
const AREA_PRESENTATION: Record<
  ProductArea,
  { icon: ElementType<{ className?: string }>; label?: string; beta?: boolean }
> = {
  DASHBOARD: { icon: LayoutDashboard },
  EMPLOYEES: { icon: Users },
  SKILLS: { icon: Sparkles },
  ASSIST: { icon: WandSparkles, beta: true },
  KNOWLEDGE: { icon: BookOpen },
  WORKFLOWS: { icon: Workflow },
  RUNS: { icon: ListChecks },
  SCHEDULES: { icon: Timer },
  INTERVIEW_SCHEDULING: { icon: CalendarClock },
  MARKETPLACE: { icon: ShoppingBag },
  APPROVALS: { icon: CheckCircle2 },
  BILLING: { icon: CreditCard },
  TEAM: { icon: UsersRound },
  ORGANIZATION: { icon: Building2 },
  ADMIN_HEALTH: { icon: Activity },
};

/** Group order + heading. `null` heading = no divider label. */
const GROUP_ORDER: Array<{ group: ResolvedNavItemDto['group']; heading: string | null }> = [
  { group: 'PRIMARY', heading: null },
  { group: 'AUTOMATION', heading: 'Automation' },
  { group: 'SECONDARY', heading: null },
  { group: 'ADMIN', heading: null },
];

/**
 * The fallback used while `/product-context` is in flight or has failed.
 *
 * Deliberately the CORE areas only, and deliberately not empty: a blank
 * sidebar on a slow network reads as a broken app. It never includes a
 * plan-gated or role-gated area, so the fallback can only ever under-offer.
 */
const FALLBACK_AREAS: ProductArea[] = [
  'DASHBOARD',
  'EMPLOYEES',
  'SKILLS',
  'KNOWLEDGE',
  'WORKFLOWS',
  'RUNS',
  'SCHEDULES',
  'APPROVALS',
  'MARKETPLACE',
  'BILLING',
  'TEAM',
];





function NavLink({
  item,
  active,
  badge = 0,
  endSlot,
}: {
  item: NavItem;
  active: boolean;
  /** A live count (e.g. runs in flight). Hidden at zero. */
  badge?: number;
  /** A custom trailing element (e.g. the credit badge) in place of a count. */
  endSlot?: ReactNode;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-violet/20 text-white'
          : 'text-fg-muted hover:bg-white/[0.06] hover:text-white'
      }`}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {item.label}
      {item.beta ? (
        <span className="ml-auto rounded-full bg-violet/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-bright">
          Beta
        </span>
      ) : badge > 0 ? (
        <span className="ml-auto flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-violet px-1.5 text-[11px] font-semibold text-white">
          {badge}
        </span>
      ) : (
        endSlot ?? null
      )}
    </Link>
  );
}

/** Persistent dark sidebar nav — workspace switcher + the app's real routes. */
export function Sidebar({
  companyName,
  pendingApprovals,
  inDrawer = false,
}: {
  companyName?: string;
  pendingApprovals: number;
  /**
   * Rendered inside the mobile drawer, where it must be visible at every width —
   * the default instance is `hidden lg:flex` because the drawer is what serves
   * small screens.
   */
  inDrawer?: boolean;
}) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);
  // Only what's actually executing right now — a badge that counted history
  // would be permanently lit and therefore ignored.
  const { data: running } = useAllRuns({ status: 'RUNNING', limit: 20 });
  const runningRuns = running?.length ?? 0;

  // Resolved server-side. Defaults to showing the item while loading or on
  // error: a transient failure must not blank out someone's navigation.
  // THE navigation source. Relevance ∧ entitlement ∧ authorization were all
  // decided server-side; this component only chooses icons and grouping.
  const { data: productContext } = useProductContext();
  const navItems: ResolvedNavItemDto[] =
    productContext?.navigation ??
    FALLBACK_AREAS.map((area) => ({ area, ...PRODUCT_AREA_NAV[area] }));

  return (
    <aside
      className={
        inDrawer
          ? 'flex h-full w-full shrink-0 flex-col overflow-y-auto border-r border-white/[0.06] bg-[#030510]'
          : 'hidden w-64 shrink-0 flex-col border-r border-white/[0.06] bg-[#030510] lg:flex'
      }
    >
      <div className="flex items-center gap-2 px-5 py-6">
        <OrlixaMark size={26} />
        <div>
          {/* <p className="text-base font-bold leading-none text-white">Orlixa</p> */}
          {companyName && <p className="font-bold mt-1 text-xs text-white ">{companyName}</p>}
        </div>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-6">
        {GROUP_ORDER.map(({ group, heading }) => {
          const items = navItems.filter((i) => i.group === group);
          if (items.length === 0) return null;
          return (
            <div
              key={group}
              className={
                group === 'PRIMARY'
                  ? 'space-y-1'
                  : 'space-y-1 border-t border-white/[0.06] pt-4'
              }
            >
              {heading && (
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  {heading}
                </p>
              )}
              {items.map((resolved) => {
                const presentation = AREA_PRESENTATION[resolved.area];
                return (
                  <NavLink
                    key={resolved.area}
                    item={{
                      href: resolved.href,
                      label: presentation.label ?? resolved.label,
                      icon: presentation.icon,
                      beta: presentation.beta,
                    }}
                    // `/workflows` must not light up while you're on `/runs`, and
                    // the prefix rule would do exactly that if these shared a stem.
                    active={isActive(resolved.href)}
                    badge={
                      resolved.area === 'RUNS'
                        ? runningRuns
                        : resolved.area === 'APPROVALS'
                          ? pendingApprovals
                          : 0
                    }
                    endSlot={resolved.area === 'BILLING' ? <CreditBadge /> : undefined}
                  />
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
