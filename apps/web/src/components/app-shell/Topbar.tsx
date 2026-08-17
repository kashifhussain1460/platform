'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bell, ChevronDown, LogOut, Menu } from 'lucide-react';
import type { UserDto } from '@vaep/types';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

/** Top-right utility row: approvals bell + account menu (real logout, unchanged). */
export function Topbar({
  user,
  pendingApprovals,
  onLogout,
  loggingOut,
  onOpenNav,
}: {
  user?: UserDto;
  pendingApprovals: number;
  onLogout: () => void;
  loggingOut: boolean;
  /** Opens the navigation drawer. Only rendered below `lg`, where the sidebar is hidden. */
  onOpenNav?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-3 px-6 py-5 sm:px-10">
      {/* Below `lg` the sidebar is hidden, and until this existed nothing
          replaced it: a phone user could reach exactly one link (the approvals
          bell) and was otherwise stuck on whatever page they landed on. */}
      {onOpenNav && (
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-app-border bg-app-surface text-app-ink-2 transition-colors hover:border-app-border-strong hover:text-app-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-secondary lg:hidden"
        >
          <Menu className="h-[18px] w-[18px]" />
        </button>
      )}

      <div className="flex-1" />
      <Link
        href="/approvals"
        aria-label="Approvals"
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-app-border bg-app-surface text-app-ink-2 transition-colors hover:border-app-border-strong hover:text-app-ink"
      >
        <Bell className="h-[18px] w-[18px]" />
        {pendingApprovals > 0 && (
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500" />
        )}
      </Link>

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2.5 rounded-full py-1 pl-1 pr-2 transition-colors hover:bg-app-raised"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] text-xs font-semibold text-white">
            {user?.name ? initials(user.name) : 'U'}
          </span>
          <span className="hidden text-left sm:block">
            <span className="block text-sm font-medium leading-tight text-app-ink">
              {user?.name ?? 'Account'}
            </span>
            <span className="block text-xs capitalize leading-tight text-app-ink-3">
              {user?.role?.toLowerCase() ?? ''}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 text-app-ink-3" />
        </button>

        {open && (
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-app-border bg-app-surface py-1 shadow-[0_20px_50px_-15px_rgba(20,20,28,0.18)]">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onLogout();
                }}
                disabled={loggingOut}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-app-ink-2 transition-colors hover:bg-app-raised hover:text-app-ink disabled:opacity-50"
              >
                <LogOut className="h-4 w-4" />
                {loggingOut ? 'Signing out…' : 'Log out'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
