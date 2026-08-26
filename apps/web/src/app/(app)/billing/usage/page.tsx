'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { UsageLedgerTable } from '@/features/billing/components/UsageLedgerTable';
import { useSessionStore } from '@/stores/session.store';

export default function BillingUsagePage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();

  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  // Server-side gate is the real enforcement (OWNER/ADMIN only, §31.2.2); this
  // is purely so a MEMBER sees a clear access-denied state instead of a raw
  // 403 flashing through a loading table.
  const canViewUsage = shellProps.user?.role === 'OWNER' || shellProps.user?.role === 'ADMIN';

  return (
    <AppShell {...shellProps}>
      <div className="mb-8 pt-2">
        <h1 className="text-2xl font-bold text-app-ink">Usage</h1>
        <p className="mt-1 text-sm text-app-ink-2">Row-level credit ledger.</p>
      </div>

      {canViewUsage ? (
        <UsageLedgerTable />
      ) : (
        <div className="rounded-2xl border border-app-border bg-app-surface p-6 text-sm text-app-ink-2">
          Only an owner or admin can view the usage ledger.
        </div>
      )}
    </AppShell>
  );
}
