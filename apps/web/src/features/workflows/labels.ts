import type { ElementType } from 'react';
import {
  Bot,
  Braces,
  Brain,
  CheckCircle2,
  CircleDot,
  Clock,
  GitBranch,
  GitMerge,
  MessageSquare,
  Octagon,
  Repeat,
  Search,
  Split,
  Variable,
  Wrench,
  Zap,
} from 'lucide-react';
import type {
  NodeType,
  StepRunStatus,
  TriggerType,
  WorkflowRunStatus,
  WorkflowStatus,
} from '@vaep/types';

/** Human labels for each node type. */
export const NODE_LABELS: Record<NodeType, string> = {
  TRIGGER: 'Trigger',
  RETRIEVE: 'Retrieve knowledge',
  AI_STEP: 'AI step',
  TOOL_ACTION: 'Tool action',
  WAIT: 'Wait',
  CONDITION: 'Condition',
  NOTIFY: 'Notify',
  APPROVAL: 'Approval',
  AI_EMPLOYEE_STEP: 'AI Employee step',
  SWITCH: 'Switch',
  PARALLEL: 'Split (parallel)',
  JOIN: 'Merge (join)',
  LOOP: 'Loop',
  TERMINATE: 'Stop',
  SET_VARIABLE: 'Set variable',
  TRANSFORM: 'Transform data',
  MEMORY_READ: 'Read memory',
  MEMORY_WRITE: 'Write memory',
  NOOP: 'No-op',
};

/** One-line description of what each node type does. */
export const NODE_HINTS: Record<NodeType, string> = {
  TRIGGER: 'Entry point. The run trigger payload is available as {{trigger.*}}.',
  RETRIEVE: 'Search company knowledge for a query and store the results.',
  AI_STEP: 'Ask the LLM to produce text from a templated prompt.',
  TOOL_ACTION: 'Run a skill tool (e.g. Slack) with templated arguments.',
  WAIT: 'Pause for a bounded number of milliseconds.',
  CONDITION: 'Compare two values to branch the flow (types/engine support branches).',
  NOTIFY: 'Record a message in the run log.',
  APPROVAL:
    'Pause the run for a manager decision (Approval Center). Approve resumes; reject fails.',
  AI_EMPLOYEE_STEP:
    'Run a full AI Employee turn (plan, retrieve, act) — every tool call is approval-gated.',
  SWITCH: 'Branch to a named case based on a value.',
  PARALLEL: 'Fan out to several lanes at once. Requires a matching Merge.',
  JOIN: 'Wait for the parallel lanes to arrive, then continue.',
  LOOP: 'Repeat a body for each item, up to a bounded number of iterations.',
  TERMINATE: 'End the run immediately with a chosen outcome.',
  SET_VARIABLE: 'Store a value in a workflow variable.',
  TRANSFORM: 'Reshape data with a fixed set of operations (no scripting).',
  MEMORY_READ: "Recall an AI Employee's stored memories.",
  MEMORY_WRITE: "Save a fact to an AI Employee's memory.",
  NOOP: 'Does nothing. Useful as a placeholder or a merge target.',
};

/** Icon per node type — used by the node cards (builder list + run log). */
export const NODE_ICONS: Record<NodeType, ElementType<{ className?: string }>> = {
  TRIGGER: Zap,
  RETRIEVE: Search,
  AI_STEP: Bot,
  TOOL_ACTION: Wrench,
  WAIT: Clock,
  CONDITION: GitBranch,
  NOTIFY: MessageSquare,
  APPROVAL: CheckCircle2,
  AI_EMPLOYEE_STEP: Bot,
  SWITCH: Split,
  PARALLEL: Split,
  JOIN: GitMerge,
  LOOP: Repeat,
  TERMINATE: Octagon,
  SET_VARIABLE: Variable,
  TRANSFORM: Braces,
  MEMORY_READ: Brain,
  MEMORY_WRITE: Brain,
  NOOP: CircleDot,
};

/** Icon badge tone (bg + text) per node type. */
export const NODE_TONES: Record<NodeType, string> = {
  TRIGGER: 'bg-violet/20 text-violet-secondary',
  RETRIEVE: 'bg-sky-500/15 text-sky-400',
  AI_STEP: 'bg-violet/20 text-violet-secondary',
  TOOL_ACTION: 'bg-violet/20 text-violet-secondary',
  WAIT: 'bg-white/[0.06] text-zinc-400',
  CONDITION: 'bg-amber-500/15 text-amber-400',
  NOTIFY: 'bg-emerald-500/15 text-emerald-400',
  APPROVAL: 'bg-violet/20 text-violet-secondary',
  AI_EMPLOYEE_STEP: 'bg-violet/20 text-violet-secondary',
  SWITCH: 'bg-amber-500/15 text-amber-400',
  PARALLEL: 'bg-amber-500/15 text-amber-400',
  JOIN: 'bg-amber-500/15 text-amber-400',
  LOOP: 'bg-amber-500/15 text-amber-400',
  TERMINATE: 'bg-red-500/15 text-red-400',
  SET_VARIABLE: 'bg-sky-500/15 text-sky-400',
  TRANSFORM: 'bg-sky-500/15 text-sky-400',
  MEMORY_READ: 'bg-violet/20 text-violet-secondary',
  MEMORY_WRITE: 'bg-violet/20 text-violet-secondary',
  NOOP: 'bg-white/[0.06] text-zinc-400',
};

/** Human label per trigger type (workflow list meta line). */
export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  MANUAL: 'Manual',
  SCHEDULE: 'Schedule',
  WEBHOOK: 'Webhook',
  EVENT: 'Event',
};

/** Tailwind badge classes for a workflow status. */
export const WORKFLOW_STATUS_STYLES: Record<WorkflowStatus, string> = {
  DRAFT: 'bg-white/[0.06] text-zinc-400',
  ACTIVE: 'bg-green-500/15 text-green-400',
  PAUSED: 'bg-amber-500/15 text-amber-400',
  // Soft-deleted (G29): retained and readable, but no longer runnable.
  ARCHIVED: 'bg-white/[0.04] text-zinc-500',
};

/** Tailwind badge classes for a run status. */
export const RUN_STATUS_STYLES: Record<WorkflowRunStatus, string> = {
  PENDING: 'bg-white/[0.06] text-zinc-400',
  RUNNING: 'bg-blue-500/15 text-blue-400',
  WAITING: 'bg-amber-500/15 text-amber-400',
  COMPLETED: 'bg-green-500/15 text-green-400',
  FAILED: 'bg-red-500/15 text-red-400',
  // P1 durable state machine states.
  CANCELLED: 'bg-white/[0.06] text-zinc-400',
  COMPENSATING: 'bg-orange-500/15 text-orange-400',
  TIMED_OUT: 'bg-red-500/10 text-red-300',
};

/** Tailwind badge classes for a step-run status. */
export const STEP_STATUS_STYLES: Record<StepRunStatus, string> = {
  PENDING: 'bg-white/[0.06] text-zinc-400',
  RUNNING: 'bg-blue-500/15 text-blue-400',
  COMPLETED: 'bg-green-500/15 text-green-400',
  FAILED: 'bg-red-500/15 text-red-400',
  SKIPPED: 'bg-white/[0.05] text-zinc-500',
  // P1 durable state machine states.
  RETRYING: 'bg-amber-500/15 text-amber-400',
  WAITING: 'bg-amber-500/15 text-amber-400',
  COMPENSATED: 'bg-orange-500/10 text-orange-300',
};

/** Sensible default `config` for a freshly added node of each type. */
export function defaultConfig(type: NodeType): Record<string, unknown> {
  switch (type) {
    case 'RETRIEVE':
      return { query: '{{trigger.query}}', k: 5, outputKey: 'retrieved' };
    case 'AI_STEP':
      return {
        prompt: 'Summarise: {{retrieved}}',
        employeeId: '',
        outputKey: 'aiText',
      };
    case 'TOOL_ACTION':
      return {
        skillKey: 'slack',
        tool: 'send_message',
        args: { channel: '#general', text: '{{aiText}}' },
        outputKey: 'toolResult',
      };
    case 'WAIT':
      return { durationMs: 1000 };
    case 'CONDITION':
      return { left: '{{trigger.value}}', op: 'eq', right: '' };
    case 'NOTIFY':
      return { message: 'Workflow completed: {{aiText}}' };
    case 'APPROVAL':
      return { message: 'Please review and approve this workflow step.' };
    case 'TRIGGER':
    default:
      return {};
  }
}
