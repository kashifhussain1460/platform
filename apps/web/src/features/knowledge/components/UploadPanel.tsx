'use client';

import { useState, type ChangeEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { formatRole } from '@/features/employees/labels';
import { EMPLOYEE_ROLES } from '../schemas';
import { useUploadDocument } from '../hooks';
import { ACCEPT_ATTR } from '../upload-batch';
import {
  isUnchosen,
  isWidening,
  toCategory,
  visibilityHelp,
  type VisibilityChoice,
} from '../visibility';

/**
 * Upload control. A <label> wraps a visually-hidden <input type="file">, so the
 * styled button triggers the native picker declaratively — no useRef needed.
 *
 * ## "Visible to" is CONTROLLED by the page
 *
 * The same choice drives this panel and the drag-and-drop zone over the document
 * list, which live in different columns. Owning it here would let someone pick
 * "HR" in the panel and then drop a file into a zone that still thought the
 * answer was "Shared" — the two surfaces must agree or the setting is a lie.
 *
 * ## Why widening asks, and narrowing does not
 *
 * Moving to "Shared" exposes the document to every AI Employee in the company;
 * moving the other way can never expose anything. Confirming both would train
 * people to click through the prompt that actually matters.
 */
export function UploadPanel({
  choice,
  onChoiceChange,
  /** True when the page has no safe default and a choice is mandatory. */
  requireChoice = false,
}: {
  choice: VisibilityChoice;
  onChoiceChange: (next: VisibilityChoice) => void;
  requireChoice?: boolean;
}) {
  const upload = useUploadDocument();
  const [confirmWiden, setConfirmWiden] = useState<VisibilityChoice | null>(null);
  const blocked = isUnchosen(choice);

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && !blocked) {
      upload.mutate({ file, category: toCategory(choice) });
    }
    // Reset so selecting the same file again re-fires onChange.
    e.target.value = '';
  };

  const pick = (next: VisibilityChoice) => {
    if (isWidening(choice, next)) {
      setConfirmWiden(next);
      return;
    }
    onChoiceChange(next);
  };

  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5 transition-colors hover:border-white/[0.14]">
      <h2 className="mb-1 text-sm font-medium text-zinc-400">Upload documents</h2>
      <p className="mb-4 text-sm text-zinc-500">
        Upload .txt, .md, or .pdf files to add them to your knowledge base. You
        can also drag them onto the list.
      </p>

      <label htmlFor="upload-category" className="mb-1 block text-xs font-medium text-zinc-500">
        Visible to{requireChoice ? <span className="text-status-failed"> *</span> : null}
      </label>
      <select
        id="upload-category"
        className={`field-modern w-full ${blocked ? 'border-status-warning/50' : ''}`}
        value={choice}
        onChange={(e) => pick(e.target.value as VisibilityChoice)}
        aria-describedby="upload-category-help"
      >
        {/* Only offered where there is no safe default, and it is not a real
            option — picking it is what unblocks the upload. */}
        {requireChoice ? <option value="">Choose who can read it…</option> : null}
        <option value="SHARED">Shared — every AI Employee</option>
        {EMPLOYEE_ROLES.map((role) => (
          <option key={role} value={role}>
            {formatRole(role)} only
          </option>
        ))}
      </select>
      <p
        id="upload-category-help"
        className={`mb-4 mt-1.5 text-xs ${
          choice === 'SHARED' ? 'text-status-warning' : 'text-zinc-500'
        }`}
      >
        {visibilityHelp(choice)}
      </p>

      {confirmWiden ? (
        <div className="mb-4 rounded-xl border border-status-warning/40 bg-status-warning/10 p-3">
          <p className="flex items-start gap-1.5 text-xs text-status-warning">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Sharing with everyone means every AI Employee — Sales, Marketing,
              Support — can read these documents and quote them in chat.
            </span>
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onChoiceChange(confirmWiden);
                setConfirmWiden(null);
              }}
              className="rounded-lg bg-status-warning/20 px-2.5 py-1 text-xs font-medium text-status-warning hover:bg-status-warning/30"
            >
              Share with everyone
            </button>
            <button
              type="button"
              onClick={() => setConfirmWiden(null)}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              Keep it restricted
            </button>
          </div>
        </div>
      ) : null}

      <label
        className={`inline-flex items-center justify-center rounded-xl bg-[linear-gradient(135deg,#6a30ec_0%,#5216dd_100%)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_14px_34px_-12px_rgba(91,33,230,0.85)] transition-all ${
          upload.isPending || blocked
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:-translate-y-0.5 hover:brightness-110'
        }`}
        title={blocked ? 'Choose who can read it first' : undefined}
      >
        {upload.isPending ? 'Uploading…' : '+ Upload'}
        <input
          type="file"
          className="sr-only"
          accept={ACCEPT_ATTR}
          onChange={onChange}
          disabled={upload.isPending || blocked}
        />
      </label>

      {upload.isError && (
        <p className="mt-2 text-sm text-red-400">
          {upload.error?.message ?? 'Upload failed'}
        </p>
      )}
    </section>
  );
}
