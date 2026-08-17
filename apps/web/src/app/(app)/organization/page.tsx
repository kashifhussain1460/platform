'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { AuditLogSection } from '@/features/organization/components/AuditLogSection';
import { DepartmentSection } from '@/features/organization/components/DepartmentSection';
import { OrgOverview } from '@/features/organization/components/OrgOverview';
import { SecurityPolicyForm } from '@/features/organization/components/SecurityPolicyForm';
import { TeamSection } from '@/features/organization/components/TeamSection';
import { useCanManageOrg } from '@/features/organization/hooks';
import { useSessionStore } from '@/stores/session.store';

type OrgTab = 'overview' | 'departments' | 'teams' | 'security' | 'audit-log';

const TABS: { key: OrgTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'departments', label: 'Departments' },
  { key: 'teams', label: 'Teams' },
  { key: 'security', label: 'Security' },
  { key: 'audit-log', label: 'Audit Log' },
];

export default function OrganizationPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const canManage = useCanManageOrg();
  const shellProps = useAppShellProps();
  const [tab, setTab] = useState<OrgTab>('overview');

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
      <div className="mb-8 pt-2">
        <h1 className="text-2xl font-bold text-app-ink">Organization</h1>
        <p className="mt-1 text-sm text-app-ink-2">
          Departments, teams and security policy.
          {!canManage && ' You have read-only access.'}
        </p>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.filter((t) => t.key !== 'audit-log' || canManage).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-violet text-white'
                : 'border border-app-border text-app-ink-2 hover:text-app-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OrgOverview />}
      {tab === 'departments' && <DepartmentSection />}
      {tab === 'teams' && <TeamSection />}
      {tab === 'security' && <SecurityPolicyForm />}
      {tab === 'audit-log' && canManage && <AuditLogSection />}
    </AppShell>
  );
}
