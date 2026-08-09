'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { useSubscription } from '@/features/billing/hooks';
import { GenerateWorkflowChat } from '@/features/workflows/components/GenerateWorkflowChat';
import { WorkflowForm } from '@/features/workflows/components/WorkflowForm';
import { WorkflowListTable } from '@/features/workflows/components/builder/WorkflowListTable';
import { useSessionStore } from '@/stores/session.store';

const secondaryBtnClass =
  'rounded-xl border border-white/[0.12] bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/[0.06]';

export default function WorkflowsPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();
  const { data: subscription } = useSubscription();
  const [showForm, setShowForm] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);

  // Client-side route guard, same pattern as the other feature pages.
  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  const canGenerate = subscription?.plan === 'BUSINESS' || subscription?.plan === 'ENTERPRISE';

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 pt-2">
        <h1 className="text-2xl font-bold text-white">Workflows</h1>
        <div className="flex gap-3">
          <Link href="/workflows/templates" className={secondaryBtnClass}>
            Start from a template
          </Link>
          {canGenerate && (
            <button
              type="button"
              onClick={() => {
                setShowGenerate((v) => !v);
                setShowForm(false);
              }}
              className={secondaryBtnClass}
            >
              {showGenerate ? 'Cancel' : 'Generate with AI'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setShowForm((v) => !v);
              setShowGenerate(false);
            }}
            className="rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_14px_34px_-12px_rgba(91,33,230,0.85)] transition-all hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {showForm ? 'Cancel' : '+ New Workflow'}
          </button>
        </div>
      </div>

      {showGenerate && (
        <div className="mb-6">
          <GenerateWorkflowChat onClose={() => setShowGenerate(false)} />
        </div>
      )}

      {showForm && (
        <div className="mb-6">
          <WorkflowForm />
        </div>
      )}

      <WorkflowListTable />
    </AppShell>
  );
}
