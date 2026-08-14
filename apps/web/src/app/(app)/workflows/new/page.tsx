'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { CreateWorkflowChooser } from '@/features/workflows/components/CreateWorkflowChooser';
import { useSessionStore } from '@/stores/session.store';

/**
 * `/workflows/new` — the one place a workflow starts (UX plan §5, §53).
 *
 * Replaces three competing controls on the list page (an inline create form, an
 * inline AI chat, and a template link) with a single choice that both paths
 * lead out of into the same editor.
 */
export default function NewWorkflowPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const role = useSessionStore((s) => s.user?.role);
  const shellProps = useAppShellProps();

  useEffect(() => {
    if (!accessToken) {
      router.replace('/login');
    }
  }, [accessToken, router]);

  if (!accessToken) {
    return null;
  }

  // Creating a workflow is OWNER/ADMIN server-side. Saying so up front beats
  // letting someone fill in a prompt and then hit a 403.
  const canCreate = role === 'OWNER' || role === 'ADMIN';

  return (
    <AppShell {...shellProps}>
      <div className="mb-6 flex items-center justify-between gap-4 pt-2">
        <div>
          <h1 className="text-2xl font-bold text-white">Create a workflow</h1>
          <p className="mt-1 text-sm text-zinc-500">
            How do you want to build it?
          </p>
        </div>
        <Link
          href="/workflows"
          className="text-sm font-medium text-zinc-400 transition-colors hover:text-white"
        >
          ← Workflows
        </Link>
      </div>

      {canCreate ? (
        <CreateWorkflowChooser />
      ) : (
        <p className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-4 text-sm text-zinc-400">
          Only owners and admins can create workflows. Ask one of them to set
          this up, or to give you admin access.
        </p>
      )}
    </AppShell>
  );
}
