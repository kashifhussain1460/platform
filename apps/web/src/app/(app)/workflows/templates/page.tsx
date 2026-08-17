'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { TemplateGallery } from '@/features/workflows/components/builder/TemplateGallery';
import { useSessionStore } from '@/stores/session.store';

/**
 * Template gallery route — pick a pre-built workflow for your AI Employees and set
 * it up in one step (doc 29 §3.A). Installing lands a DRAFT workflow in the builder.
 */
export default function WorkflowTemplatesPage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();

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
        <div>
          <h1 className="text-2xl font-bold text-app-ink">Start from a template</h1>
          <p className="mt-1 text-sm text-app-ink-2">
            Pre-built workflows for your AI Employees. Pick one, set who does the work, and it lands as a draft you can edit.
          </p>
        </div>
        <Link
          href="/workflows"
          className="rounded-xl border border-app-border-strong bg-app-surface px-5 py-2.5 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised"
        >
          ← All workflows
        </Link>
      </div>

      <TemplateGallery />
    </AppShell>
  );
}
