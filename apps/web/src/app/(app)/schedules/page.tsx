'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { ScheduleTable } from '@/features/schedules/components/ScheduleTable';
import { useSchedules } from '@/features/schedules/hooks';
import { useSessionStore } from '@/stores/session.store';

/**
 * `/schedules` — what runs automatically, and when (UX plan §22).
 *
 * Not to be confused with `/scheduling`, which is interview slots for the HR
 * employees. Different feature, different nav label.
 */
export default function SchedulesPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const role = useSessionStore((s) => s.user?.role);
  const shellProps = useAppShellProps();
  const { rows, isLoading } = useSchedules();

  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  const activeCount = rows.filter((r) => r.active).length;

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 pt-2">
        <h1 className="text-2xl font-bold text-white">Schedules</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Workflows that start on their own.
          {rows.length > 0 &&
            ` ${activeCount} of ${rows.length} ${activeCount === 1 ? 'is' : 'are'} switched on.`}
        </p>
      </div>

      <ScheduleTable
        rows={rows}
        isLoading={isLoading}
        canManage={role === 'OWNER' || role === 'ADMIN'}
      />
    </AppShell>
  );
}
