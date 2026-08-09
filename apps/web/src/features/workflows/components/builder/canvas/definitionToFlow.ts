import type { Edge, Node } from '@xyflow/react';
import type {
  AiEmployeeDto,
  NodeCategory,
  NodeDefinitionDto,
  NodeType,
  WorkflowDefinition,
  WorkflowNode,
} from '@vaep/types';
import { NODE_CATEGORY_META } from '../../../nodeMeta';
import { NODE_LABELS } from '../../../labels';
import { layoutGraph } from './layout';

/** One derived source handle on a node (a plain out, or a named branch). */
export interface CanvasSourceHandle {
  /** Matches the edge `sourceHandle` — 'default' for the unbranched output. */
  id: string;
  /** Shown as a pill under the handle for real branches (True/False/cases). */
  label?: string;
}

/** Data React Flow hands to `WorkflowNodeCard` (doc 29 §3.2 anatomy). */
export interface WorkflowCanvasNodeData {
  node: WorkflowNode;
  category: NodeCategory;
  title: string;
  subtitle?: string;
  /** `cat-*` tone token — keys the card's static colour classes. */
  tone: string;
  /** lucide icon name from `NODE_CATEGORY_META` (card resolves it to a component). */
  iconName: string;
  /** Short 2-3 letter code badge (n8n-style), e.g. 'API' / 'IF' / 'MSG'. */
  code: string;
  hasTarget: boolean;
  /**
   * Input ports. One id-less default for the common single-input node; several
   * (`in-0`, `in-1`…) when multiple edges fan in (a merge/JOIN), so each arriving
   * edge lands on its own port like the n8n reference.
   */
  targetHandles: { id?: string }[];
  sourceHandles: CanvasSourceHandle[];
  /** Present only for AI Employee nodes — drives the signature person card. */
  employee?: { name: string; role: string; unresolved: boolean };
  /** A run can pause here for a human (APPROVAL, or a high-risk tool). */
  pausesForApproval: boolean;
  hasSideEffects: boolean;
  // React Flow v12 requires node data to be an index-able record.
  [key: string]: unknown;
}

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, 'workflowNode'>;

const DEFAULT_HANDLE = 'default';

function str(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The one-line human summary shown under the title (doc 29 §3.2 subtitle). */
function nodeSubtitle(node: WorkflowNode, def?: NodeDefinitionDto): string | undefined {
  const c = node.config ?? {};
  switch (node.type) {
    case 'AI_EMPLOYEE_STEP':
    case 'AI_STEP':
      return str(c, 'instruction') ?? str(c, 'prompt');
    case 'TOOL_ACTION': {
      const skill = str(c, 'skillKey');
      const tool = str(c, 'tool');
      if (skill && tool) return `Use ${skill} to ${tool.replace(/_/g, ' ')}`;
      return skill ?? tool;
    }
    case 'RETRIEVE':
      return str(c, 'query');
    case 'CONDITION': {
      const left = str(c, 'left');
      const op = str(c, 'op');
      const right = str(c, 'right');
      return [left, op, right].filter(Boolean).join(' ') || undefined;
    }
    case 'WAIT': {
      const ms = c.durationMs;
      return typeof ms === 'number' ? `Wait ${ms} ms` : undefined;
    }
    case 'APPROVAL':
      return str(c, 'message') ?? 'Waits for a manager decision';
    case 'SET_VARIABLE': {
      const name = str(c, 'name');
      return name ? `Set ${name}` : undefined;
    }
    default:
      return def?.description;
  }
}

function nodeTitle(node: WorkflowNode, def?: NodeDefinitionDto): string {
  return node.name?.trim() || def?.label || NODE_LABELS[node.type] || node.type;
}

// Short badge codes per node type (n8n-style letter chips).
const NODE_CODE: Record<NodeType, string> = {
  TRIGGER: 'TRG',
  RETRIEVE: 'KB',
  AI_STEP: 'AI',
  TOOL_ACTION: 'API',
  WAIT: 'WT',
  CONDITION: 'IF',
  NOTIFY: 'MSG',
  APPROVAL: 'APR',
  AI_EMPLOYEE_STEP: 'AI',
  SWITCH: 'SW',
  PARALLEL: 'FAN',
  JOIN: 'JN',
  LOOP: 'LP',
  TERMINATE: 'END',
  SET_VARIABLE: 'VAR',
  TRANSFORM: 'FX',
  MEMORY_READ: 'MEM',
  MEMORY_WRITE: 'MEM',
  NOOP: '·',
};

// A tool node's badge reads from the skill it calls, like the reference (CRM/MSG…).
const SKILL_CODE: Record<string, string> = {
  gmail: 'MSG',
  email: 'MSG',
  slack: 'MSG',
  hubspot: 'CRM',
  salesforce: 'CRM',
  stripe: 'PAY',
  github: 'GIT',
  gdrive: 'DRV',
  gcalendar: 'CAL',
  calendar: 'CAL',
  http: 'API',
  jira: 'JRA',
  postiz: 'SOC',
};

function nodeCode(node: WorkflowNode, def?: NodeDefinitionDto): string {
  if (node.type === 'TOOL_ACTION') {
    const skill = str(node.config ?? {}, 'skillKey');
    if (skill && SKILL_CODE[skill]) return SKILL_CODE[skill];
  }
  return NODE_CODE[node.type] ?? (def?.label ?? node.type).slice(0, 3).toUpperCase();
}

/**
 * Derive a node's source handles from its definition outputs unioned with the
 * branches its outgoing edges actually use — so CONDITION shows True/False even
 * if one side is unwired, while dynamic SWITCH/PARALLEL/LOOP nodes surface their
 * real (config-authored) branches. A node the registry says has no outputs
 * (e.g. TERMINATE) gets none.
 */
function deriveSourceHandles(
  node: WorkflowNode,
  def: NodeDefinitionDto | undefined,
  outgoing: WorkflowDefinition['edges'],
): CanvasSourceHandle[] {
  const allowsOutput =
    (def ? def.outputs.length > 0 || Boolean(def.dynamicOutputs) : true) ||
    outgoing.length > 0;
  if (!allowsOutput) return [];

  // id → label (undefined label = the plain default output)
  const handles = new Map<string, string | undefined>();
  for (const out of def?.outputs ?? []) {
    handles.set(out.branch ?? DEFAULT_HANDLE, out.branch ? out.label : undefined);
  }
  for (const edge of outgoing) {
    const id = edge.branch ?? DEFAULT_HANDLE;
    if (!handles.has(id)) handles.set(id, edge.branch);
  }
  if (handles.size === 0) handles.set(DEFAULT_HANDLE, undefined);

  return [...handles.entries()].map(([id, label]) => ({ id, label }));
}

/**
 * Map a persisted workflow definition into React Flow nodes + edges, laid out
 * top-down by dagre. Registry-driven (keys off `NodeCategory`, never
 * `switch(NodeType)` for visuals) and pure — the same inputs always produce the
 * same graph.
 */
export function definitionToFlow(
  definition: WorkflowDefinition | null | undefined,
  defsByType: Map<NodeType, NodeDefinitionDto>,
  employeesById: Map<string, AiEmployeeDto>,
): { nodes: WorkflowCanvasNode[]; edges: Edge[] } {
  const rawNodes = definition?.nodes ?? [];
  const rawEdges = definition?.edges ?? [];

  // Group incoming edges per node so a fan-in (merge/JOIN) can show one input
  // port per arriving edge, and each edge can land on its own port.
  const incomingByTarget = new Map<string, WorkflowDefinition['edges']>();
  for (const edge of rawEdges) {
    const list = incomingByTarget.get(edge.to);
    if (list) list.push(edge);
    else incomingByTarget.set(edge.to, [edge]);
  }

  const enriched = rawNodes.map((node) => {
    const def = defsByType.get(node.type);
    const category: NodeCategory = def?.category ?? 'UTILITY';
    const meta = NODE_CATEGORY_META[category];
    const outgoing = rawEdges.filter((e) => e.from === node.id);
    const incoming = incomingByTarget.get(node.id) ?? [];
    const hasTarget = def ? def.inputs > 0 : node.type !== 'TRIGGER';
    const targetHandles: { id?: string }[] = !hasTarget
      ? []
      : incoming.length > 1
        ? incoming.map((_, i) => ({ id: `in-${i}` }))
        : [{}];

    let employee: WorkflowCanvasNodeData['employee'];
    let title = nodeTitle(node, def);
    if (category === 'AI_EMPLOYEE') {
      const id = str(node.config ?? {}, 'employeeId');
      const isPlaceholder = !id || id.includes('{{');
      if (isPlaceholder) {
        employee = { name: 'Unassigned', role: '', unresolved: false };
      } else {
        const hit = employeesById.get(id);
        employee = hit
          ? { name: hit.name, role: hit.role, unresolved: false }
          : { name: 'Removed employee', role: '', unresolved: true };
      }
      // The person is the title of the signature card.
      title = node.name?.trim() || employee.name;
    }

    return {
      node,
      def,
      category,
      meta,
      outgoing,
      hasTarget,
      targetHandles,
      title,
      employee,
    };
  });

  const positions = layoutGraph(
    enriched.map((e) => ({ id: e.node.id, category: e.category })),
    rawEdges.map((e) => ({ source: e.from, target: e.to })),
  );

  const nodes: WorkflowCanvasNode[] = enriched.map((e) => ({
    id: e.node.id,
    type: 'workflowNode',
    // A persisted manual position wins; dagre only seeds unpositioned nodes.
    position: e.node.position ?? positions.get(e.node.id) ?? { x: 0, y: 0 },
    data: {
      node: e.node,
      category: e.category,
      title: e.title,
      subtitle: nodeSubtitle(e.node, e.def),
      tone: e.meta.tone,
      iconName: e.meta.icon,
      code: nodeCode(e.node, e.def),
      hasTarget: e.hasTarget,
      targetHandles: e.targetHandles,
      sourceHandles: deriveSourceHandles(e.node, e.def, e.outgoing),
      employee: e.employee,
      pausesForApproval: e.def?.canPauseForApproval ?? e.node.type === 'APPROVAL',
      hasSideEffects: e.def?.hasSideEffects ?? false,
    },
  }));

  const edges: Edge[] = rawEdges.map((edge, i) => {
    const sourceDef = defsByType.get(
      rawNodes.find((n) => n.id === edge.from)?.type ?? ('NOOP' as NodeType),
    );
    const label = edge.branch
      ? sourceDef?.outputs.find((o) => o.branch === edge.branch)?.label ?? edge.branch
      : undefined;
    // Land on a specific input port only when the target has several (a merge).
    const targetIncoming = incomingByTarget.get(edge.to) ?? [];
    const targetHandle =
      targetIncoming.length > 1 ? `in-${targetIncoming.indexOf(edge)}` : undefined;
    return {
      id: `${edge.from}__${edge.to}__${edge.branch ?? DEFAULT_HANDLE}__${i}`,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.branch ?? DEFAULT_HANDLE,
      targetHandle,
      label,
      type: 'default',
    };
  });

  return { nodes, edges };
}
