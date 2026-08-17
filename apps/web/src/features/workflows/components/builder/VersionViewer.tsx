'use client';

import type { WorkflowDto, WorkflowVersionDto } from '@vaep/types';
import { Modal } from '@/components/ui/Modal';
import { formatRelativeTime } from '@/lib/time';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';

/**
 * VersionViewer — preview a past version's graph read-only (doc 29 §3.E). Reuses
 * the canvas via `definitionOverride`, so an old version renders with the exact
 * same node language, in a modal.
 */
export function VersionViewer({
  workflow,
  version,
  onClose,
}: {
  workflow: WorkflowDto;
  /** The version to show; null closes the modal. */
  version: WorkflowVersionDto | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={version !== null}
      onClose={onClose}
      title={version ? `Version v${version.version}` : 'Version'}
      size="xl"
    >
      {version ? (
        <div>
          <p className="mb-3 text-sm text-app-ink-2">
            {version.changeNote || 'No change note.'}
            <span className="ml-2 text-app-ink-3">
              {version.status} ·{' '}
              {formatRelativeTime(version.publishedAt ?? version.createdAt)}
            </span>
          </p>
          <WorkflowCanvas
            workflow={workflow}
            mode="preview"
            definitionOverride={version.definition}
          />
        </div>
      ) : null}
    </Modal>
  );
}
