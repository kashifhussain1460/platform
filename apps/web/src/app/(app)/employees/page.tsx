'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { buttonClasses } from '@/components/ui/Button';
import { EmployeeForm } from '@/features/employees/components/EmployeeForm';
import { EmployeeList } from '@/features/employees/components/EmployeeList';
import { useSessionStore } from '@/stores/session.store';

export default function EmployeesPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();

  // Client-side route guard, same pattern as the knowledge page.
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
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 pt-2">
        <div>
          <p className="text-sm text-app-ink-3">AI workforce</p>
          <h1 className="text-2xl font-bold text-app-ink">AI Employees</h1>
        </div>
        <a href="#hire-employee" className={buttonClasses('violet')}>
          <UserPlus className="h-4 w-4" />
          New employee
        </a>
      </div>

      <div className="space-y-8">
        <EmployeeForm />
        <div>
          <h2 className="mb-3 text-sm font-medium text-app-ink-2">Your roster</h2>
          <EmployeeList />
        </div>
      </div>
    </AppShell>
  );
}
