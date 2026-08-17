'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { InstalledSkillList } from '@/features/skills/components/InstalledSkillList';
import { SkillCatalog } from '@/features/skills/components/SkillCatalog';
import { skillKeys } from '@/features/skills/hooks';
import { useSessionStore } from '@/stores/session.store';

export default function SkillsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();
  const [banner, setBanner] = useState<
    { kind: 'ok' | 'error'; text: string } | null
  >(null);

  // Client-side route guard, same pattern as the knowledge page.
  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  // Handle the OAuth callback return: /skills?connected=<skillKey> (success) or
  // /skills?error=<message>. Show a banner, refresh the installed list (the skill
  // is now CONNECTED), then strip the query params.
  const connected = searchParams.get('connected');
  const oauthError = searchParams.get('error');
  useEffect(() => {
    if (connected) {
      setBanner({ kind: 'ok', text: `Connected ${connected}.` });
      void qc.invalidateQueries({ queryKey: skillKeys.installed });
      router.replace('/skills');
    } else if (oauthError) {
      setBanner({ kind: 'error', text: `Connection failed: ${oauthError}` });
      router.replace('/skills');
    }
  }, [connected, oauthError, qc, router]);

  if (!accessToken) {
    return null;
  }

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 flex items-center justify-between pt-2">
        <h1 className="text-2xl font-bold text-app-ink">Skills</h1>
      </div>

      {banner && (
        <div
          className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
            banner.kind === 'ok'
              ? 'border-green-500/20 bg-green-500/10 text-green-800'
              : 'border-red-500/20 bg-red-500/10 text-red-600'
          }`}
        >
          {banner.text}
        </div>
      )}

      <div className="space-y-10">
        <SkillCatalog />
        <section>
          <h2 className="mb-4 text-sm font-medium text-app-ink-2">Installed Skills</h2>
          <InstalledSkillList />
        </section>
      </div>
    </AppShell>
  );
}
