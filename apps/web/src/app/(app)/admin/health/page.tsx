'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { DlqPanel } from '@/features/admin/components/DlqPanel';
import { useCanManageSystem } from '@/features/admin/hooks';
import { useSessionStore } from '@/stores/session.store';

/**
 * Admin system health page (Unit C): the DLQ + connector-circuit panel. Gated to
 * authenticated OWNER/ADMIN (same client-side guard pattern as /organization); the
 * API enforces the role too.
 */
export default function AdminHealthPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const canManage = useCanManageSystem();
  const shellProps = useAppShellProps();

  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  return (
    <AppShell {...shellProps}>
      <header className="mb-8 pt-2">
        <p className="text-sm text-app-ink-3">Account</p>
        <h1 className="text-2xl font-bold text-app-ink">System health</h1>
        <p className="mt-1 text-sm text-app-ink-3">
          Background-job dead-letter queue and connector circuit breakers.
        </p>
      </header>

      {canManage ? (
        <DlqPanel />
      ) : (
        <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
          You need an OWNER or ADMIN role to view system health.
        </p>
      )}
    </AppShell>
  );
}
