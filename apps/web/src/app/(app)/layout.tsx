'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSessionStore } from '@/stores/session.store';

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">
      {children}
    </div>
  );
}

/**
 * Auth guard for all protected (app) routes.
 * - waits for session rehydration (`status === 'loading'`) before deciding
 * - guests → /login
 * - authenticated but onboarding incomplete → force the wizard (/onboarding)
 *
 * Deliberately does NOT redirect an already-onboarded company away from
 * `/onboarding` (the old 4-step wizard did — it had no way to hire more
 * employees, so revisiting it made no sense once done). `/onboarding` is
 * now the full multi-step wizard (previously `/onboarding-preview`), which
 * explicitly supports an onboarded company revisiting to configure/hire
 * additional AI Employees later — bouncing it to /dashboard here would
 * break that use case outright.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useSessionStore((s) => s.status);
  const company = useSessionStore((s) => s.company);
  const user = useSessionStore((s) => s.user);
  const verified = Boolean(user?.emailVerified);
  const onboarded = Boolean(company?.onboardedAt);
  const onOnboarding = pathname === '/onboarding';

  // Deterministic post-auth routing: EMAIL_UNVERIFIED → verify, then
  // ONBOARDING_INCOMPLETE → wizard, else the app. /verify-email lives in the
  // (auth) group, so an unverified user in a protected route is sent there.
  useEffect(() => {
    if (status === 'guest') {
      router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
    } else if (status === 'authenticated') {
      if (!verified) router.replace('/verify-email');
      else if (!onboarded && !onOnboarding) router.replace('/onboarding');
    }
  }, [status, verified, onboarded, onOnboarding, router]);

  if (status === 'loading') return <FullScreen>Loading your workspace…</FullScreen>;
  if (status === 'guest') return null;
  // A redirect is pending — render nothing to avoid a flash of the wrong page.
  if (!verified) return null;
  if (!onboarded && !onOnboarding) return null;
  return <>{children}</>;
}
