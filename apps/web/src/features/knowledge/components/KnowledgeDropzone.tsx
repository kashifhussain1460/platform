'use client';

import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { AlertTriangle, FileUp, Loader2, Plus, Upload } from 'lucide-react';
import { useUploadDocument } from '../hooks';
import {
  ACCEPTED_EXTENSIONS,
  ACCEPT_ATTR,
  MAX_FILES_PER_UPLOAD,
  planUpload,
} from '../upload-batch';
import {
  isUnchosen,
  ownerVisibilityHelp,
  toCategory,
  visibilityHelp,
  type VisibilityChoice,
} from '../visibility';

/**
 * Drag-and-drop upload over the documents area.
 *
 * ## Why it WRAPS the list instead of being a box above it
 *
 * People drop a file onto the thing they are looking at. With a separate drop
 * box, a drop onto the document list itself lands on the page — and the browser
 * NAVIGATES AWAY to render the file, losing whatever was on screen. Wrapping the
 * whole region means the natural target is the real target, and the empty state
 * becomes the invitation rather than a dead sentence.
 *
 * ## Why there is ALWAYS a visible target
 *
 * The empty state used to be the only affordance, so uploading the first
 * document made the invitation disappear — the second upload had no discoverable
 * route at all. A drop still worked anywhere over the list, but nothing on
 * screen said so, which is the same as it not working. Once the list has rows,
 * a compact strip sits under it and keeps saying "drag more here".
 *
 * ## Why uploads are sequential
 *
 * Each file is its own request and its own ingest job. Firing ten at once gives
 * the customer ten simultaneous progress rows, ten pending ingests, and — on a
 * slow connection — a much better chance that one fails for a reason that has
 * nothing to do with the file. One at a time is slower and far easier to explain
 * when something goes wrong, and `MAX_FILES_PER_UPLOAD` keeps the queue short
 * enough to watch.
 */
export function KnowledgeDropzone({
  choice,
  children,
  /** Shown when the list is empty — the dropzone becomes the empty state. */
  isEmpty = false,
  /**
   * The AI Employee these uploads belong to, when the zone is rendered on that
   * employee's own tab. Naming them ("goes to Anushka") is clearer than naming
   * the scope ("HR"), because the person uploading is thinking about who they
   * are giving the document to, not about a role enum.
   */
  ownerName,
}: {
  choice: VisibilityChoice;
  children: ReactNode;
  isEmpty?: boolean;
  ownerName?: string;
}) {
  const upload = useUploadDocument();
  const [dragging, setDragging] = useState(false);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [deferred, setDeferred] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every child element the pointer crosses, so a
  // plain boolean flickers the whole time the file is over the list. Counting
  // enters minus leaves is the standard fix.
  const dragDepth = useRef(0);

  const blocked = isUnchosen(choice);
  const busy = progress !== null;
  // A second drop mid-batch would interleave two sequential loops through one
  // `progress` counter, so the visible "Uploading 2 of 3" would start lying.
  const closed = blocked || busy;
  // On an employee's own tab there is no decision to make, so state the outcome
  // in terms of the person rather than the role enum.
  const scopeNote = ownerName
    ? ownerVisibilityHelp(ownerName, choice)
    : visibilityHelp(choice);
  const limitNote = `${ACCEPTED_EXTENSIONS.join(', ')} · up to ${MAX_FILES_PER_UPLOAD} at a time`;

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || closed) return;

    const plan = planUpload(Array.from(files));
    setUnreadable(plan.unreadable);
    setDeferred(plan.deferred);
    if (plan.accepted.length === 0) return;

    const category = toCategory(choice);
    setProgress({ done: 0, total: plan.accepted.length });
    for (const [i, file] of plan.accepted.entries()) {
      try {
        await upload.mutateAsync({ file, category });
      } catch {
        // The mutation surfaces its own error and rolls the optimistic row
        // back; carry on so one bad file doesn't abandon the rest of the batch.
      }
      setProgress({ done: i + 1, total: plan.accepted.length });
    }
    setProgress(null);
  };

  const openPicker = () => {
    if (!closed) inputRef.current?.click();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void handleFiles(e.dataTransfer.files);
  };

  return (
    <div
      // preventDefault on dragOver is what makes this a valid drop target;
      // without it the browser opens the file instead.
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={onDrop}
      className="relative"
    >
      {isEmpty ? (
        <button
          type="button"
          onClick={openPicker}
          disabled={closed}
          className={`flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
            closed
              ? 'cursor-not-allowed border-white/[0.08] bg-white/[0.01]'
              : dragging
                ? 'border-violet bg-violet/10'
                : 'border-white/[0.12] bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.04]'
          }`}
        >
          <FileUp
            className={`mb-3 h-8 w-8 ${dragging && !closed ? 'text-violet-secondary' : 'text-zinc-600'}`}
            aria-hidden
          />
          <p className="text-sm font-medium text-zinc-200">
            {blocked
              ? 'Choose who can read these documents first'
              : dragging
                ? 'Drop to upload'
                : 'Drag files here, or click to choose'}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {blocked ? visibilityHelp(choice) : limitNote}
          </p>
          {!blocked ? <p className="mt-3 text-xs text-zinc-500">{scopeNote}</p> : null}
        </button>
      ) : (
        <>
          {children}
          {/* The always-there target once documents exist. Without it, adding a
              second document has no visible route — the drop still works, but
              nothing on screen says so. */}
          <button
            type="button"
            onClick={openPicker}
            disabled={closed}
            className={`mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-4 text-center transition-colors ${
              closed
                ? 'cursor-not-allowed border-white/[0.08] bg-white/[0.01]'
                : 'border-white/[0.12] bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.04]'
            }`}
          >
            <Plus className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
            <span className="text-sm text-zinc-300">
              {blocked ? 'Choose who can read these first' : 'Drag more files here, or click to choose'}
            </span>
            <span className="hidden text-xs text-zinc-500 sm:inline">{limitNote}</span>
          </button>
        </>
      )}

      {/* Overlay for a drag over a NON-empty list: the list stays readable
          underneath, so it is obvious what the files are being added to. */}
      {dragging && !isEmpty ? (
        <div
          className={`pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed backdrop-blur-[1px] ${
            closed
              ? 'border-status-warning/60 bg-void/80'
              : 'border-violet bg-violet/10'
          }`}
        >
          {closed ? (
            <>
              <AlertTriangle className="mb-2 h-6 w-6 text-status-warning" aria-hidden />
              <p className="text-sm font-medium text-status-warning">
                {blocked ? 'Choose who can read these first' : 'Still uploading — wait for this batch'}
              </p>
            </>
          ) : (
            <>
              <Upload className="mb-2 h-6 w-6 text-violet-secondary" aria-hidden />
              <p className="text-sm font-medium text-zinc-100">Drop to upload</p>
              <p className="mt-1 text-xs text-zinc-400">{scopeNote}</p>
              <p className="mt-1 text-xs text-zinc-500">{limitNote}</p>
            </>
          )}
        </div>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        accept={ACCEPT_ATTR}
        onChange={(e) => {
          void handleFiles(e.target.files);
          // Reset so re-picking the same file fires change again.
          e.target.value = '';
        }}
      />

      {progress ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-zinc-400" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}…
        </p>
      ) : null}

      {/* Named, not counted: "1 file skipped" leaves people hunting for which
          one and why. The two lists stay apart because one can never work and
          the other works on the very next drop. */}
      {unreadable.length > 0 ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-status-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Skipped {unreadable.join(', ')} — only {ACCEPTED_EXTENSIONS.join(', ')} can be read.
          </span>
        </p>
      ) : null}

      {deferred.length > 0 ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-zinc-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {MAX_FILES_PER_UPLOAD} at a time — {deferred.join(', ')} {deferred.length === 1 ? 'was' : 'were'}{' '}
            not uploaded. Drop {deferred.length === 1 ? 'it' : 'them'} again once this batch finishes.
          </span>
        </p>
      ) : null}

      {upload.isError ? (
        <p className="mt-2 text-xs text-status-failed">
          {upload.error?.message ?? 'Upload failed'}
        </p>
      ) : null}
    </div>
  );
}
