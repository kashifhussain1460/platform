'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/app-shell/AppShell';
import { useAppShellProps } from '@/components/app-shell/useAppShellProps';
import { DocumentList } from '@/features/knowledge/components/DocumentList';
import { KnowledgeDropzone } from '@/features/knowledge/components/KnowledgeDropzone';
import { useDocuments } from '@/features/knowledge/hooks';
import { UNCHOSEN, type VisibilityChoice } from '@/features/knowledge/visibility';
import { SearchPanel } from '@/features/knowledge/components/SearchPanel';
import { UploadPanel } from '@/features/knowledge/components/UploadPanel';
import { useSessionStore } from '@/stores/session.store';

export default function KnowledgePage() {
  const router = useRouter();
  const accessToken = useSessionStore((s) => s.accessToken);
  const shellProps = useAppShellProps();

  // Client-side route guard, same pattern as the dashboard.
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
      <h1 className="mb-8 pt-2 text-2xl font-bold text-app-ink">Knowledge Base</h1>

      <KnowledgeWorkspace />
    </AppShell>
  );
}

/**
 * The company-wide Knowledge Base workspace.
 *
 * `requireChoice` is ON here, unlike the per-employee tab. This page has NO safe
 * default: it used to default to "Shared (everyone)", so a document uploaded by
 * someone who never opened the dropdown became readable by every AI Employee in
 * the company — including Sales and Marketing quoting an HR file back in chat.
 * Nothing warned anybody, because "I didn't choose" and "share with everyone"
 * were the same value. Now the upload is blocked until a human decides.
 */
function KnowledgeWorkspace() {
  const [choice, setChoice] = useState<VisibilityChoice>(UNCHOSEN);
  const { data: docs } = useDocuments();
  const isEmpty = !docs || docs.length === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <section className="order-2 lg:order-1 lg:col-span-2">
        <h2 className="mb-3 text-sm font-medium text-app-ink-2">Documents</h2>
        <KnowledgeDropzone choice={choice} isEmpty={isEmpty}>
          <DocumentList />
        </KnowledgeDropzone>
      </section>
      <div className="order-1 space-y-6 lg:order-2">
        <UploadPanel choice={choice} onChoiceChange={setChoice} requireChoice />
        <SearchPanel />
      </div>
    </div>
  );
}
