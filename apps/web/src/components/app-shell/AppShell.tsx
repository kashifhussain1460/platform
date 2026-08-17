'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import type { UserDto } from '@vaep/types';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/**
 * Shared dark app chrome (sidebar + topbar) for the authenticated product —
 * pixel-matched to the Orlixa dashboard mockup. Pages opt in one at a time;
 * wrap a page's content with this instead of hand-rolling a header.
 *
 * ## Navigation below `lg`
 *
 * The sidebar is `hidden lg:flex`, and for a long time nothing took its place:
 * a browser check at 390px found exactly ONE reachable link on the whole
 * dashboard (the approvals bell), so a phone user could not move around the
 * product at all. The same sidebar now slides in as a drawer, so mobile has the
 * real navigation rather than a subset of it.
 */
export function AppShell({
  companyName,
  user,
  pendingApprovals,
  canManageOrg,
  onLogout,
  loggingOut,
  children,
}: {
  companyName?: string;
  user?: UserDto;
  pendingApprovals: number;
  canManageOrg: boolean;
  onLogout: () => void;
  loggingOut: boolean;
  children: ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  // Navigating is the whole point of the drawer, so it closes itself once you
  // have. Leaving it open over the new page is the classic mobile-nav bug.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    // A drawer over a page that still scrolls underneath feels broken.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [navOpen]);

  return (
    /* `app-light` is the hook the light-surface overrides in globals.css hang
       off — the shared `.field-modern` control has to look different here than
       it does on the dark auth panels, and a class on the shell is what tells
       the two apart. */
    <div className="app-light font-marketing flex min-h-screen bg-app-bg">
      <Sidebar companyName={companyName} pendingApprovals={pendingApprovals} canManageOrg={canManageOrg} />

      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/70"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="relative flex h-full w-[17rem] max-w-[85vw]"
          >
            <Sidebar
              companyName={companyName}
              pendingApprovals={pendingApprovals}
              canManageOrg={canManageOrg}
              inDrawer
            />
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-5 flex h-9 w-9 items-center justify-center rounded-full border border-app-border bg-app-raised text-app-ink-2 transition-colors hover:text-app-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-secondary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          pendingApprovals={pendingApprovals}
          onLogout={onLogout}
          loggingOut={loggingOut}
          onOpenNav={() => setNavOpen(true)}
        />
        <main className="flex-1 px-6 pb-12 text-app-ink sm:px-10">{children}</main>
      </div>
    </div>
  );
}
