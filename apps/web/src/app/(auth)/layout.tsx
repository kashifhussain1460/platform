'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSessionStore } from '@/stores/session.store';

/**
 * Password recovery is a PUBLIC flow reached from an email link — it must render
 * regardless of session/verification. A reset link is often opened in a browser
 * that holds a stale or unverified session (or none), and none of that should
 * bounce it to /verify-email or /dashboard: the link carries its own token.
 */
const RECOVERY_ROUTES = ['/forgot-password', '/reset-password'];

/**
 * Guest guard for the (auth) routes. An authenticated visitor is sent into the
 * app — EXCEPT an unverified one, who is kept on (or sent to) /verify-email so
 * they can confirm their email. Verified users leave every (auth) route:
 * onboarded → /dashboard, else → /onboarding. Waits for rehydration; no loops
 * (verify-email is the one authenticated-but-unverified route allowed here).
 * The recovery routes above are exempt from all of this.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useSessionStore((s) => s.status);
  const company = useSessionStore((s) => s.company);
  const user = useSessionStore((s) => s.user);
  const verified = Boolean(user?.emailVerified);
  const onVerify = pathname === '/verify-email';
  const onRecovery = RECOVERY_ROUTES.includes(pathname);

  useEffect(() => {
    if (onRecovery) return; // recovery flows are always allowed
    if (status !== 'authenticated') return;
    if (!verified) {
      if (!onVerify) router.replace('/verify-email');
    } else {
      router.replace(company?.onboardedAt ? '/dashboard' : '/onboarding');
    }
  }, [status, verified, onVerify, onRecovery, company, router]);

  // Recovery pages render immediately — they never wait on or care about session.
  if (onRecovery) return <>{children}</>;

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#02030a] text-sm text-zinc-500">
        Loading…
      </div>
    );
  }
  // Authenticated + unverified may ONLY see /verify-email; everything else here
  // is mid-redirect.
  if (status === 'authenticated') {
    if (!verified && onVerify) return <>{children}</>;
    return null;
  }
  return <>{children}</>;
}
