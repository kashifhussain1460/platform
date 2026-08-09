'use client';

import { useState } from 'react';
import { History } from 'lucide-react';
import type { WorkflowDto } from '@vaep/types';
import {
  useActivateWorkflow,
  useDeactivateWorkflow,
  usePublishWorkflow,
  useWorkflowVersions,
} from '../../hooks';
import { LifecycleBadge } from './LifecycleBadge';
import { splitPublishIssues } from './publishIssues';
import { VersionHistoryPanel } from './VersionHistoryPanel';
import { formatRelativeTime } from '@/lib/time';

const secondaryBtn =
  'inline-flex items-center gap-1.5 rounded-lg border border-wf-hairline px-3 py-1.5 text-sm font-medium text-wf-ink-2 transition-colors hover:border-wf-hairline-hover hover:text-wf-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus';

/**
 * BuilderLifecycleBar — the publish / activate / version-history controls (doc 29
 * §3.E). Publish snapshots the latest saved graph into an immutable version;
 * Activate arms the trigger. Everything here is OWNER/ADMIN-only (matches the
 * server @Roles); a member sees the state badge only.
 */
export function BuilderLifecycleBar({
  workflow,
  canManage,
}: {
  workflow: WorkflowDto;
  canManage: boolean;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [changeNote, setChangeNote] = useState('');

  const publish = usePublishWorkflow(workflow.id);
  const activate = useActivateWorkflow();
  const deactivate = useDeactivateWorkflow();
  const { data: versions } = useWorkflowVersions(workflow.id);

  const isArchived = workflow.status === 'ARCHIVED';
  const isActive = workflow.status === 'ACTIVE';
  const canActivate = (workflow.definition?.nodes ?? []).some((n) => n.type !== 'TRIGGER');
  const publishIssues = publish.error ? splitPublishIssues(publish.error.message) : [];
  const activeVersionNumber = versions?.find((v) => v.id === workflow.activeVersionId)?.version;
  const togglePending = activate.isPending || deactivate.isPending;

  const doPublish = () => {
    publish.mutate(
      { changeNote: changeNote.trim() || undefined },
      {
        onSuccess: () => {
          setShowPublish(false);
          setChangeNote('');
        },
      },
    );
  };

  return (
    <div className="rounded-2xl border border-wf-hairline bg-void-section p-3">
      <div className="flex flex-wrap items-center gap-3">
        <LifecycleBadge workflow={workflow} />
        <span className="rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-wf-ink-3">
          {activeVersionNumber ? `v${activeVersionNumber}` : 'draft'} · saved{' '}
          {formatRelativeTime(workflow.updatedAt)}
        </span>

        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-pressed={showHistory}
            className={secondaryBtn}
          >
            <History className="h-4 w-4" aria-hidden />
            History
          </button>

          {canManage && !isArchived && (
            <>
              <span className="flex items-center gap-2">
                <span className="text-sm text-wf-ink-2">Active</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isActive}
                  aria-label={isActive ? 'Deactivate workflow' : 'Activate workflow'}
                  onClick={() =>
                    isActive ? deactivate.mutate(workflow.id) : activate.mutate(workflow.id)
                  }
                  disabled={togglePending || (!isActive && !canActivate)}
                  title={!isActive && !canActivate ? 'Add at least one step first.' : undefined}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    isActive ? 'bg-status-succeeded' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      isActive ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </span>

              <button
                type="button"
                onClick={() => setShowPublish((v) => !v)}
                aria-expanded={showPublish}
                className="rounded-lg bg-violet px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus"
              >
                Publish
              </button>
            </>
          )}
        </div>
      </div>

      {/* Publish panel */}
      {showPublish && canManage && (
        <div className="mt-3 rounded-xl border border-wf-hairline bg-void-card p-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-wf-ink-2">
              What changed? (optional)
            </span>
            <input
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              placeholder="e.g. Added the recruiter approval step"
              className="w-full rounded-lg border border-wf-hairline bg-void-section px-3 py-2 text-sm text-wf-ink outline-none placeholder:text-wf-ink-3 focus-visible:ring-2 focus-visible:ring-wf-focus"
            />
          </label>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowPublish(false)}
              className={secondaryBtn}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={doPublish}
              disabled={publish.isPending}
              className="rounded-lg bg-violet px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-60"
            >
              {publish.isPending ? 'Publishing…' : 'Publish version'}
            </button>
          </div>
        </div>
      )}

      {/* Result / error line — the backend's authoritative validation, listed */}
      {(publish.isSuccess || publish.isError) && !showPublish && (
        <div className="mt-2 text-xs" aria-live="polite">
          {publish.isError ? (
            publishIssues.length > 1 ? (
              <div className="text-status-failed">
                <p className="font-medium">This workflow isn&apos;t ready to publish:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {publishIssues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <span className="text-status-failed">
                {publishIssues[0] ?? publish.error.message}
              </span>
            )
          ) : publish.data?.unchanged ? (
            <span className="text-wf-ink-3">No changes to publish — the live version already matches.</span>
          ) : (
            <span className="text-status-succeeded">
              Published v{publish.data?.version.version}.
            </span>
          )}
        </div>
      )}

      {showHistory && (
        <div className="mt-3">
          <VersionHistoryPanel workflow={workflow} canManage={canManage} />
        </div>
      )}
    </div>
  );
}
