'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Redo2, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  addEdge,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import type {
  AiEmployeeDto,
  NodeDefinitionDto,
  NodeType,
  WorkflowDefinition,
  WorkflowDto,
  WorkflowNode,
  WorkflowRunDto,
} from '@vaep/types';
import { useAutosaveWorkflow, useNodeDefinitions, workflowKeys } from '../../../hooks';
import { AutosaveStatus, type AutosaveState } from '../AutosaveStatus';
import { useEmployees } from '@/features/employees/hooks';
import { useInstalledSkills } from '@/features/skills/hooks';
import { defaultConfig } from '../../../labels';
import { definitionToFlow, type WorkflowCanvasNode } from './definitionToFlow';
import { flowToDefinition } from './flowToDefinition';
import { validateConnection } from './connectionRules';
import { WorkflowNodeCard } from './WorkflowNodeCard';
import { NodeLibrary } from './NodeLibrary';
import { Inspector } from './Inspector';
import { DebugPanel } from './DebugPanel';
import { Outline } from './Outline';
import { RunOverlayContext, stepStatusByNodeId } from './runOverlay';
import { type NodeActions, NodeActionsContext } from './nodeActions';
import { layoutGraph } from './layout';
import * as hist from './history';
import { EmptyState } from '../EmptyState';

// Stable references (React Flow warns if these change identity each render).
const NODE_TYPES = { workflowNode: WorkflowNodeCard };
const DEFAULT_EDGE_OPTIONS = {
  type: 'default',
  style: { stroke: 'rgba(255,255,255,0.16)', strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(255,255,255,0.4)', width: 16, height: 16 },
  labelStyle: { fill: '#A6ADBB', fontSize: 11, fontFamily: 'var(--font-jetbrains-mono)' },
  labelBgStyle: { fill: '#0B0E18', fillOpacity: 0.92 },
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 8,
};

const MINIMAP_COLOR: Record<string, string> = {
  'cat-employee': '#8B6EF2',
  'cat-trigger': '#22D3EE',
  'cat-approval': '#F0B90D',
  'cat-tool': '#2DD4BF',
  'cat-knowledge': '#818CF8',
  'cat-memory': '#A78BFA',
  'cat-logic': '#94A3B8',
  'cat-data': '#64748B',
  'cat-util': '#475569',
};

const AUTOSAVE_DEBOUNCE_MS = 800;

type SaveState = AutosaveState;

function newNodeId(type: NodeType): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${type.toLowerCase()}-${rand}`;
}

/**
 * What the canvas is being used for. Replaces the old boolean `editable` +
 * "definitionOverride forces read-only" coupling, which made it impossible to
 * hand the canvas a definition AND let the user edit it — the exact combination
 * the AI Assist needs (doc 30 AD-30-10: one canvas, equally editable, whoever
 * authored the graph).
 *
 * - `edit`    — full CRUD + autosave. The manual builder and the AI Assist.
 * - `preview` — genuinely read-only (viewing a past version).
 * - `watch`   — read-only + live run overlay + debug dock.
 */
export type CanvasMode = 'edit' | 'preview' | 'watch';

export interface WorkflowCanvasProps {
  workflow: WorkflowDto;
  /** Defaults to `preview` — a canvas is read-only unless asked otherwise. */
  mode?: CanvasMode;
  /**
   * Render this definition instead of the workflow's live one. In `edit` mode
   * this is an editable starting graph (the AI Assist draft); in `preview` it is
   * an old version. It no longer implies read-only — `mode` decides that.
   */
  definitionOverride?: WorkflowDefinition;
  /** The polled run to watch (steps drive the overlay + debug dock). */
  run?: WorkflowRunDto;
  /**
   * Temporarily suspend editing without leaving edit mode — used while the AI
   * Assist is mid-turn so the agent and the user can't write at once (doc 30
   * §32.3). Pan/zoom/select stay live; only mutations are blocked.
   */
  locked?: boolean;
  lockedReason?: string;
  /**
   * The server's own view of the workflow after every successful autosave.
   *
   * The canvas deliberately does NOT write this back into the shared workflow
   * cache: the page re-seeds the canvas from that cache, so a write landing
   * while the user has newer unsaved edits would overwrite them. But things
   * OUTSIDE the canvas need the current graph — Run/Activate gate on it, and
   * `warnings` (unreachable steps) is computed server-side — and without this
   * they keep reading the workflow as it was when the page loaded. So you could
   * build a workflow, publish it, and still find Run greyed out until you
   * refreshed.
   */
  onSaved?: (saved: WorkflowDto) => void;
  /**
   * Report the live autosave state (and how to retry a failed save) so the page
   * chrome can show ONE truthful indicator instead of a second one computed
   * from the cached workflow, which goes stale the moment the canvas saves
   * without a refetch (UX plan §11).
   */
  onSaveStateChange?: (state: AutosaveState, retry: () => void) => void;
  /**
   * Select and reveal this node. Lets an issue in Review & Publish say "open
   * this step" and actually land on it.
   */
  selectNodeId?: string | null;
}

function CanvasInner({
  workflow,
  mode = 'preview',
  definitionOverride,
  run,
  locked = false,
  lockedReason,
  onSaved,
  onSaveStateChange,
  selectNodeId,
}: WorkflowCanvasProps) {
  const watchMode = mode === 'watch';
  const editable = mode === 'edit' && !locked;
  const runStatusByNodeId = useMemo(() => stepStatusByNodeId(run?.steps), [run?.steps]);
  const qc = useQueryClient();
  const { data: nodeDefs, isLoading: defsLoading } = useNodeDefinitions();
  const { data: employees } = useEmployees();
  const { data: skills } = useInstalledSkills();
  const autosave = useAutosaveWorkflow(workflow.id);

  const defsByType = useMemo(() => {
    const map = new Map<NodeType, NodeDefinitionDto>();
    for (const d of nodeDefs ?? []) map.set(d.type, d);
    return map;
  }, [nodeDefs]);

  const employeesById = useMemo(() => {
    const map = new Map<string, AiEmployeeDto>();
    for (const e of employees ?? []) map.set(e.id, e);
    return map;
  }, [employees]);

  const flow = useMemo(
    () => definitionToFlow(definitionOverride ?? workflow.definition, defsByType, employeesById),
    [definitionOverride, workflow.definition, defsByType, employeesById],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowCanvasNode>(flow.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flow.edges);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [invalidHint, setInvalidHint] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which node is being renamed in place. Held here (not in the card) so the
  // context menu and the Space shortcut drive the same state.
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);

  // Refs: unsaved-edit guard, latest graph for the debounced save, the
  // optimistic-concurrency stamp, and the debounce timer. (Focus/latest-value
  // refs only — no ref-as-state.)
  const dirtyRef = useRef(false);
  const latest = useRef({ nodes: flow.nodes, edges: flow.edges });
  const expectedRef = useRef(workflow.updatedAt);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Undo/redo (checkpoint model) ────────────────────────────────────────────
  // A stack of definition snapshots; `index` points at the current one. A new
  // checkpoint is pushed on each committed save, so one undo step = one save
  // boundary (predictable, and it avoids snapshotting on every drag frame).
  // Applying an undo/redo saves WITHOUT re-pushing, so navigating history never
  // grows it. canUndo/canRedo are mirrored into state to drive the toolbar.
  const history = useRef<hist.History<WorkflowDefinition>>({ stack: [], index: -1 });
  const [historyFlags, setHistoryFlags] = useState({ canUndo: false, canRedo: false });
  const syncHistFlags = useCallback(() => {
    setHistoryFlags({
      canUndo: hist.canUndo(history.current),
      canRedo: hist.canRedo(history.current),
    });
  }, []);

  useEffect(() => {
    latest.current = { nodes, edges };
  }, [nodes, edges]);

  // Reset the concurrency stamp + dirty flag when the workflow changes identity.
  useEffect(() => {
    expectedRef.current = workflow.updatedAt;
    dirtyRef.current = false;
  }, [workflow.id, workflow.updatedAt]);

  // Re-seed from the source graph on load / when defs/employees resolve — but
  // NOT while there are unsaved edits (that would discard them).
  useEffect(() => {
    if (dirtyRef.current) return;
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [flow, setNodes, setEdges]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  // Seed the history once per workflow identity with its starting graph, so the
  // first undo returns to where the user began. Keyed on `workflow.id` ONLY —
  // NOT updatedAt — so a save (which bumps updatedAt) never resets history.
  // Seed once per workflow identity (id only — not updatedAt — so a save that
  // bumps updatedAt never wipes history).
  useEffect(() => {
    history.current = hist.initHistory(definitionOverride ?? workflow.definition);
    syncHistFlags();
    // Keyed on workflow.id ONLY — including workflow.definition would re-seed
    // (and wipe) history on every save, since a save bumps it.
  }, [workflow.id]);

  const defEq = useCallback(
    (a: WorkflowDefinition, b: WorkflowDefinition) => JSON.stringify(a) === JSON.stringify(b),
    [],
  );

  /** Add a checkpoint (dropping any redo tail). No-op saves don't add a step. */
  const pushCheckpoint = useCallback(
    (definition: WorkflowDefinition) => {
      const before = history.current;
      history.current = hist.pushCheckpoint(before, definition, defEq);
      if (history.current !== before) syncHistFlags();
    },
    [defEq, syncHistFlags],
  );

  const saveDefinition = useCallback(
    (definition: WorkflowDefinition, opts: { pushHistory: boolean }) => {
      if (opts.pushHistory) pushCheckpoint(definition);
      setSaveState('saving');
      autosave.mutate(
        { definition, expectedUpdatedAt: expectedRef.current },
        {
          onSuccess: (updated) => {
            expectedRef.current = updated.updatedAt;
            dirtyRef.current = false;
            setSaveState('saved');
            onSaved?.(updated);
          },
          onError: (e) => setSaveState(e.status === 409 ? 'conflict' : 'error'),
        },
      );
    },
    [autosave, pushCheckpoint, onSaved],
  );

  const doSave = useCallback(() => {
    saveDefinition(flowToDefinition(latest.current.nodes, latest.current.edges), {
      pushHistory: true,
    });
  }, [saveDefinition]);

  const markDirtyAndSave = useCallback(() => {
    dirtyRef.current = true;
    setSaveState('unsaved');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, AUTOSAVE_DEBOUNCE_MS);
  }, [doSave]);

  // Validation context built from the live graph.
  const buildCtx = useCallback(
    () => ({
      nodeType: (id: string) =>
        latest.current.nodes.find((n) => n.id === id)?.data.node.type,
      defsByType,
      edges: latest.current.edges.map((e) => ({
        from: e.source,
        to: e.target,
        branch: e.sourceHandle && e.sourceHandle !== 'default' ? e.sourceHandle : undefined,
      })),
    }),
    [defsByType],
  );

  const isValidConnection = useCallback(
    (connection: Edge | Connection) => {
      const verdict = validateConnection(connection, buildCtx());
      setInvalidHint((prev) => {
        const next = verdict.ok ? null : verdict.reason;
        return prev === next ? prev : next;
      });
      return verdict.ok;
    },
    [buildCtx],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = latest.current.nodes.find((n) => n.id === connection.source);
      const label = connection.sourceHandle
        ? source?.data.sourceHandles.find((h) => h.id === connection.sourceHandle)?.label
        : undefined;
      setEdges((eds) => addEdge({ ...connection, type: 'default', label }, eds));
      setInvalidHint(null);
      markDirtyAndSave();
    },
    [setEdges, markDirtyAndSave],
  );

  const handleAdd = useCallback(
    (type: NodeType) => {
      const def = flowToDefinition(latest.current.nodes, latest.current.edges);
      const maxY = latest.current.nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
      const node: WorkflowNode = {
        id: newNodeId(type),
        type,
        config: defaultConfig(type),
        position: { x: 200, y: latest.current.nodes.length === 0 ? 40 : maxY + 120 },
      };
      const next = definitionToFlow(
        { nodes: [...def.nodes, node], edges: def.edges },
        defsByType,
        employeesById,
      );
      // Auto-select the new node so its Inspector opens for immediate config.
      setNodes(next.nodes.map((n) => ({ ...n, selected: n.id === node.id })));
      setEdges(next.edges);
      setSelectedId(node.id);
      markDirtyAndSave();
    },
    [defsByType, employeesById, setNodes, setEdges, markDirtyAndSave],
  );

  // Apply an Inspector edit (config and/or rename) to one node, re-deriving its
  // display (title/subtitle) via the canonical mapping while keeping positions +
  // selection, then autosave.
  const onNodePatch = useCallback(
    (nodeId: string, patch: { name?: string; config?: Record<string, unknown> }) => {
      const def = flowToDefinition(latest.current.nodes, latest.current.edges);
      const nextNodes = def.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.config !== undefined ? { config: patch.config } : {}),
            }
          : n,
      );
      const nextFlow = definitionToFlow(
        { nodes: nextNodes, edges: def.edges },
        defsByType,
        employeesById,
      );
      setNodes(nextFlow.nodes.map((n) => (n.id === nodeId ? { ...n, selected: true } : n)));
      setEdges(nextFlow.edges);
      markDirtyAndSave();
    },
    [defsByType, employeesById, setNodes, setEdges, markDirtyAndSave],
  );

  const closeInspector = useCallback(() => {
    setSelectedId(null);
    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
  }, [setNodes]);

  // Per-node ⋯ menu actions (edit mode), provided to the cards via context.
  const onDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedId((cur) => (cur === nodeId ? null : cur));
      markDirtyAndSave();
    },
    [setNodes, setEdges, markDirtyAndSave],
  );

  const onDuplicateNode = useCallback(
    (nodeId: string) => {
      const def = flowToDefinition(latest.current.nodes, latest.current.edges);
      const src = def.nodes.find((n) => n.id === nodeId);
      if (!src) return;
      const copy: WorkflowNode = {
        id: newNodeId(src.type),
        type: src.type,
        config: { ...src.config },
        position: { x: (src.position?.x ?? 0) + 48, y: (src.position?.y ?? 0) + 48 },
        ...(src.name ? { name: `${src.name} copy` } : {}),
      };
      const next = definitionToFlow(
        { nodes: [...def.nodes, copy], edges: def.edges },
        defsByType,
        employeesById,
      );
      setNodes(next.nodes.map((n) => ({ ...n, selected: n.id === copy.id })));
      setEdges(next.edges);
      setSelectedId(copy.id);
      markDirtyAndSave();
    },
    [defsByType, employeesById, setNodes, setEdges, markDirtyAndSave],
  );

  /** Patch one node's raw WorkflowNode fields (name/disabled) and re-derive. */
  const patchNodeFields = useCallback(
    (nodeId: string, patch: Partial<Pick<WorkflowNode, 'name' | 'disabled'>>) => {
      const def = flowToDefinition(latest.current.nodes, latest.current.edges);
      const nextNodes = def.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const merged: WorkflowNode = { ...n, ...patch };
        // Keep the persisted graph clean: `disabled:false` is the default, so
        // drop the key entirely rather than writing a redundant false.
        if (merged.disabled !== true) delete merged.disabled;
        return merged;
      });
      const nextFlow = definitionToFlow(
        { nodes: nextNodes, edges: def.edges },
        defsByType,
        employeesById,
      );
      setNodes(nextFlow.nodes.map((n) => (n.id === nodeId ? { ...n, selected: true } : n)));
      setEdges(nextFlow.edges);
      markDirtyAndSave();
    },
    [defsByType, employeesById, setNodes, setEdges, markDirtyAndSave],
  );

  const onToggleDisabled = useCallback(
    (nodeId: string) => {
      const node = latest.current.nodes.find((n) => n.id === nodeId)?.data.node;
      if (!node || node.type === 'TRIGGER') return; // validator rejects it anyway
      patchNodeFields(nodeId, { disabled: !node.disabled });
    },
    [patchNodeFields],
  );

  const onOpenNode = useCallback(
    (nodeId: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })));
      setSelectedId(nodeId);
    },
    [setNodes],
  );

  const onRenameCommit = useCallback(
    (nodeId: string, name: string) => {
      setRenamingNodeId(null);
      const current = latest.current.nodes.find((n) => n.id === nodeId)?.data.node;
      // Empty (Escape / cleared) cancels; unchanged is a no-op so we don't dirty
      // the graph and trigger a pointless save.
      if (!name || !current || current.name === name) return;
      patchNodeFields(nodeId, { name });
    },
    [patchNodeFields],
  );

  /** Internal clipboard — a copied node survives until the page unloads. */
  const clipboard = useRef<WorkflowNode | null>(null);
  const onCopyNode = useCallback((nodeId: string) => {
    const node = latest.current.nodes.find((n) => n.id === nodeId)?.data.node;
    if (node) clipboard.current = { ...node, config: { ...node.config } };
  }, []);

  /**
   * Paste the copied node as a fresh, disconnected node (new id, offset so it
   * doesn't land exactly on the original), then select it. No-op when the
   * clipboard is empty. Completes the copy/paste pair — copy alone was a
   * half-gesture with nowhere to land.
   */
  const onPasteNode = useCallback(() => {
    const src = clipboard.current;
    if (!src) return;
    const def = flowToDefinition(latest.current.nodes, latest.current.edges);
    const pasted: WorkflowNode = {
      id: newNodeId(src.type),
      type: src.type,
      config: { ...src.config },
      position: { x: (src.position?.x ?? 0) + 48, y: (src.position?.y ?? 0) + 48 },
      ...(src.name ? { name: `${src.name} copy` } : {}),
    };
    const next = definitionToFlow(
      { nodes: [...def.nodes, pasted], edges: def.edges },
      defsByType,
      employeesById,
    );
    setNodes(next.nodes.map((n) => ({ ...n, selected: n.id === pasted.id })));
    setEdges(next.edges);
    setSelectedId(pasted.id);
    markDirtyAndSave();
  }, [defsByType, employeesById, setNodes, setEdges, markDirtyAndSave]);

  const onSelectAll = useCallback(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
  }, [setNodes]);

  const onClearSelection = useCallback(() => {
    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setSelectedId(null);
  }, [setNodes]);

  /** Re-run the dagre auto-layout over the whole graph, then save. */
  const onTidyUp = useCallback(() => {
    const positions = layoutGraph(
      latest.current.nodes.map((n) => ({ id: n.id, category: n.data.category })),
      latest.current.edges.map((e) => ({ source: e.source, target: e.target })),
    );
    setNodes((ns) => ns.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })));
    markDirtyAndSave();
  }, [setNodes, markDirtyAndSave]);

  /** Restore a definition to the canvas and persist it WITHOUT pushing history. */
  const applyDefinition = useCallback(
    (definition: WorkflowDefinition) => {
      const next = definitionToFlow(definition, defsByType, employeesById);
      dirtyRef.current = true; // keep the re-seed effect from clobbering before save
      setNodes(next.nodes);
      setEdges(next.edges);
      setSelectedId(null);
      saveDefinition(definition, { pushHistory: false });
    },
    [defsByType, employeesById, setNodes, setEdges, saveDefinition],
  );

  const undo = useCallback(() => {
    if (!hist.canUndo(history.current)) return;
    history.current = hist.undo(history.current);
    syncHistFlags();
    applyDefinition(hist.current(history.current));
  }, [applyDefinition, syncHistFlags]);

  const redo = useCallback(() => {
    if (!hist.canRedo(history.current)) return;
    history.current = hist.redo(history.current);
    syncHistFlags();
    applyDefinition(hist.current(history.current));
  }, [applyDefinition, syncHistFlags]);

  const nodeActions = useMemo<NodeActions>(
    () => ({
      onOpen: onOpenNode,
      onRename: setRenamingNodeId,
      renamingNodeId,
      onRenameCommit,
      onToggleDisabled,
      onCopy: onCopyNode,
      onDuplicate: onDuplicateNode,
      onDelete: onDeleteNode,
      onSelectAll,
      onClearSelection,
      onTidyUp,
    }),
    [
      onOpenNode,
      renamingNodeId,
      onRenameCommit,
      onToggleDisabled,
      onCopyNode,
      onDuplicateNode,
      onDeleteNode,
      onSelectAll,
      onClearSelection,
      onTidyUp,
    ],
  );

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  // Mirrors the context menu exactly, so both routes stay in sync. React Flow
  // owns Delete/Backspace via `deleteKeyCode`; everything else lives here.
  // Never fires while the user is typing in a field (including inline rename).
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        onSelectAll();
        return;
      }
      if (e.shiftKey && e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        onTidyUp();
        return;
      }
      if (e.key === 'Escape') {
        onClearSelection();
        return;
      }
      // Paste works with nothing selected (it drops a fresh node), so it lives
      // above the single-selection guard.
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        onPasteNode();
        return;
      }
      // The remaining shortcuts act on the single selected node.
      if (!selectedId) return;
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        onCopyNode(selectedId);
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        onDuplicateNode(selectedId);
      } else if (e.key === ' ') {
        e.preventDefault();
        setRenamingNodeId(selectedId);
      } else if (e.key.toLowerCase() === 'd' && !mod) {
        e.preventDefault();
        onToggleDisabled(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    editable,
    selectedId,
    undo,
    redo,
    onSelectAll,
    onClearSelection,
    onTidyUp,
    onCopyNode,
    onPasteNode,
    onDuplicateNode,
    onToggleDisabled,
  ]);

  // Publish the save state upward. Effect (not inline) so the parent's setState
  // never runs during this component's render.
  //
  // `doSave` is deliberately NOT a dependency. It is rebuilt on every render
  // (it closes over the react-query mutation object, whose identity changes
  // each render), so depending on it re-fired this effect every render — the
  // parent set state, which re-rendered the canvas, which fired it again:
  // "Maximum update depth exceeded". Caught in a browser, not by tsc.
  const doSaveRef = useRef(doSave); // latest-value ref, read only inside callbacks
  doSaveRef.current = doSave;
  useEffect(() => {
    onSaveStateChange?.(saveState, () => doSaveRef.current());
  }, [saveState, onSaveStateChange]);

  // External "open this step" requests (from the Review & Publish issue list).
  useEffect(() => {
    if (!selectNodeId) return;
    setSelectedId(selectNodeId);
  }, [selectNodeId]);

  const reloadFromServer = useCallback(() => {
    dirtyRef.current = false;
    setSaveState('idle');
    void qc.invalidateQueries({ queryKey: workflowKeys.detail(workflow.id) });
  }, [qc, workflow.id]);

  const selectedNode = selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null;

  if (defsLoading && flow.nodes.length > 0) {
    return (
      <div
        className="h-[72vh] w-full animate-pulse rounded-2xl border border-wf-hairline bg-canvas"
        aria-busy="true"
        aria-label="Loading your workflow"
      />
    );
  }

  if (flow.nodes.length === 0 && !editable) {
    return (
      <div className="rounded-2xl border border-wf-hairline bg-canvas p-6">
        <EmptyState
          title="This workflow is empty"
          body="It has no steps yet. Open the Steps view to add the first one."
          size="page"
        />
      </div>
    );
  }

  return (
    <div>
      {saveState === 'conflict' && (
        <div className="mb-3 flex items-center justify-between gap-4 rounded-xl border border-status-waiting/30 bg-status-waiting/10 px-4 py-3">
          <p className="text-sm text-status-waiting">
            Someone else edited this workflow, so your latest change wasn&apos;t saved. Reload to get their version.
          </p>
          <button
            type="button"
            onClick={reloadFromServer}
            className="shrink-0 rounded-lg border border-status-waiting/40 px-3 py-1.5 text-sm font-medium text-status-waiting hover:bg-status-waiting/10"
          >
            Reload
          </button>
        </div>
      )}

      {locked && (
        <div
          className="mb-3 flex items-center gap-2 rounded-xl border border-cat-employee/30 bg-cat-employee/10 px-4 py-2.5"
          aria-live="polite"
        >
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-cat-employee" />
          <p className="text-sm text-cat-employee">
            {lockedReason ?? 'Orlixa is editing this workflow — you can look around, but hold off on changes.'}
          </p>
        </div>
      )}

      <div className="mb-2 flex h-6 items-center justify-between text-xs">
        <div className="flex items-center gap-1">
          {editable ? (
            <>
              <button
                type="button"
                onClick={undo}
                disabled={!historyFlags.canUndo}
                title="Undo (⌘Z)"
                aria-label="Undo"
                className="flex h-6 w-6 items-center justify-center rounded-md text-wf-ink-2 transition-colors hover:bg-white/[0.06] hover:text-wf-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={!historyFlags.canRedo}
                title="Redo (⌘⇧Z)"
                aria-label="Redo"
                className="flex h-6 w-6 items-center justify-center rounded-md text-wf-ink-2 transition-colors hover:bg-white/[0.06] hover:text-wf-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Redo2 className="h-3.5 w-3.5" aria-hidden />
              </button>
              {invalidHint ? (
                <span className="ml-2 text-status-failed" aria-live="polite">
                  {invalidHint}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        {editable ? <AutosaveStatus state={saveState} onRetry={doSave} /> : null}
      </div>

      <div className="flex gap-3">
        {editable && (
          <NodeLibrary defs={nodeDefs ?? []} onAdd={handleAdd} disabled={saveState === 'conflict'} />
        )}
        <div
          className="relative h-[72vh] flex-1 overflow-hidden rounded-2xl border border-wf-hairline bg-canvas"
          role="application"
          aria-label={`${workflow.name} canvas${editable ? '' : ' — read only'}`}
        >
          <NodeActionsContext.Provider value={editable ? nodeActions : null}>
          <RunOverlayContext.Provider value={watchMode ? runStatusByNodeId : null}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={editable ? onConnect : undefined}
            isValidConnection={editable ? isValidConnection : undefined}
            onNodeDragStop={editable ? markDirtyAndSave : undefined}
            onNodesDelete={editable ? markDirtyAndSave : undefined}
            onEdgesDelete={editable ? markDirtyAndSave : undefined}
            nodeTypes={NODE_TYPES}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.75}
            nodesDraggable={editable}
            nodesConnectable={editable}
            elementsSelectable
            onSelectionChange={({ nodes: selection }) => setSelectedId(selection[0]?.id ?? null)}
            deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
            proOptions={{ hideAttribution: true }}
            onlyRenderVisibleElements
          >
            <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="#0B0E18" />
            {/* The minimap helps navigate a large graph in the full builder, but
                is just clutter in the small read-only preview (e.g. AI Assist),
                so it's shown only when the canvas is editable. */}
            {editable && (
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => MINIMAP_COLOR[(n.data as { tone?: string }).tone ?? ''] ?? '#475569'}
                maskColor="rgba(2,3,10,0.7)"
                style={{ backgroundColor: '#0B0E18' }}
              />
            )}
            <Controls showInteractive={false} />
          </ReactFlow>
          </RunOverlayContext.Provider>
          </NodeActionsContext.Provider>

          {editable && nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div className="pointer-events-auto max-w-xs rounded-2xl border border-wf-hairline bg-void-card/95 p-6 text-center">
                <p className="font-display text-sm font-semibold text-wf-ink">Start your workflow</p>
                <p className="mt-1 text-xs text-wf-ink-2">
                  Add a trigger, then chain steps from the palette on the left.
                </p>
                <button
                  type="button"
                  onClick={() => handleAdd('TRIGGER')}
                  className="mt-3 rounded-lg bg-violet px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wf-focus"
                >
                  Add a trigger
                </button>
              </div>
            </div>
          )}
        </div>
        {watchMode ? (
          <DebugPanel run={run} selectedNode={selectedNode?.data.node ?? null} />
        ) : editable ? (
          <Inspector
            node={selectedNode?.data.node ?? null}
            def={selectedNode ? defsByType.get(selectedNode.data.node.type) : undefined}
            workflow={workflow}
            employees={employees ?? []}
            skills={skills ?? []}
            onPatch={(patch) => {
              if (selectedId) onNodePatch(selectedId, patch);
            }}
            onClose={closeInspector}
          />
        ) : null}
      </div>
      <Outline nodes={nodes} />
    </div>
  );
}

/**
 * The workflow canvas (doc 29 §3.B). Renders the persisted definition as a
 * dagre-laid-out React Flow graph — AI Employees as people, approvals as gold
 * gates, machinery as quiet slate. `editable` turns on drag/connect/delete/add
 * with debounced autosave (PATCH the definition column, 409 → conflict banner);
 * otherwise it's a read-only surface reused by the Watch/Version-view skins.
 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
