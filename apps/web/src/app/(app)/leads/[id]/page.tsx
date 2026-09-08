'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { LeadDetail } from '@/features/leads/components/LeadDetail';
import { useSessionStore } from '@/stores/session.store';

export default function LeadPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();

  useEffect(() => {
    if (!accessToken) router.replace('/login');
  }, [accessToken, router]);

  if (!accessToken) return null;

  return (
    <AppShell {...shellProps}>
      <header className="mb-6 pt-2">
        <Link
          href="/leads"
          className="text-sm text-app-ink-3 transition-colors hover:text-app-ink"
        >
          ← Leads
        </Link>
      </header>

      <LeadDetail id={params.id} />
    </AppShell>
  );
}
