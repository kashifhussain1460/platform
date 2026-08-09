'use client';

import { AlertTriangle, Check, Loader2 } from 'lucide-react';

/**
 * The Architect stage rail (doc 31 §1.4) — the guided spine of the assist
 * workspace. It does NOT drive the flow; it *reflects* it, derived entirely from
 * the live stream + session state, so the user always knows which part of the
 * "plan it together" journey they're in without being marched through a wizard.
 *
 * Stages map to doc 31: Understand (2) · Design (3+4) · Validate (6) · Ready (7)
 * · Build (8). Test/Publish (9/10) happen in the Builder once Build is reached.
 */
type StageStatus = 'upcoming' | 'active' | 'done' | 'warning';

interface Stage {
  key: string;
  label: string;
  status: StageStatus;
  hint?: string;
}

export interface AssistStageRailInput {
  streaming: boolean;
  hasMessages: boolean;
  nodeCount: number;
  unresolvedCount: number;
  testCount: number;
  created: boolean;
}

/** Pure derivation — honest about what the data actually proves. */
export function deriveStages(i: AssistStageRailInput): Stage[] {
  const hasGraph = i.nodeCount > 0;

  const understand: StageStatus = hasGraph || i.hasMessages
    ? 'done'
    : i.streaming
      ? 'active'
      : 'upcoming';

  const design: StageStatus = i.created
    ? 'done'
    : hasGraph
      ? i.streaming
        ? 'active'
        : 'done'
      : i.streaming
        ? 'active'
        : 'upcoming';

  const validate: StageStatus = !hasGraph
    ? 'upcoming'
    : i.unresolvedCount > 0
      ? 'warning'
      : i.streaming
        ? 'active'
        : 'done';

  const ready: StageStatus = i.created
    ? 'done'
    : hasGraph && !i.streaming && i.unresolvedCount === 0
      ? 'active'
      : 'upcoming';

  const build: StageStatus = i.created ? 'done' : 'upcoming';

  return [
    { key: 'understand', label: 'Understand', status: understand },
    { key: 'design', label: 'Design', status: design },
    {
      key: 'validate',
      label: 'Validate',
      status: validate,
      hint: i.unresolvedCount > 0 ? `${i.unresolvedCount} to resolve` : undefined,
    },
    { key: 'ready', label: 'Ready', status: ready },
    { key: 'build', label: 'Build', status: build },
  ];
}

const DOT: Record<StageStatus, string> = {
  upcoming: 'border-white/[0.15] text-zinc-600',
  active: 'border-violet text-violet-secondary shadow-[0_0_12px_rgba(124,92,255,0.4)]',
  done: 'border-status-succeeded/50 bg-status-succeeded/15 text-status-succeeded',
  warning: 'border-status-failed/50 bg-status-failed/10 text-status-failed',
};

const LABEL: Record<StageStatus, string> = {
  upcoming: 'text-zinc-600',
  active: 'text-white',
  done: 'text-zinc-300',
  warning: 'text-status-failed',
};

export function AssistStageRail(props: AssistStageRailInput) {
  const stages = deriveStages(props);

  return (
    <nav
      aria-label="Workflow build progress"
      className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
    >
      {stages.map((stage, idx) => (
        <div key={stage.key} className="flex items-center gap-1">
          <div
            className="flex items-center gap-2"
            aria-current={stage.status === 'active' ? 'step' : undefined}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-medium transition-colors ${DOT[stage.status]}`}
              aria-hidden
            >
              {stage.status === 'done' ? (
                <Check className="h-3 w-3" />
              ) : stage.status === 'warning' ? (
                <AlertTriangle className="h-3 w-3" />
              ) : stage.status === 'active' ? (
                <Loader2 className="h-3 w-3 motion-safe:animate-spin" />
              ) : (
                idx + 1
              )}
            </span>
            <span className="flex flex-col leading-tight">
              <span className={`whitespace-nowrap text-xs font-medium ${LABEL[stage.status]}`}>
                {stage.label}
                <span className="sr-only"> — {stage.status}</span>
              </span>
              {stage.hint ? (
                <span className="whitespace-nowrap text-[10px] text-status-failed">
                  {stage.hint}
                </span>
              ) : null}
            </span>
          </div>
          {idx < stages.length - 1 ? (
            <span
              className={`mx-1 h-px w-6 shrink-0 ${
                stage.status === 'done' ? 'bg-status-succeeded/40' : 'bg-white/[0.08]'
              }`}
              aria-hidden
            />
          ) : null}
        </div>
      ))}

      {/* Quiet live metrics — the numbers behind the stages */}
      <div className="ml-auto flex shrink-0 items-center gap-3 pl-3 text-[11px] text-zinc-500">
        <span>{props.nodeCount} steps</span>
        <span className={props.unresolvedCount > 0 ? 'text-status-failed' : undefined}>
          {props.unresolvedCount} issues
        </span>
        {props.testCount > 0 ? <span>{props.testCount} tests</span> : null}
      </div>
    </nav>
  );
}
