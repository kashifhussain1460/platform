'use client';

import { useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import {
  KNOWLEDGE_UPLOAD_ALLOWED_EXTENSIONS,
  KNOWLEDGE_UPLOAD_DEFAULT_MAX_BYTES,
} from '@vaep/types';
import { useDeleteDocument, useDocuments, useUploadDocument } from '@/features/knowledge/hooks';
import { useActiveEmployee } from '../../useActiveEmployee';
import { useOnboardingWizardStore } from '../../wizardStore';
import { EmployeeContextHeader } from '../EmployeeContextHeader';
import { FlowShell } from '../FlowShell';
import { StepFooter } from '../StepFooter';

// Sourced from `@vaep/types` so this can't drift from the server's allow-list
// (apps/api/src/common/config/credit-abuse.constants.ts). The size ceiling is
// the server's *default* only — an env-set `KNOWLEDGE_UPLOAD_MAX_BYTES`
// override isn't visible here. The server is the real enforcement point;
// this is a fast, no-round-trip first check, not the source of truth.
const MAX_UPLOAD_BYTES = KNOWLEDGE_UPLOAD_DEFAULT_MAX_BYTES;

function isAllowedFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return (KNOWLEDGE_UPLOAD_ALLOWED_EXTENSIONS as readonly string[]).some((ext) => lower.endsWith(ext));
}

export function KnowledgeStep() {
  const goToStep = useOnboardingWizardStore((s) => s.goToStep);
  const {
    employee,
    isLoading: employeeLoading,
    isError: employeeIsError,
    error: employeeError,
    refetch: refetchEmployee,
  } = useActiveEmployee();
  const [dragOver, setDragOver] = useState(false);
  // Surfaces the most recent upload/delete failure inline — both mutations
  // optimistically update the documents cache and roll back on error (see
  // hooks.ts), which otherwise reads as a drop/click that silently did
  // nothing (Tasks 10/11's lesson: a rollback with no visible message).
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const backToHub = () => goToStep('configureEmployees');

  // Real backend semantics: documents are scoped by `employee.role` (an
  // EmployeeRole category shared by every AI employee of that role in the
  // company), not by `employee.id`. Every call below — the list query, the
  // upload category, and the delete cache key — must pass the same `role` so
  // this view and the mutations agree on which list they're touching.
  const docsQuery = useDocuments(employee?.role);
  const docs = docsQuery.data ?? [];
  const upload = useUploadDocument();
  const remove = useDeleteDocument(employee?.role);

  // Distinguish "still resolving the active employee" (routine on a cold
  // sessionStorage-resumed sub-step, e.g. a page refresh mid-wizard) and "the
  // employees query genuinely failed" from a real, resolved absence — the
  // three used to collapse into the same "No AI Employee selected yet."
  // message, which is a harmless flash in the first case but a permanent,
  // wrong, dead-end claim with no retry in the second.
  if (employeeLoading) {
    return (
      <FlowShell heading="Knowledge">
        <p className="text-sm text-fg-muted">Loading your AI Employee…</p>
      </FlowShell>
    );
  }

  if (employeeIsError) {
    return (
      <FlowShell heading="Knowledge">
        <p className="text-sm text-red-400">
          Couldn't load your AI Employees. {employeeError?.message ?? 'Please try again.'}
        </p>
        <StepFooter onBack={backToHub} onContinue={() => void refetchEmployee()} continueLabel="Retry" />
      </FlowShell>
    );
  }

  if (!employee) {
    return (
      <FlowShell heading="Knowledge">
        <p className="text-sm text-fg-muted">No AI Employee selected yet.</p>
        <StepFooter onBack={backToHub} onContinue={backToHub} />
      </FlowShell>
    );
  }

  // Load gate (same lesson Tasks 9/10 had to add after review): don't render
  // the upload dropzone or document list as interactive before the documents
  // query has actually resolved. Before that, `docs` is an empty placeholder,
  // so an upload could look like the very first document for this role when
  // in fact others already exist, and a stray click on an as-yet-unrendered
  // remove button could never happen — but rendering the zone "live" this
  // early is still the same class of premature-interactivity bug.
  if (!docsQuery.isSuccess) {
    if (docsQuery.isError) {
      return (
        <FlowShell heading="Knowledge">
          <EmployeeContextHeader employee={employee} />
          <p className="text-sm text-red-400">
            Couldn't load knowledge documents. {docsQuery.error?.message ?? 'Please try again.'}
          </p>
          <StepFooter onBack={backToHub} onContinue={() => void docsQuery.refetch()} continueLabel="Retry" />
        </FlowShell>
      );
    }
    return (
      <FlowShell heading="Knowledge">
        <EmployeeContextHeader employee={employee} />
        <p className="text-sm text-fg-muted">Loading knowledge documents…</p>
      </FlowShell>
    );
  }

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setActionError(null);
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      // Live-discovered bug (fixed here): this used to upload every file
      // regardless of type — a renamed .png was accepted and marked READY,
      // even though only PDF/DOCX have real text extractors server-side; a
      // non-text file falls through to a raw UTF-8 decode of its bytes,
      // silently corrupting the knowledge base with garbled chunks and no
      // error anywhere. The server now rejects these too (defense in depth);
      // this check just avoids the round trip for the common case.
      if (!isAllowedFile(file)) {
        rejected.push(file.name);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        rejected.push(file.name);
        continue;
      }
      upload.mutate(
        { file, category: employee.role },
        { onError: (err) => setActionError(err.message || `Couldn't upload ${file.name}.`) },
      );
    }
    if (rejected.length > 0) {
      setActionError(
        `${rejected.join(', ')} ${rejected.length === 1 ? "wasn't" : "weren't"} uploaded — only PDF, DOCX, TXT, or MD files up to 20MB are supported.`,
      );
    }
  };

  const removeDoc = (id: string, filename: string) => {
    setActionError(null);
    remove.mutate(id, { onError: (err) => setActionError(err.message || `Couldn't remove ${filename}.`) });
  };

  return (
    <FlowShell
      heading={`Add Knowledge for ${employee.name}`}
      subtitle={`Shared with every ${employee.role} AI employee at your company — not just ${employee.name}. Anyone in that role can see and use what you upload here.`}
    >
      <EmployeeContextHeader employee={employee} />

      {actionError && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {actionError}
        </p>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragOver ? 'border-violet-secondary bg-violet/[0.06]' : 'border-white/[0.12]'
        }`}
      >
        <Upload className="mx-auto h-8 w-8 text-violet-secondary" />
        <p className="mt-3 text-sm text-zinc-300">Drag and drop files here</p>
        <p className="mt-1 text-xs text-fg-muted">PDF, DOCX, TXT, MD (Max 20MB)</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-4 rounded-xl border border-white/[0.1] px-4 py-2 text-sm font-medium text-zinc-300 hover:border-white/[0.2]"
        >
          Browse Files
        </button>
      </div>

      {docs.length > 0 && (
        <ul className="mt-5 space-y-2">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <FileText className="h-4 w-4 shrink-0 text-violet-secondary" />
                <span className="truncate text-sm text-zinc-200">{doc.filename}</span>
                <span className="shrink-0 text-xs text-fg-muted">{doc.status}</span>
              </div>
              <button
                type="button"
                aria-label={`Remove ${doc.filename}`}
                onClick={() => removeDoc(doc.id, doc.filename)}
                className="text-fg-muted hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <StepFooter onBack={backToHub} onContinue={backToHub} continueLabel="Save & Back to Hub →" />
    </FlowShell>
  );
}
