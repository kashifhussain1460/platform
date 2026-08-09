'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Loader2, Plug, ShieldAlert } from 'lucide-react';
import type {
  SkillRequirementStatus,
  WorkflowSkillRequirementDto,
} from '@vaep/types';
import {
  authorizeOAuth,
  getSkillRequirements,
  installSkill,
} from '@/features/skills/api';

/**
 * The in-chat "connect a skill" card (doc 30 §12). Renders the workflow's
 * connection-requiring skills with live status, and connects them WITHOUT
 * leaving the AI Assist session — OAuth returns to `/assist/<id>` so the
 * conversation resumes where it paused.
 *
 * Guided + sequential: already-connected skills show as a done/disabled row, and
 * only the NEXT unconnected skill is actionable, so the user works through them
 * one at a time. Connecting one reloads via the OAuth round-trip, that skill
 * flips to done, and the following one becomes active.
 *
 * It never sees a credential: connecting redirects the browser to the provider
 * via a server-signed authorize URL; the callback stores the token server-side.
 */
export function SkillRequirementCard({
  requirements,
  sessionId,
  onResume,
  resuming = false,
}: {
  requirements: WorkflowSkillRequirementDto[];
  sessionId: string;
  onResume?: () => void;
  resuming?: boolean;
}) {
  const skillKeys = requirements.map((r) => r.skillKey);

  // Live status. `initialData` is the message snapshot; force a fresh fetch on
  // mount (the app's default staleTime is 30s, which would otherwise keep the
  // stale "not connected" snapshot after the user returns from connecting).
  const { data } = useQuery({
    queryKey: ['skill-requirements', ...[...skillKeys].sort()],
    queryFn: () => getSkillRequirements(skillKeys),
    initialData: {
      requirements,
      missingRequiredCount: requirements.filter(
        (r) => r.requiresConnection && r.status !== 'READY',
      ).length,
      allRequiredReady: requirements.every(
        (r) => !r.requiresConnection || r.status === 'READY',
      ),
    },
    enabled: skillKeys.length > 0,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  // Only connectable skills; connected ones sink to the bottom as done rows.
  const rows = [...data.requirements.filter((r) => r.requiresConnection)].sort(
    (a, b) => (a.status === 'READY' ? 1 : 0) - (b.status === 'READY' ? 1 : 0),
  );
  if (rows.length === 0) return null;

  const readyCount = rows.filter((r) => r.status === 'READY').length;
  const allReady = readyCount === rows.length;
  // The one skill the user acts on next — the first that isn't connected.
  const activeKey = rows.find((r) => r.status !== 'READY')?.skillKey;

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
        <Plug className="h-3.5 w-3.5 text-violet-secondary" aria-hidden />
        {allReady ? 'Skills connected' : 'Connect these skills'}
      </p>
      <p className="mb-3 text-xs text-zinc-500">
        {allReady
          ? 'Everything this workflow needs is connected.'
          : `Your workflow needs these before it can run — ${readyCount} of ${rows.length} connected. Connect the next one and Orlixa will carry on.`}
      </p>

      <ul className="space-y-2">
        {rows.map((r) => (
          <SkillRow
            key={r.skillKey}
            req={r}
            sessionId={sessionId}
            done={r.status === 'READY'}
            active={r.skillKey === activeKey}
          />
        ))}
      </ul>

      {allReady && onResume ? (
        <button
          type="button"
          onClick={onResume}
          disabled={resuming}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-violet px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-violet/90 disabled:cursor-not-allowed disabled:bg-violet/30"
        >
          {resuming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          )}
          {resuming ? 'Continuing…' : 'Continue building'}
        </button>
      ) : null}
    </div>
  );
}

function SkillRow({
  req,
  sessionId,
  done,
  active,
}: {
  req: WorkflowSkillRequirementDto;
  sessionId: string;
  /** Already connected — rendered disabled/done. */
  done: boolean;
  /** The next skill to connect — the only actionable row. */
  active: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS_META[req.status] ?? STATUS_META.ERROR;

  const connectOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      let installedId = req.installedSkillId;
      if (!installedId) {
        const installed = await installSkill({ skillKey: req.skillKey });
        installedId = installed.id;
      }
      const { url } = await authorizeOAuth(installedId, `/assist/${sessionId}`);
      window.location.href = url; // full redirect; the callback brings us back
    } catch {
      setBusy(false);
      setError('Couldn’t start the connection. Try again.');
    }
  };

  return (
    <li
      className={`rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 ${done ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-100">{req.displayName}</p>
          <p className="truncate text-xs text-zinc-500">
            {req.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join(' · ') || 'Skill'}
          </p>
        </div>
        <span className={`shrink-0 text-xs font-medium ${status.className}`}>
          {done ? 'Connected' : status.label}
        </span>
      </div>

      {done ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-status-succeeded">
          <Check className="h-3.5 w-3.5" aria-hidden />
          Connected — nothing more to do here.
        </p>
      ) : !req.canManageConnection ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-status-warning">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
          An owner or admin needs to connect this.
        </p>
      ) : req.connectionType === 'oauth' ? (
        <div className="mt-2">
          {active ? (
            <button
              type="button"
              onClick={connectOAuth}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-violet/40 bg-violet/15 px-2.5 py-1.5 text-xs font-medium text-violet-secondary transition-colors hover:bg-violet/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {busy ? 'Opening…' : `Connect ${req.displayName}`}
            </button>
          ) : (
            // Not the current step — connect the earlier skill(s) first.
            <button
              type="button"
              disabled
              title="Connect the skill above first"
              className="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-xs font-medium text-zinc-500"
            >
              Up next
            </button>
          )}
          {error ? <p className="mt-1.5 text-xs text-status-failed">{error}</p> : null}
        </div>
      ) : (
        // Manual (api-key) skills are configured on the Skills page — the card
        // never renders a credential form the model could have shaped.
        <Link
          href="/skills"
          className={`mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.06] ${active ? '' : 'pointer-events-none opacity-50'}`}
        >
          Set up on the Skills page
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      )}
    </li>
  );
}

/** Status → label + colour. Covers every state the contract can carry. */
const STATUS_META: Record<SkillRequirementStatus, { label: string; className: string }> = {
  READY: { label: 'Connected', className: 'text-status-succeeded' },
  NOT_CONNECTED: { label: 'Not connected', className: 'text-zinc-400' },
  AUTHORIZING: { label: 'Authorising…', className: 'text-violet-secondary' },
  CONFIGURATION_REQUIRED: { label: 'Needs setup', className: 'text-status-warning' },
  VALIDATING: { label: 'Checking…', className: 'text-violet-secondary' },
  DEGRADED: { label: 'Degraded', className: 'text-status-warning' },
  DISCONNECTED: { label: 'Reconnect needed', className: 'text-status-failed' },
  EXPIRED: { label: 'Expired', className: 'text-status-failed' },
  REVOKED: { label: 'Revoked', className: 'text-status-failed' },
  INSUFFICIENT_PERMISSION: { label: 'Missing permission', className: 'text-status-warning' },
  ERROR: { label: 'Unavailable', className: 'text-status-failed' },
};

const CAPABILITY_LABEL: Record<string, string> = {
  EMAIL_SEND: 'Send email',
  EMAIL_READ: 'Read email',
  CALENDAR_EVENT_CREATE: 'Create events',
  MESSAGING_SEND: 'Send messages',
  CRM_WRITE: 'Update CRM',
  ISSUE_TRACKING_WRITE: 'Manage issues',
  ISSUE_TRACKING_READ: 'Read issues',
  FILE_STORAGE_WRITE: 'Manage files',
  FILE_STORAGE_READ: 'Read files',
  PAYMENTS_WRITE: 'Create payments',
  PAYMENTS_READ: 'Read payments',
  SOCIAL_PUBLISH: 'Publish posts',
  SUPPORT_REPLY: 'Reply to support',
  HTTP_REQUEST: 'Call an API',
};
