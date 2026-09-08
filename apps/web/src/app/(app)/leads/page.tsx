'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { buttonClasses } from '@/components/ui/Button';
import { LeadsList } from '@/features/leads/components/LeadsList';
import { useSessionStore } from '@/stores/session.store';

/**
 * The leads workspace — the human front door to the WhatsApp Sales AI
 * Employee's prospects. Same reasoning as the Marketing workspace: the AI
 * could already be qualifying real people over WhatsApp with no screen
 * showing what came in, so this is that screen.
 */
export default function LeadsPage() {
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

  return (
    <AppShell {...shellProps}>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 pt-2">
        <div>
          <p className="text-sm text-app-ink-3">Leads</p>
          <h1 className="text-2xl font-bold text-app-ink">Prospects</h1>
        </div>
        <Link href="/leads/whatsapp-connect" className={buttonClasses('violet')}>
          Connect WhatsApp
        </Link>
      </header>

      <LeadsList />
    </AppShell>
  );
}
