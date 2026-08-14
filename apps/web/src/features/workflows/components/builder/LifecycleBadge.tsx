import {
  Archive,
  CheckCircle2,
  CircleDot,
  type LucideIcon,
  PauseCircle,
  Pencil,
} from 'lucide-react';
import type { WorkflowDto } from '@vaep/types';

interface BadgeLook {
  label: string;
  icon: LucideIcon;
  cls: string;
}

/**
 * Resolve the workflow's lifecycle state.
 *
 * The wording is the four states the customer is meant to think in — Draft,
 * Active, Paused, Archived (UX plan §15/§45) — with one addition that earns its
 * place: a workflow whose version is published but whose trigger is not armed.
 * That state is reachable on purpose ("Publish without turning it on") and is
 * also where a refused activation leaves you, so calling it "Draft" would hide
 * a real published version and calling it "Active" would be false. It is
 * labelled in plain language rather than with the internal word "Published".
 */
function look(workflow: WorkflowDto): BadgeLook {
  if (workflow.status === 'ARCHIVED') {
    return { label: 'Archived', icon: Archive, cls: 'border-white/[0.06] bg-white/[0.03] text-wf-ink-3' };
  }
  if (workflow.status === 'ACTIVE') {
    return {
      label: 'Active',
      icon: CircleDot,
      cls: 'border-status-succeeded/30 bg-status-succeeded/10 text-status-succeeded',
    };
  }
  if (workflow.status === 'PAUSED') {
    return {
      label: 'Paused',
      icon: PauseCircle,
      cls: 'border-status-waiting/30 bg-status-waiting/10 text-status-waiting',
    };
  }
  // DRAFT status: published (has an active version) vs never-published.
  if (workflow.activeVersionId) {
    return {
      label: 'Not turned on',
      icon: CheckCircle2,
      cls: 'border-violet-secondary/40 bg-violet/10 text-violet-secondary',
    };
  }
  return { label: 'Draft', icon: Pencil, cls: 'border-wf-hairline bg-white/[0.04] text-wf-ink-2' };
}

/** The builder's lifecycle state pill (doc 29 §3.E — icon + word + color). */
export function LifecycleBadge({ workflow }: { workflow: WorkflowDto }) {
  const { label, icon: Icon, cls } = look(workflow);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${cls}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}
