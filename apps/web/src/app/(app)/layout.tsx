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
 * - authenticated + onboarded but sitting on /onboarding → /dashboard
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
      router.replace('/login');
    } else if (status === 'authenticated') {
      if (!verified) router.replace('/verify-email');
      else if (!onboarded && !onOnboarding) router.replace('/onboarding');
      else if (onboarded && onOnboarding) router.replace('/dashboard');
    }
  }, [status, verified, onboarded, onOnboarding, router]);

  if (status === 'loading') return <FullScreen>Loading your workspace…</FullScreen>;
  if (status === 'guest') return null;
  // A redirect is pending — render nothing to avoid a flash of the wrong page.
  if (!verified) return null;
  if (!onboarded && !onOnboarding) return null;
  if (onboarded && onOnboarding) return null;
  return <>{children}</>;
}
