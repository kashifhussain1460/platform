'use client';

import { useState } from 'react';
import type { WorkflowDto, WorkflowVersionDto, WorkflowVersionStatus } from '@vaep/types';
import { Modal } from '@/components/ui/Modal';
import { useRestoreVersion, useWorkflowVersions } from '../../hooks';
import { formatRelativeTime } from '@/lib/time';
import { VersionViewer } from './VersionViewer';

// Literal class strings per version status (Tailwind JIT).
const VERSION_STATUS_CLS: Record<WorkflowVersionStatus, string> = {
  DRAFT: 'bg-app-raised text-app-ink-2',
  PUBLISHED: 'bg-status-succeeded/10 text-sl-succeeded',
  DEPRECATED: 'bg-app-raised text-app-ink-3',
  ARCHIVED: 'bg-app-raised text-app-ink-3',
};

const linkBtn =
  'text-xs font-medium text-app-ink-2 transition-colors hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus rounded';

/**
 * VersionHistoryPanel — the workflow's published version history (doc 29 §3.E).
 * Each publish freezes an immutable version; you can preview any version's graph
 * read-only, and (OWNER/ADMIN) restore one as the working draft to edit + re-publish.
 */
export function VersionHistoryPanel({
  workflow,
  canManage,
}: {
  workflow: WorkflowDto;
  canManage: boolean;
}) {
  const { data: versions, isLoading, isError, error } = useWorkflowVersions(workflow.id);
  const restore = useRestoreVersion(workflow.id);
  const [viewerVersion, setViewerVersion] = useState<WorkflowVersionDto | null>(null);
  const [restoreVersion, setRestoreVersion] = useState<WorkflowVersionDto | null>(null);

  const doRestore = () => {
    if (!restoreVersion) return;
    restore.mutate(
      { definition: restoreVersion.definition },
      { onSuccess: () => setRestoreVersion(null) },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl border border-app-border bg-app-surface" />
        ))}
      </div>
    );
  }

  if (isError) {
    return <p className="text-sm text-sl-failed">{error.message}</p>;
  }

  if (!versions || versions.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No versions yet. Publishing this workflow saves an immutable version here.
      </p>
    );
  }

  return (
    <>
      <ol className="space-y-2">
        {versions.map((v) => {
          const isActive = v.id === workflow.activeVersionId;
          return (
            <li
              key={v.id}
              className={`rounded-xl border p-3 ${
                isActive ? 'border-violet-secondary/40 bg-violet/[0.06]' : 'border-app-border bg-app-surface'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-display text-sm font-semibold text-app-ink">v{v.version}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${VERSION_STATUS_CLS[v.status]}`}
                >
                  {v.status}
                </span>
                {isActive ? (
                  <span className="rounded-full bg-violet/15 px-2 py-0.5 text-[10px] font-medium text-violet">
                    Live
                  </span>
                ) : null}
                <span className="ml-auto text-xs text-app-ink-3">
                  {formatRelativeTime(v.publishedAt ?? v.createdAt)}
                </span>
              </div>
              {v.changeNote ? <p className="mt-1.5 text-xs text-app-ink-2">{v.changeNote}</p> : null}
              <div className="mt-2 flex items-center gap-4">
                <button type="button" className={linkBtn} onClick={() => setViewerVersion(v)}>
                  View
                </button>
                {canManage && !isActive ? (
                  <button
                    type="button"
                    className={linkBtn}
                    onClick={() => setRestoreVersion(v)}
                  >
                    Restore
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <VersionViewer
        workflow={workflow}
        version={viewerVersion}
        onClose={() => setViewerVersion(null)}
      />

      <Modal
        open={restoreVersion !== null}
        onClose={() => setRestoreVersion(null)}
        title={restoreVersion ? `Restore v${restoreVersion.version}?` : 'Restore'}
        size="md"
      >
        <p className="text-sm text-app-ink-2">
          This replaces your current draft with this version&apos;s steps. Nothing goes live until
          you publish — you can review and edit first.
        </p>
        {restore.isError ? (
          <p className="mt-2 text-sm text-sl-failed">{restore.error.message}</p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setRestoreVersion(null)}
            className="rounded-lg border border-app-border px-4 py-1.5 text-sm font-medium text-app-ink-2 hover:text-app-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doRestore}
            disabled={restore.isPending}
            className="rounded-lg bg-violet px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-60"
          >
            {restore.isPending ? 'Restoring…' : 'Restore as draft'}
          </button>
        </div>
      </Modal>
    </>
  );
}
