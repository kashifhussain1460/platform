'use client';

import { X } from 'lucide-react';
import type {
  AiEmployeeDto,
  InstalledSkillDto,
  NodeDefinitionDto,
  WorkflowDto,
  WorkflowNode,
} from '@vaep/types';
import { NODE_ICONS } from '../../../labels';
import { NODE_CATEGORY_META } from '../../../nodeMeta';
import { NodeConfigForm } from './NodeConfigForm';
import { TriggerInspector } from './TriggerInspector';

// Literal tone → badge classes (Tailwind JIT can't see `bg-${tone}`).
const TONE_BADGE: Record<string, string> = {
  'cat-employee': 'bg-cat-employee/15 text-cat-employee',
  'cat-trigger': 'bg-cat-trigger/15 text-cat-trigger',
  'cat-approval': 'bg-cat-approval/15 text-cat-approval',
  'cat-tool': 'bg-cat-tool/15 text-cat-tool',
  'cat-knowledge': 'bg-cat-knowledge/15 text-cat-knowledge',
  'cat-memory': 'bg-cat-memory/15 text-cat-memory',
  'cat-logic': 'bg-cat-logic/15 text-cat-logic',
  'cat-data': 'bg-cat-data/15 text-cat-data',
  'cat-util': 'bg-cat-util/15 text-cat-util',
};

export interface InspectorProps {
  node: WorkflowNode | null;
  def?: NodeDefinitionDto;
  /** The workflow — needed to edit trigger settings (workflow-level, not node config). */
  workflow?: WorkflowDto;
  employees: AiEmployeeDto[];
  skills: InstalledSkillDto[];
  readOnly?: boolean;
  onPatch: (patch: { name?: string; config?: Record<string, unknown> }) => void;
  onClose: () => void;
}

/**
 * Inspector — the right-dock panel that configures the selected step (doc 29
 * §3.E). When nothing is selected it invites a selection; otherwise it shows the
 * node's identity and the data-driven config form. The panel title tracks the
 * node's name, so a step keeps its name through card → inspector.
 */
export function Inspector({
  node,
  def,
  workflow,
  employees,
  skills,
  readOnly,
  onPatch,
  onClose,
}: InspectorProps) {
  return (
    <aside
      className="flex w-80 shrink-0 flex-col rounded-2xl border border-wf-hairline bg-void-section"
      aria-label="Step settings"
    >
      {node ? (
        <NodeHeader node={node} def={def} onClose={onClose} />
      ) : (
        <div className="border-b border-wf-hairline px-4 py-3">
          <p className="font-display text-sm font-semibold text-wf-ink">Step settings</p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {node ? (
          node.type === 'TRIGGER' && workflow ? (
            <TriggerInspector workflow={workflow} readOnly={readOnly} />
          ) : (
          <NodeConfigForm
            key={node.id}
            node={node}
            def={def}
            employees={employees}
            skills={skills}
            readOnly={readOnly}
            onPatch={onPatch}
          />
          )
        ) : (
          <p className="text-sm text-wf-ink-3">
            Select a step on the canvas to configure it. Click a node, or press Enter with one focused.
          </p>
        )}
      </div>
    </aside>
  );
}

function NodeHeader({
  node,
  def,
  onClose,
}: {
  node: WorkflowNode;
  def?: NodeDefinitionDto;
  onClose: () => void;
}) {
  const category = def?.category ?? 'UTILITY';
  const meta = NODE_CATEGORY_META[category];
  const Icon = NODE_ICONS[node.type];
  const title = node.name?.trim() || def?.label || node.type;

  return (
    <div className="flex items-start gap-3 border-b border-wf-hairline px-4 py-3">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONE_BADGE[meta.tone] ?? 'bg-white/[0.06] text-wf-ink-2'}`}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-wf-ink-3">
          {meta.label}
        </p>
        <p className="truncate font-display text-sm font-semibold text-wf-ink">{title}</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close step settings"
        className="rounded-lg p-1 text-wf-ink-3 transition-colors hover:bg-white/[0.06] hover:text-wf-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
