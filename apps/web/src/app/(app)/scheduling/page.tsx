'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { CustomSlotControls } from '@/features/scheduling/components/CustomSlotControls';
import { GenerateSlotsForm } from '@/features/scheduling/components/GenerateSlotsForm';
import { SlotList } from '@/features/scheduling/components/SlotList';
import { SummaryBar } from '@/features/scheduling/components/SummaryBar';
import { useSessionStore } from '@/stores/session.store';

export default function SchedulingPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();

  // Client-side route guard, same pattern as the other feature pages.
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
        <p className="text-sm text-app-ink-3">Interviews</p>
        <h1 className="text-2xl font-bold text-app-ink">Scheduling</h1>
      </header>

      <div className="space-y-6">
        <SummaryBar />
        <GenerateSlotsForm />
        <CustomSlotControls />
        <SlotList />
      </div>
    </AppShell>
  );
}
