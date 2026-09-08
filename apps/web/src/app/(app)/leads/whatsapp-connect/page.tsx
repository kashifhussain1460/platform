'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { WhatsAppConnectForm } from '@/features/whatsapp/components/WhatsAppConnectForm';
import { useSessionStore } from '@/stores/session.store';

/**
 * Connect the WhatsApp Sales AI Employee's `WhatsAppAccount` (Task 13).
 *
 * Not part of the generic `/skills` catalog connect flow: `WhatsAppAccount` is
 * its own top-level table with no FK to `InstalledSkill`, so
 * `POST /skills/installed/:id/connect` (used by every other `api_key` skill)
 * has no path to populate it. This screen is the dedicated form that does.
 */
export default function WhatsAppConnectPage() {
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
      <header className="mb-6 pt-2">
        <p className="text-sm text-app-ink-3">Leads</p>
        <h1 className="text-2xl font-bold text-app-ink">Connect WhatsApp</h1>
        <p className="mt-1 text-sm text-app-ink-2">
          Link a Twilio WhatsApp Business number so the Sales AI Employee can
          receive and reply to prospects.
        </p>
      </header>

      <WhatsAppConnectForm />
    </AppShell>
  );
}
