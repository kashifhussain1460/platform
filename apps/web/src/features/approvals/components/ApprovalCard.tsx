'use client';

import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { ApprovalRequestDto } from '@vaep/types';
import {
  useApproveRequest,
  useModifyRequest,
  useRejectRequest,
} from '../hooks';
import { STATUS_STYLES, formatStatus } from '../labels';

// `green-600/90` over the white card composites to rgb(45,172,92), and white on
// that is 2.93 — under AA on the one button in the product that commits a real,
// irreversible action. Solid `green-700` carries white at 5.02.
const APPROVE_CLASS =
  'rounded-lg bg-green-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-60';
const REJECT_CLASS =
  'rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-1.5 text-sm font-medium text-red-800 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60';
const GHOST_CLASS =
  'rounded-lg border border-app-border px-4 py-1.5 text-sm font-medium text-app-ink-2 hover:text-app-ink disabled:cursor-not-allowed disabled:opacity-60';

/** A single approval request row with Approve / Reject / Modify controls. */
export function ApprovalCard({ request }: { request: ApprovalRequestDto }) {
  const approve = useApproveRequest();
  const reject = useRejectRequest();
  const modify = useModifyRequest();

  const [editing, setEditing] = useState(false);
  const [argsText, setArgsText] = useState(() =>
    JSON.stringify(request.args, null, 2),
  );
  const [parseError, setParseError] = useState<string | null>(null);

  const isPending = request.status === 'PENDING';
  const isWorkflow = request.kind === 'WORKFLOW';
  const busy = approve.isPending || reject.isPending || modify.isPending;

  const headline =
    request.description ??
    (isWorkflow ? 'Workflow approval' : `${request.skillKey} · ${request.tool}`);
  const metaLine = isWorkflow
    ? `Workflow run ${request.workflowRunId ?? '—'} · ${new Date(request.createdAt).toLocaleString()}`
    : `${request.skillKey} · ${request.tool}${
        request.employeeId ? ` · Employee ${request.employeeId}` : ''
      } · ${new Date(request.createdAt).toLocaleString()}`;

  const submitModify = () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(argsText) as Record<string, unknown>;
    } catch {
      setParseError('Invalid JSON');
      return;
    }
    setParseError(null);
    modify.mutate({ id: request.id, data: { args: parsed } });
    setEditing(false);
  };

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 p-4 transition-colors hover:bg-app-raised">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet/20 text-violet">
          <Bot className="h-[18px] w-[18px]" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-app-ink">{headline}</p>
            <span className="inline-block rounded-full bg-app-raised px-2 py-0.5 text-xs font-medium text-app-ink-2">
              {isWorkflow ? 'Workflow' : 'Tool'}
            </span>
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[request.status]}`}
            >
              {formatStatus(request.status)}
            </span>
          </div>
          <p className="mt-1 text-xs text-app-ink-2">{metaLine}</p>

          {/* Tool args block: only TOOL-kind requests gate a tool call. */}
          {!isWorkflow &&
            (editing ? (
              <div className="mt-2">
                <textarea
                  className="h-40 w-full rounded-lg border border-app-border bg-app-surface p-2 font-mono text-xs text-app-ink-2 focus:border-violet focus:outline-none"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                />
                {parseError && (
                  <p className="mt-1 text-xs text-red-600">{parseError}</p>
                )}
              </div>
            ) : (
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-app-border bg-app-surface p-2 text-xs text-app-ink-2">
                {JSON.stringify(request.args, null, 2)}
              </pre>
            ))}

          {request.result != null && (
            <div className="mt-2">
              <p className="mb-1 text-xs font-medium text-app-ink-3">Result</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-app-border bg-app-surface p-2 text-xs text-app-ink-2">
                {JSON.stringify(request.result, null, 2)}
              </pre>
            </div>
          )}
          {request.note && (
            <p className="mt-2 text-xs text-app-ink-3">Note: {request.note}</p>
          )}
        </div>
      </div>

      {isPending && (
        <div className="flex shrink-0 items-center gap-2">
          {editing ? (
            <>
              <button onClick={submitModify} disabled={busy} className={APPROVE_CLASS}>
                Save & Approve
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setParseError(null);
                  setArgsText(JSON.stringify(request.args, null, 2));
                }}
                disabled={busy}
                className={GHOST_CLASS}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => approve.mutate({ id: request.id })}
                disabled={busy}
                className={APPROVE_CLASS}
              >
                Approve
              </button>
              <button
                onClick={() => reject.mutate({ id: request.id })}
                disabled={busy}
                className={REJECT_CLASS}
              >
                Reject
              </button>
              {/* Modify edits tool args — not meaningful for a WORKFLOW approval. */}
              {!isWorkflow && (
                <button
                  onClick={() => setEditing(true)}
                  disabled={busy}
                  className={GHOST_CLASS}
                >
                  Modify
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
