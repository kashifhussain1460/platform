'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { EmployeeTemplateList } from '@/features/marketplace/components/EmployeeTemplateList';
// Skills section reuses the existing Skills catalog + install flow (no duplication).
import { SkillCatalog } from '@/features/skills/components/SkillCatalog';
import { useSessionStore } from '@/stores/session.store';

export default function MarketplacePage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();

  // Client-side route guard, same pattern as the other app pages.
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
        <p className="text-sm text-app-ink-3">Expand</p>
        <h1 className="text-2xl font-bold text-app-ink">Marketplace</h1>
      </header>

      <div className="space-y-10">
        <section>
          <h2 className="mb-3 text-sm font-medium text-app-ink-2">AI Employees</h2>
          <EmployeeTemplateList />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium text-app-ink-2">
            Workflow Templates
          </h2>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium text-app-ink-2">Skills</h2>
          <SkillCatalog />
        </section>
      </div>
    </AppShell>
  );
}
