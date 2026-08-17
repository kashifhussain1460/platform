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
  SUPPORT: 'bg-teal-400/15 text-teal-800',
  SALES: 'bg-sky-400/15 text-sky-800',
  RECRUITER: 'bg-violet/20 text-violet',
  HR: 'bg-rose-400/15 text-rose-800',
  ACCOUNTANT: 'bg-indigo-400/15 text-indigo-800',
  PROJECT_MANAGER: 'bg-amber-400/15 text-amber-800',
  MARKETING: 'bg-fuchsia-400/15 text-fuchsia-800',
  CUSTOM: 'bg-app-raised text-app-ink-2',
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
  Recruiting: 'bg-violet/20 text-violet',
  Sales: 'bg-sky-400/15 text-sky-800',
  'Customer Support': 'bg-teal-400/15 text-teal-800',
  'Human Resources': 'bg-rose-400/15 text-rose-800',
  Finance: 'bg-indigo-400/15 text-indigo-800',
  'Project Management': 'bg-amber-400/15 text-amber-800',
  Marketing: 'bg-fuchsia-400/15 text-fuchsia-800',
  Procurement: 'bg-orange-400/15 text-orange-800',
  Operations: 'bg-emerald-400/15 text-emerald-800',
  Legal: 'bg-cyan-400/15 text-cyan-800',
};

const DEFAULT_CATEGORY_BADGE = 'bg-app-raised text-app-ink-2';

/** Falls back to a neutral Bot icon for any category the catalog adds later. */
export function categoryIcon(category: string): LucideIcon {
  return CATEGORY_ICON[category] ?? Bot;
}

/** Falls back to a neutral chip for any category the catalog adds later. */
export function categoryBadgeClass(category: string): string {
  return CATEGORY_BADGE[category] ?? DEFAULT_CATEGORY_BADGE;
}
