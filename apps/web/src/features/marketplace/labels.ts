import type { EmployeeRole } from '@vaep/types';
import {
  Bot,
  Calculator,
  ClipboardList,
  Headset,
  Megaphone,
  Scale,
  Settings2,
  ShoppingCart,
  TrendingUp,
  UserSearch,
  Users,
  type LucideIcon,
} from 'lucide-react';

/** Tailwind classes for the employee-role badge, keyed by role. */
export const ROLE_STYLES: Record<EmployeeRole, string> = {
  SUPPORT: 'bg-teal-400/15 text-teal-400',
  SALES: 'bg-sky-400/15 text-sky-300',
  RECRUITER: 'bg-violet/20 text-violet-secondary',
  HR: 'bg-rose-400/15 text-rose-400',
  ACCOUNTANT: 'bg-indigo-400/15 text-indigo-400',
  PROJECT_MANAGER: 'bg-amber-400/15 text-amber-400',
  MARKETING: 'bg-fuchsia-400/15 text-fuchsia-400',
  CUSTOM: 'bg-white/[0.06] text-zinc-300',
};

const ACRONYMS = new Set(['HR']);

/** "PROJECT_MANAGER" → "Project manager", "HR" → "HR". */
export function formatRole(role: EmployeeRole): string {
  return role
    .split('_')
    .map((w, i) =>
      ACRONYMS.has(w) ? w : i === 0 ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase(),
    )
    .join(' ');
}

/**
 * Template-card icon per marketplace `category` (mirrors the icon choices
 * already shipped on the marketing site's AI-employee grid). Shared by both
 * the employee and workflow template cards so the two stay visually
 * consistent.
 */
const CATEGORY_ICON: Record<string, LucideIcon> = {
  Recruiting: UserSearch,
  Sales: TrendingUp,
  'Customer Support': Headset,
  'Human Resources': Users,
  Finance: Calculator,
  'Project Management': ClipboardList,
  Marketing: Megaphone,
  Procurement: ShoppingCart,
  Operations: Settings2,
  Legal: Scale,
};

/** Icon-badge accent per category, same key set as {@link CATEGORY_ICON}. */
const CATEGORY_BADGE: Record<string, string> = {
  Recruiting: 'bg-violet/20 text-violet-secondary',
  Sales: 'bg-sky-400/15 text-sky-300',
  'Customer Support': 'bg-teal-400/15 text-teal-400',
  'Human Resources': 'bg-rose-400/15 text-rose-400',
  Finance: 'bg-indigo-400/15 text-indigo-400',
  'Project Management': 'bg-amber-400/15 text-amber-400',
  Marketing: 'bg-fuchsia-400/15 text-fuchsia-400',
  Procurement: 'bg-orange-400/15 text-orange-400',
  Operations: 'bg-emerald-400/15 text-emerald-400',
  Legal: 'bg-cyan-400/15 text-cyan-400',
};

const DEFAULT_CATEGORY_BADGE = 'bg-white/[0.06] text-zinc-300';

/** Falls back to a neutral Bot icon for any category the catalog adds later. */
export function categoryIcon(category: string): LucideIcon {
  return CATEGORY_ICON[category] ?? Bot;
}

/** Falls back to a neutral chip for any category the catalog adds later. */
export function categoryBadgeClass(category: string): string {
  return CATEGORY_BADGE[category] ?? DEFAULT_CATEGORY_BADGE;
}
