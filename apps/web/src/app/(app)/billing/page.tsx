'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { CurrentPlanCard } from '@/features/billing/components/CurrentPlanCard';
import { CreditPurchaseSection } from '@/features/billing/components/CreditPurchaseSection';
import { PlanCatalog } from '@/features/billing/components/PlanCatalog';
import { UsageSummary } from '@/features/billing/components/UsageSummary';
import { useSessionStore } from '@/stores/session.store';

export default function BillingPage() {
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
      <div className="mb-8 flex items-start justify-between pt-2">
        <div>
          <h1 className="text-2xl font-bold text-app-ink">Billing</h1>
          <p className="mt-1 text-sm text-app-ink-2">Manage your subscription and billing.</p>
        </div>
        {(shellProps.user?.role === 'OWNER' || shellProps.user?.role === 'ADMIN') && (
          <Link
            href="/billing/usage"
            className="shrink-0 rounded-lg border border-app-border-strong px-3 py-2 text-sm font-medium text-app-ink-2 hover:bg-app-raised"
          >
            View usage ledger
          </Link>
        )}
      </div>

      <div className="space-y-10">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <CurrentPlanCard />
          </div>
          <div className="lg:col-span-2">
            <UsageSummary />
          </div>
        </div>

        <CreditPurchaseSection />

        <section id="plans">
          <h2 className="mb-3 text-sm font-medium text-app-ink-2">Plans</h2>
          <PlanCatalog />
        </section>
      </div>
    </AppShell>
  );
}
