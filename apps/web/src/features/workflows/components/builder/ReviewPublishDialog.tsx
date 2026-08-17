'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Loader2,
  Plug,
  X,
} from 'lucide-react';
import type {
  WorkflowDto,
  WorkflowReadinessCheckDto,
  WorkflowReadinessIssueDto,
} from '@vaep/types';
import { Modal } from '@/components/ui/Modal';
import { useEmployees } from '@/features/employees/hooks';
import {
  usePublishAndActivate,
  usePublishWorkflow,
  useWorkflowReadiness,
} from '../../hooks';
import { splitPublishIssues } from './publishIssues';

/**
 * REVIEW & PUBLISH (UX plan §12, §13, §14, §57) — the one surface that replaces
 * "Validate", then "Publish", then "Activate".
 *
 * Two states, and which one you get is decided by the server, not by this
 * component: it opens by fetching `GET /workflows/:id/readiness`, which runs the
 * real validator, the real connection gate and the real activation rules. There
 * is no client-side re-implementation of any rule here — that would drift, and a
 * drifted "looks fine to me" is how a broken workflow gets published.
 *
 * NOT ready → what's wrong, in plain language, each with the action that fixes
 * it. Ready → what is about to happen, then one button.
 */
export function ReviewPublishDialog({
  workflow,
  open,
  onClose,
  onFocusNode,
  onOpenTrigger,
}: {
  workflow: WorkflowDto;
  open: boolean;
  onClose: () => void;
  /** Select a node on the canvas so "Open this step" actually goes somewhere. */
  onFocusNode?: (nodeId: string) => void;
  onOpenTrigger?: () => void;
}) {
  const [changeNote, setChangeNote] = useState('');
  const readiness = useWorkflowReadiness(workflow.id, open);
  const publishAndActivate = usePublishAndActivate(workflow.id);
  const publishOnly = usePublishWorkflow(workflow.id);
  const { data: employees } = useEmployees();

  const pending = publishAndActivate.isPending || publishOnly.isPending;
  const result = publishAndActivate.data ?? publishOnly.data;
  const error = publishAndActivate.error ?? publishOnly.error;

  const close = () => {
    publishAndActivate.reset();
    publishOnly.reset();
    setChangeNote('');
    onClose();
  };

  const blockers = (readiness.data?.issues ?? []).filter(
    (i) => i.severity === 'BLOCKER',
  );
  const warnings = (readiness.data?.issues ?? []).filter(
    (i) => i.severity === 'WARNING',
  );

  const employeeNames = (readiness.data?.summary.employeeIds ?? []).map(
    (id) => employees?.find((e) => e.id === id)?.name ?? 'An AI employee',
  );

  return (
    <Modal open={open} onClose={close} title="Review and publish" size="lg">
      {readiness.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-app-ink-2">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Checking this workflow…
        </p>
      ) : readiness.isError ? (
        <p className="text-sm text-sl-failed">
          Couldn&apos;t check this workflow: {readiness.error.message}
        </p>
      ) : !readiness.data ? null : result ? (
        <PublishOutcome
          versionNumber={result.version.version}
          unchanged={result.unchanged}
          activated={result.activated}
          activationError={result.activationError}
          onClose={close}
        />
      ) : (
        <div className="space-y-5">
          {/* ── What is about to be published ───────────────────────────── */}
          <section className="rounded-xl border border-app-border bg-app-surface p-4">
            <h3 className="mb-3 font-display text-sm font-semibold text-app-ink">
              {readiness.data.summary.name}
            </h3>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <SummaryRow label="Runs" value={readiness.data.summary.triggerSummary} />
              <SummaryRow
                label="Steps"
                value={String(readiness.data.summary.stepCount)}
              />
              <SummaryRow
                label="AI employees"
                value={employeeNames.length ? employeeNames.join(', ') : 'None'}
              />
              <SummaryRow
                label="Skills"
                value={
                  readiness.data.summary.skillKeys.length
                    ? readiness.data.summary.skillKeys.join(', ')
                    : 'None'
                }
              />
              <SummaryRow
                label="Approvals"
                value={
                  readiness.data.summary.approvalCount === 0
                    ? 'None — it runs without asking'
                    : `${readiness.data.summary.approvalCount} step${
                        readiness.data.summary.approvalCount === 1 ? '' : 's'
                      } need sign-off`
                }
              />
            </dl>
          </section>

          {/* ── Blocking issues ─────────────────────────────────────────── */}
          {blockers.length > 0 && (
            <section
              className="rounded-xl border border-status-failed/25 bg-status-failed/[0.07] p-4"
              role="alert"
            >
              <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold text-sl-failed">
                <CircleAlert className="h-4 w-4" aria-hidden />
                {blockers.length === 1
                  ? 'One thing to fix first'
                  : `${blockers.length} things to fix first`}
              </h3>
              <ul className="mt-2 space-y-2">
                {blockers.map((issue, i) => (
                  <IssueRow
                    key={`${issue.code}-${i}`}
                    issue={issue}
                    onFocusNode={(id) => {
                      close();
                      onFocusNode?.(id);
                    }}
                    onOpenTrigger={() => {
                      close();
                      onOpenTrigger?.();
                    }}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* ── Advisory notes ──────────────────────────────────────────── */}
          {warnings.length > 0 && (
            <section className="rounded-xl border border-status-waiting/25 bg-status-waiting/[0.07] p-4">
              <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold text-sl-waiting">
                <AlertTriangle className="h-4 w-4" aria-hidden />
                Worth knowing
              </h3>
              <ul className="mt-2 space-y-2">
                {warnings.map((issue, i) => (
                  <IssueRow
                    key={`${issue.code}-${i}`}
                    issue={issue}
                    tone="warn"
                    onFocusNode={(id) => {
                      close();
                      onFocusNode?.(id);
                    }}
                    onOpenTrigger={() => {
                      close();
                      onOpenTrigger?.();
                    }}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* ── The checks that ran ─────────────────────────────────────── */}
          <section>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-app-ink-3">
              Checks
            </h3>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {readiness.data.checks.map((check) => (
                <CheckRow key={check.key} check={check} />
              ))}
            </ul>
          </section>

          {readiness.data.ready && (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-app-ink-2">
                  What changed? (optional — it goes in the version history)
                </span>
                <input
                  value={changeNote}
                  onChange={(e) => setChangeNote(e.target.value)}
                  placeholder="e.g. Added the recruiter approval step"
                  className="w-full rounded-lg border border-app-border bg-app-raised px-3 py-2 text-sm text-app-ink outline-none placeholder:text-app-ink-3 focus-visible:ring-2 focus-visible:ring-wf-focus"
                />
              </label>

              <p className="text-sm text-app-ink-2">
                Publishing saves this as a new version. Runs that are already
                going keep using the version they started with.
                {readiness.data.summary.hasExternalActions && (
                  <>
                    {' '}
                    <span className="text-sl-waiting">
                      Once it&apos;s live, this workflow can send messages and
                      change things in the tools it&apos;s connected to.
                    </span>
                  </>
                )}
              </p>
            </>
          )}

          {error && (
            <div className="rounded-xl border border-status-failed/25 bg-status-failed/[0.07] p-3 text-sm text-sl-failed">
              <p className="font-medium">Couldn&apos;t publish.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {splitPublishIssues(error.message).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-app-border pt-4">
            <button
              type="button"
              onClick={close}
              className="rounded-lg border border-app-border px-4 py-2 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:text-app-ink"
            >
              {readiness.data.ready ? 'Cancel' : 'Back to the builder'}
            </button>

            {readiness.data.ready && (
              <>
                {/* Advanced escape hatch (§14): publish a version without
                    arming the trigger. Deliberately secondary — the default is
                    the thing almost everyone wants. */}
                <button
                  type="button"
                  onClick={() =>
                    publishOnly.mutate({ changeNote: changeNote.trim() || undefined })
                  }
                  disabled={pending}
                  className="rounded-lg border border-app-border px-4 py-2 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:text-app-ink disabled:opacity-50"
                >
                  Publish without turning it on
                </button>
                <button
                  type="button"
                  onClick={() =>
                    publishAndActivate.mutate({
                      changeNote: changeNote.trim() || undefined,
                    })
                  }
                  disabled={pending}
                  className="rounded-lg bg-violet px-5 py-2 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-60"
                >
                  {pending ? 'Publishing…' : 'Publish & turn on'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-app-ink-3">{label}:</dt>
      <dd className="min-w-0 break-words text-app-ink">{value}</dd>
    </div>
  );
}

function CheckRow({ check }: { check: WorkflowReadinessCheckDto }) {
  const icon =
    check.status === 'PASS' ? (
      <Check className="h-4 w-4 shrink-0 text-sl-succeeded" aria-hidden />
    ) : check.status === 'WARN' ? (
      <AlertTriangle className="h-4 w-4 shrink-0 text-sl-waiting" aria-hidden />
    ) : (
      <X className="h-4 w-4 shrink-0 text-sl-failed" aria-hidden />
    );

  return (
    <li className="flex items-center gap-2 text-sm text-app-ink-2">
      {icon}
      {check.label}
    </li>
  );
}

function IssueRow({
  issue,
  tone = 'bad',
  onFocusNode,
  onOpenTrigger,
}: {
  issue: WorkflowReadinessIssueDto;
  tone?: 'bad' | 'warn';
  onFocusNode: (nodeId: string) => void;
  onOpenTrigger: () => void;
}) {
  const colour = tone === 'bad' ? 'text-sl-failed' : 'text-sl-waiting';

  return (
    <li className={`text-sm ${colour}`}>
      <span>{issue.message}</span>{' '}
      {issue.fix?.kind === 'CONNECT_SKILL' ? (
        <Link
          href="/skills"
          className="inline-flex items-center gap-1 font-medium underline hover:no-underline"
        >
          <Plug className="h-3.5 w-3.5" aria-hidden />
          Connect it
        </Link>
      ) : issue.fix?.kind === 'OPEN_NODE' && issue.fix.target ? (
        <button
          type="button"
          onClick={() => onFocusNode(issue.fix!.target as string)}
          className="font-medium underline hover:no-underline"
        >
          Open this step
        </button>
      ) : issue.fix?.kind === 'OPEN_TRIGGER' ? (
        <button
          type="button"
          onClick={onOpenTrigger}
          className="font-medium underline hover:no-underline"
        >
          Open the trigger
        </button>
      ) : null}
    </li>
  );
}

/**
 * What actually happened. `activationError` is the case worth being careful
 * about: publish committed a version but activation was refused, so saying
 * "published and live" would be a lie and saying "failed" would be a different
 * lie.
 */
function PublishOutcome({
  versionNumber,
  unchanged,
  activated,
  activationError,
  onClose,
}: {
  versionNumber: number;
  unchanged: boolean;
  activated: boolean;
  activationError: string | null;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      {activationError ? (
        <div className="rounded-xl border border-status-waiting/25 bg-status-waiting/[0.07] p-4">
          <p className="font-display text-sm font-semibold text-sl-waiting">
            Published v{versionNumber}, but it isn&apos;t live yet
          </p>
          <p className="mt-1 text-sm text-app-ink-2">{activationError}</p>
          <p className="mt-1 text-sm text-app-ink-3">
            Fix that and turn it on from the workflow page — you don&apos;t need
            to publish again.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-status-succeeded/25 bg-status-succeeded/[0.07] p-4">
          <p className="flex items-center gap-2 font-display text-sm font-semibold text-sl-succeeded">
            <Check className="h-4 w-4" aria-hidden />
            {unchanged
              ? `Already up to date — v${versionNumber} is the live version`
              : `Published v${versionNumber}`}
          </p>
          <p className="mt-1 text-sm text-app-ink-2">
            {activated
              ? 'It’s on. New runs will use this version; runs already going keep the version they started with.'
              : 'It’s saved as a version but not turned on yet.'}
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-violet px-5 py-2 text-sm font-semibold text-white transition-colors hover:brightness-110"
        >
          Done
        </button>
      </div>
    </div>
  );
}
