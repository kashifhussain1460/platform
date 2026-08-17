'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { UserForm } from '@/features/users/components/UserForm';
import { UserList } from '@/features/users/components/UserList';
import { useCanManageUsers } from '@/features/users/hooks';
import { useSessionStore } from '@/stores/session.store';

export default function TeamPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const canManage = useCanManageUsers();
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
      <div className="pt-2">
        <h1 className="mb-6 text-2xl font-bold text-app-ink">Team Members</h1>

        <div className="space-y-6">
          {/* Mutating controls are OWNER/ADMIN only; members see a read-only roster. */}
          {canManage && <UserForm />}
          <UserList />
        </div>
      </div>
    </AppShell>
  );
}
