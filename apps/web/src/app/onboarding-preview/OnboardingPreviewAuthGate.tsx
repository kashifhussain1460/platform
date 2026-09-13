'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSessionStore } from '@/stores/session.store';

/**
 * Auth guard scoped to THIS route only — do not reuse (app)/layout.tsx's
 * guard here, it hard-redirects any non-onboarded session to the literal
 * path '/onboarding' with no exemption for this one. Guests go to /login;
 * everyone else (onboarded or not) sees the wizard, since re-visiting here
 * to hire more employees later is a supported use, not just first-run setup.
 */
export function OnboardingPreviewAuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const status = useSessionStore((s) => s.status);

  useEffect(() => {
    if (status === 'guest') {
      router.replace('/login?returnTo=/onboarding-preview');
    }
  }, [status, router]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#02030a] text-sm text-fg-muted">
        Loading your workspace…
      </div>
    );
  }
  if (status === 'guest') return null;
  return <>{children}</>;
}
