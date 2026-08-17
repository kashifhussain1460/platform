'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { VersionHistoryPanel } from '@/features/workflows/components/builder/VersionHistoryPanel';
import { useWorkflow } from '@/features/workflows/hooks';
import { useSessionStore } from '@/stores/session.store';

/**
 * `/workflows/[id]/versions` — the version history as its own page (UX plan
 * §17, §53).
 *
 * Version numbers are something the platform manages; this page is where you go
 * to LOOK at that history, not to operate it. Restoring makes a draft to review
 * — it never silently swaps what is live.
 */
export default function WorkflowVersionsPage({
  params,
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const role = useSessionStore((s) => s.user?.role);
  const shellProps = useAppShellProps();
  const { data: workflow, isLoading } = useWorkflow(params.id);

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
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 pt-2">
        <div className="min-w-0">
          <p className="text-sm text-app-ink-3">Version history</p>
          <h1 className="truncate text-2xl font-bold text-app-ink">
            {workflow?.name ?? 'Workflow'}
          </h1>
        </div>
        <Link
          href={`/workflows/${params.id}`}
          className="text-sm font-medium text-app-ink-2 transition-colors hover:text-app-ink"
        >
          ← Back to the workflow
        </Link>
      </div>

      <p className="mb-4 max-w-2xl text-sm text-app-ink-3">
        Every time you publish, the workflow is saved exactly as it was. Runs
        stay tied to the version they started with, so editing this workflow
        never changes what an older run did.
      </p>

      {isLoading || !workflow ? (
        <p className="text-sm text-app-ink-3">Loading…</p>
      ) : (
        <VersionHistoryPanel
          workflow={workflow}
          canManage={role === 'OWNER' || role === 'ADMIN'}
        />
      )}
    </AppShell>
  );
}
