'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { ApprovalList } from '@/features/approvals/components/ApprovalList';
import { HandoffInbox } from '@/features/handoffs/components/HandoffInbox';
import { useSessionStore } from '@/stores/session.store';

type Tab = 'approvals' | 'handoffs';

/**
 * Everything waiting on a human, in one place.
 *
 * Two tabs rather than two routes: a tool approval and a customer handoff are
 * different mechanisms (one gates a single tool call, the other pauses an
 * entire conversation) but they are the same JOB — someone has to decide
 * something an AI Employee stopped short of. Splitting them across two nav
 * entries would mean two inboxes to remember to check, and the second one is
 * the one that gets forgotten.
 *
 * `?tab=handoffs` is honoured so the dashboard's Support widget can link
 * straight at the queue it is counting.
 */
function ApprovalsPageInner() {
  const router = useRouter();
  const search = useSearchParams();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();
  const [tab, setTab] = useState<Tab>(
    search.get('tab') === 'handoffs' ? 'handoffs' : 'approvals',
  );

  // Client-side route guard, same pattern as the other feature pages.
  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  const tabClass = (active: boolean) =>
    `rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
      active
        ? 'bg-violet text-white'
        : 'border border-app-border text-app-ink-2 hover:text-app-ink'
    }`;

  return (
    <AppShell {...shellProps}>
      <header className="mb-6 pt-2">
        <p className="text-sm text-app-ink-3">Governance</p>
        <h1 className="text-2xl font-bold text-app-ink">Approval Center</h1>
      </header>

      <div className="mb-6 flex flex-wrap gap-2">
        <button
          type="button"
          className={tabClass(tab === 'approvals')}
          onClick={() => setTab('approvals')}
        >
          Tool approvals
        </button>
        <button
          type="button"
          className={tabClass(tab === 'handoffs')}
          onClick={() => setTab('handoffs')}
        >
          Customer handoffs
        </button>
      </div>

      {tab === 'approvals' ? <ApprovalList /> : <HandoffInbox />}
    </AppShell>
  );
}

export default function ApprovalsPage() {
  // `useSearchParams` needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <ApprovalsPageInner />
    </Suspense>
  );
}
