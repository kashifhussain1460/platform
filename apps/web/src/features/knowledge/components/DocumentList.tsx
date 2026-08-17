'use client';

import { ChevronRight, File, FileCode, FileText, type LucideIcon } from 'lucide-react';
import type { DocumentStatus } from '@vaep/types';
import { formatRole } from '@/features/employees/labels';
import { EMPLOYEE_ROLES, type EmployeeRole } from '../schemas';
import { useDeleteDocument, useDocuments, useUpdateDocumentCategory, useViewDocument } from '../hooks';

const STATUS_STYLES: Record<DocumentStatus, string> = {
  PENDING: 'bg-app-raised text-app-ink-2',
  PROCESSING: 'bg-amber-500/15 text-amber-800',
  READY: 'bg-green-500/15 text-green-800',
  FAILED: 'bg-red-500/15 text-red-600',
};

function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

/** Icon + accent chip + short label derived from the document's real mimeType. */
function fileTypeMeta(mimeType: string): { label: string; Icon: LucideIcon; chip: string } {
  if (mimeType === 'application/pdf') {
    return { label: 'PDF', Icon: FileText, chip: 'bg-red-500/15 text-red-600' };
  }
  if (mimeType === 'text/markdown') {
    return { label: 'Markdown', Icon: FileCode, chip: 'bg-sky-500/15 text-sky-800' };
  }
  if (mimeType === 'text/plain') {
    return { label: 'Text', Icon: File, chip: 'bg-green-500/15 text-green-800' };
  }
  return { label: mimeType, Icon: File, chip: 'bg-app-raised text-app-ink-2' };
}

/**
 * Reused by both the global `/knowledge` page (no `category` — shows every
 * document, with the retag dropdown to assign one) and each AI Employee's
 * "Knowledge" tab (`category` = that employee's role — shows that role's
 * documents + Shared, retag dropdown still available).
 */
export function DocumentList({ category }: { category?: EmployeeRole } = {}) {
  const { data: docs, isLoading } = useDocuments(category);
  const del = useDeleteDocument(category);
  const view = useViewDocument();
  const retag = useUpdateDocumentCategory();

  if (isLoading) {
    return <p className="text-sm text-app-ink-3">Loading documents…</p>;
  }

  if (!docs || docs.length === 0) {
    return (
      <p className="text-sm text-app-ink-3">
        No documents yet. Upload one to get started.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-app-border overflow-hidden rounded-2xl border border-app-border bg-app-surface">
      {docs.map((doc) => {
        const isTemp = doc.id.startsWith('temp_');
        const { label, Icon, chip } = fileTypeMeta(doc.mimeType);
        const detail =
          doc.status === 'READY'
            ? `${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'}`
            : doc.status === 'FAILED'
              ? (doc.error ?? 'Ingestion failed')
              : 'Processing…';

        return (
          <li
            key={doc.id}
            className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-app-raised"
          >
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${chip}`}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-app-ink">
                {doc.filename}
              </p>
              <p className="mt-0.5 truncate text-xs text-app-ink-3">
                {label} · {detail}
              </p>
            </div>
            <StatusBadge status={doc.status} />
            <select
              className="field-modern !w-auto shrink-0 !py-1.5 text-xs"
              value={doc.category ?? ''}
              disabled={isTemp || retag.isPending}
              onChange={(e) =>
                retag.mutate({
                  id: doc.id,
                  category: e.target.value === '' ? null : (e.target.value as EmployeeRole),
                })
              }
            >
              <option value="">Shared (everyone)</option>
              {EMPLOYEE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {formatRole(role)}
                </option>
              ))}
            </select>
            <div className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={() => view.mutate(doc.id)}
                disabled={isTemp || view.isPending}
                className="text-xs font-medium text-app-ink-2 transition-colors hover:text-app-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                View
              </button>
              <button
                type="button"
                onClick={() => del.mutate(doc.id)}
                disabled={isTemp || del.isPending}
                className="text-xs font-medium text-app-ink-3 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Delete
              </button>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-app-ink-3" aria-hidden />
          </li>
        );
      })}
    </ul>
  );
}
