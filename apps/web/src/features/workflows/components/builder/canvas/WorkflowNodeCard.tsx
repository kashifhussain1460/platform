'use client';

import { memo, useContext, useEffect, useRef, useState } from 'react';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import {
  AlertTriangle,
  Copy,
  CopyPlus,
  CornerDownLeft,
  Ban,
  MoreHorizontal,
  MousePointerSquareDashed,
  Pencil,
  Play,
  Power,
  Trash2,
  Wand2,
  XSquare,
} from 'lucide-react';
import type { WorkflowCanvasNode } from './definitionToFlow';
import { RunOverlayContext, STEP_DOT } from './runOverlay';
import { type NodeActions, NodeActionsContext } from './nodeActions';

// Literal badge classes per tone (Tailwind JIT can't see `bg-${tone}`).
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

const FALLBACK_BADGE = 'bg-cat-util/15 text-cat-util';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// 10px handle dots on the card sides (left = in, right = out) for the LR flow.
const HANDLE_CLASS =
  '!h-2.5 !w-2.5 !rounded-full !border-2 !border-edge-idle !bg-canvas transition-colors hover:!border-edge-hover';

function SourceHandles({
  handles,
  isConnectable,
}: {
  handles: WorkflowCanvasNode['data']['sourceHandles'];
  isConnectable: boolean;
}) {
  if (handles.length === 0) return null;
  return (
    <>
      {handles.map((h, i) => (
        <Handle
          key={h.id}
          id={h.id}
          type="source"
          position={Position.Right}
          // Spread multiple outputs (e.g. CONDITION true/false) down the right edge.
          style={{ top: `${((i + 1) / (handles.length + 1)) * 100}%` }}
          className={HANDLE_CLASS}
          isConnectable={isConnectable}
        />
      ))}
    </>
  );
}

function TargetHandles({
  handles,
  isConnectable,
}: {
  handles: WorkflowCanvasNode['data']['targetHandles'];
  isConnectable: boolean;
}) {
  if (handles.length === 0) return null;
  if (handles.length === 1) {
    return (
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} isConnectable={isConnectable} />
    );
  }
  // A merge/JOIN: one input port per arriving edge, spread down the left edge.
  return (
    <>
      {handles.map((h, i) => (
        <Handle
          key={h.id}
          id={h.id}
          type="target"
          position={Position.Left}
          style={{ top: `${((i + 1) / (handles.length + 1)) * 100}%` }}
          className={HANDLE_CLASS}
          isConnectable={isConnectable}
        />
      ))}
    </>
  );
}

// ── Context menu ─────────────────────────────────────────────────────────────

interface MenuItem {
  key: string;
  label: string;
  icon: typeof Copy;
  shortcut?: string;
  run?: () => void;
  danger?: boolean;
  /** Rendered but not clickable, with the reason as a tooltip (doc 29: never a
   *  dead control — show WHY instead of hiding it). */
  disabledReason?: string;
  separatorBefore?: boolean;
}

/**
 * The node action menu. ONE definition, opened from two places: the ⋯ button and
 * a right-click anywhere on the card — so both routes always offer exactly the
 * same actions (doc 30 §32.1).
 *
 * Deliberately absent vs the n8n reference (doc 30 §32.4): "Pin" (our dry-run is
 * the safer engine-level equivalent), "Convert to sub-workflow" (SUB_WORKFLOW is
 * outside the frozen 17) and "Group node" (no representation in the JSON
 * contract). Hidden rather than shown-disabled, because they are not coming.
 */
function NodeContextMenu({
  items,
  style,
  onClose,
}: {
  items: MenuItem[];
  style: React.CSSProperties;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={style}
      className="nodrag nowheel absolute z-30 w-60 overflow-hidden rounded-lg border border-wf-hairline bg-void-card p-1 shadow-xl shadow-black/50"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const isDisabled = Boolean(item.disabledReason);
        return (
          <div key={item.key}>
            {item.separatorBefore ? <div className="my-1 h-px bg-wf-hairline" /> : null}
            <button
              type="button"
              role="menuitem"
              disabled={isDisabled}
              title={item.disabledReason}
              onClick={() => {
                if (isDisabled) return;
                item.run?.();
                onClose();
              }}
              className={[
                'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                isDisabled
                  ? 'cursor-not-allowed text-wf-ink-3/50'
                  : item.danger
                    ? 'text-status-failed hover:bg-status-failed/10'
                    : 'text-wf-ink hover:bg-white/[0.06]',
              ].join(' ')}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="flex-1">{item.label}</span>
              {item.shortcut ? (
                <span className="shrink-0 font-mono text-[10px] text-wf-ink-3">{item.shortcut}</span>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function buildMenuItems(
  id: string,
  actions: NodeActions,
  isDisabledNode: boolean,
  isTrigger: boolean,
  startRename: () => void,
): MenuItem[] {
  return [
    { key: 'open', label: 'Open…', icon: CornerDownLeft, shortcut: '↵', run: () => actions.onOpen(id) },
    {
      key: 'execute',
      label: 'Execute step',
      icon: Play,
      // Honest disabled state: single-node execution needs a backend route that
      // does not exist yet (doc 30 §32.2). Shown, not hidden, so the menu still
      // matches the reference and the reason is discoverable.
      disabledReason: 'Running one step on its own is not available yet — use Run to test the whole workflow.',
    },
    { key: 'rename', label: 'Rename', icon: Pencil, shortcut: 'Space', run: startRename },
    {
      key: 'disable',
      label: isDisabledNode ? 'Activate' : 'Deactivate',
      icon: isDisabledNode ? Power : Ban,
      shortcut: 'D',
      run: () => actions.onToggleDisabled(id),
      disabledReason: isTrigger
        ? 'The trigger starts the workflow, so it cannot be deactivated.'
        : undefined,
    },
    {
      key: 'copy',
      label: 'Copy',
      icon: Copy,
      shortcut: 'Ctrl C',
      run: () => actions.onCopy(id),
      separatorBefore: true,
    },
    { key: 'duplicate', label: 'Duplicate', icon: CopyPlus, shortcut: 'Ctrl D', run: () => actions.onDuplicate(id) },
    {
      key: 'tidy',
      label: 'Tidy up workflow',
      icon: Wand2,
      shortcut: '⇧ Alt T',
      run: actions.onTidyUp,
      separatorBefore: true,
    },
    {
      key: 'selectAll',
      label: 'Select all',
      icon: MousePointerSquareDashed,
      shortcut: 'Ctrl A',
      run: actions.onSelectAll,
    },
    { key: 'clear', label: 'Clear selection', icon: XSquare, run: actions.onClearSelection },
    {
      key: 'delete',
      label: 'Delete',
      icon: Trash2,
      shortcut: 'Del',
      run: () => actions.onDelete(id),
      danger: true,
      separatorBefore: true,
    },
  ];
}

// ── Hover toolbar ────────────────────────────────────────────────────────────

/** The four controls the reference shows on hover: execute · enable/disable ·
 *  delete · more. Appears on hover/focus-within so it never covers content. */
function HoverToolbar({
  id,
  actions,
  isDisabledNode,
  isTrigger,
  onOpenMenu,
}: {
  id: string;
  actions: NodeActions;
  isDisabledNode: boolean;
  isTrigger: boolean;
  onOpenMenu: (e: React.MouseEvent) => void;
}) {
  const btn =
    'rounded-md p-1 text-wf-ink-3 transition-colors hover:bg-white/[0.08] hover:text-wf-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div
      className="nodrag absolute -top-8 right-0 z-20 flex items-center gap-0.5 rounded-lg border border-wf-hairline bg-void-card p-0.5 opacity-0 shadow-lg shadow-black/40 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={btn}
        disabled
        title="Running one step on its own is not available yet — use Run to test the whole workflow."
        aria-label="Execute this step"
      >
        <Play className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={btn}
        disabled={isTrigger}
        title={
          isTrigger
            ? 'The trigger starts the workflow, so it cannot be deactivated.'
            : isDisabledNode
              ? 'Activate this step'
              : 'Deactivate this step'
        }
        aria-label={isDisabledNode ? 'Activate this step' : 'Deactivate this step'}
        onClick={() => actions.onToggleDisabled(id)}
      >
        {isDisabledNode ? <Power className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        className={`${btn} hover:!text-status-failed`}
        title="Delete this step"
        aria-label="Delete this step"
        onClick={() => actions.onDelete(id)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={btn}
        aria-label="Step actions"
        aria-haspopup="menu"
        title="More actions"
        onClick={onOpenMenu}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

function WorkflowNodeCardImpl({ id, data, selected, isConnectable }: NodeProps<WorkflowCanvasNode>) {
  const actions = useContext(NodeActionsContext);
  const badge = TONE_BADGE[data.tone] ?? FALLBACK_BADGE;
  const connectable = isConnectable ?? false;
  const isDisabledNode = data.node.disabled === true;
  const isTrigger = data.category === 'TRIGGER';

  // Menu anchor: `null` = closed. The ⋯ button anchors top-right; a right-click
  // anchors at the pointer, both rendered by the same component.
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);
  const renaming = actions?.renamingNodeId === id;

  // Live run status for this node (present only while watching a run).
  const runStatus = useContext(RunOverlayContext)?.get(id);
  const isFailed = runStatus === 'FAILED';
  const runDot = runStatus ? (
    <span
      className={`absolute right-2 top-2 z-10 h-2.5 w-2.5 rounded-full ${STEP_DOT[runStatus]}`}
      title={`Run: ${runStatus}`}
      aria-label={`Run status ${runStatus}`}
    />
  ) : null;

  const border = selected
    ? 'border-transparent ring-2 ring-wf-focus'
    : isFailed
      ? 'border-status-failed'
      : data.category === 'AI_EMPLOYEE'
        ? 'border-cat-employee/50 hover:border-cat-employee/70'
        : 'border-wf-hairline hover:border-wf-hairline-hover';

  // A disabled step reads as "switched off" — dimmed and desaturated — while
  // staying fully selectable and draggable so it can be switched back on.
  const frame = [
    'group relative rounded-2xl border bg-void-card shadow-lg shadow-black/30 transition-colors',
    border,
    isDisabledNode ? 'opacity-45 grayscale' : '',
  ].join(' ');

  const openMenuFromButton = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuAt({ top: 28, left: -180 });
  };
  const openMenuFromRightClick = (e: React.MouseEvent) => {
    if (!actions) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAt({ top: e.clientY - rect.top, left: e.clientX - rect.left });
  };

  const menu =
    actions && menuAt ? (
      <NodeContextMenu
        items={buildMenuItems(id, actions, isDisabledNode, isTrigger, () => actions.onRename(id))}
        style={{ top: menuAt.top, left: menuAt.left }}
        onClose={() => setMenuAt(null)}
      />
    ) : null;

  const toolbar = actions ? (
    <HoverToolbar
      id={id}
      actions={actions}
      isDisabledNode={isDisabledNode}
      isTrigger={isTrigger}
      onOpenMenu={openMenuFromButton}
    />
  ) : null;

  const disabledChip = isDisabledNode ? (
    <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-wf-ink-3">
      Off
    </span>
  ) : null;

  const titleEl = renaming ? (
    <RenameInput
      initial={data.title}
      onCommit={(next) => actions?.onRenameCommit(id, next)}
      onCancel={() => actions?.onRenameCommit(id, '')}
    />
  ) : null;

  const targetHandle = <TargetHandles handles={data.targetHandles} isConnectable={connectable} />;

  // The signature person card — the only node with a round portrait + a name.
  if (data.category === 'AI_EMPLOYEE' && data.employee) {
    const emp = data.employee;
    return (
      <div className={`${frame} w-[240px]`} onContextMenu={openMenuFromRightClick}>
        {targetHandle}
        {runDot}
        {toolbar}
        {menu}
        <div className="flex items-center gap-3 p-3">
          <span
            className={[
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
              emp.unresolved ? 'bg-white/[0.06] text-wf-ink-3' : 'bg-cat-employee/20 text-cat-employee',
            ].join(' ')}
          >
            {emp.unresolved ? '?' : initials(emp.name)}
          </span>
          <div className="min-w-0 flex-1">
            {titleEl ?? (
              <p className="truncate font-display text-sm font-semibold text-wf-ink">{data.title}</p>
            )}
            {emp.role ? (
              <span className="mt-0.5 inline-block rounded-full bg-cat-employee/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cat-employee">
                {emp.role}
              </span>
            ) : null}
            {data.subtitle ? (
              <p className="mt-1 line-clamp-2 text-xs text-wf-ink-2">{data.subtitle}</p>
            ) : null}
            {emp.unresolved ? <NeedsAttention text="This step has no employee assigned" /> : null}
            {disabledChip}
          </div>
        </div>
        <SourceHandles handles={data.sourceHandles} isConnectable={connectable} />
      </div>
    );
  }

  const width = isTrigger ? 'w-[200px]' : 'w-[216px]';

  return (
    <div className={`${frame} ${width}`} onContextMenu={openMenuFromRightClick}>
      {targetHandle}
      {runDot}
      {toolbar}
      {menu}
      <div className="flex items-start gap-2.5 p-3">
        {/* n8n-style letter code badge, category-tinted */}
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono text-[10px] font-semibold ${badge}`}
        >
          {data.code}
        </span>
        <div className="min-w-0 flex-1">
          {titleEl ?? <p className="truncate text-sm font-semibold text-wf-ink">{data.title}</p>}
          {data.subtitle ? (
            <p className="truncate font-mono text-xs text-wf-ink-3">{data.subtitle}</p>
          ) : null}
          {isFailed ? (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-status-failed/15 px-1.5 py-0.5 text-[10px] font-medium text-status-failed">
              error
            </span>
          ) : data.pausesForApproval && data.category !== 'APPROVAL' ? (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-cat-approval/15 px-1.5 py-0.5 text-[10px] font-medium text-cat-approval">
              Pauses for approval
            </span>
          ) : null}
          {disabledChip}
        </div>
      </div>
      <SourceHandles handles={data.sourceHandles} isConnectable={connectable} />
    </div>
  );
}

/** The reference's ⚠ badge for a step that cannot run as configured. */
function NeedsAttention({ text }: { text: string }) {
  return (
    <span
      className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-status-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warning"
      title={text}
    >
      <AlertTriangle className="h-3 w-3" aria-hidden />
      Needs setup
    </span>
  );
}

/** Inline rename field. Enter commits, Escape/empty cancels, blur commits. */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Focus-on-mount is the one sanctioned useRef use (see repo conventions).
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={initial}
      autoFocus
      className="nodrag w-full rounded border border-wf-focus bg-void px-1 py-0.5 text-sm font-semibold text-wf-ink outline-none"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onCommit(e.currentTarget.value.trim());
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={(e) => onCommit(e.currentTarget.value.trim())}
    />
  );
}

/** Memoized so panning/selection doesn't re-render every card. */
export const WorkflowNodeCard = memo(WorkflowNodeCardImpl);
