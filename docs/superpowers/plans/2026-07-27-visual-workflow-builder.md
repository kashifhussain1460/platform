# Visual Workflow Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the linear, list-based workflow step editor with a visual, drag-and-drop, node-based canvas (n8n/Zapier-style) — full replace, zero backend changes, existing functionality fully preserved.

**Architecture:** A React Flow (`@xyflow/react`) canvas renders `Workflow.definition`'s existing `nodes[]`/`edges[]` graph. A new optional `position` field on `WorkflowNode` (display-only; the backend engine never reads it) lets the canvas persist layout. All graph-editing logic (seeding, auto-layout, branch bridging on delete) is extracted into pure, unit-tested functions in `graph-transform.ts`; the canvas component wires those functions to React Flow's controlled-state API. The existing `NodeEditor.tsx` form is reused unmodified inside a new side panel opened on node click.

**Tech Stack:** Next.js 14 (App Router) · React 18.3 · TypeScript 5.5 · `@tanstack/react-query` 5 · `@xyflow/react` (new) · `dagre` (new, auto-layout) · Vitest 2.1 + `@testing-library/react` (existing test setup, `apps/web/vitest.config.ts`).

## Global Constraints

- **Full replace** — `NodeList.tsx` is deleted, not kept behind a toggle.
- **Functionality must not change** — every existing capability (add step, delete-with-branch-warning + bridging, per-node config editing, CONDITION true/false branching, save with `expectedUpdatedAt` optimistic concurrency, warnings banner, TRIGGER pinned/non-deletable) must keep working identically.
- **Minimize code changes** — reuse `NodeEditor.tsx`, `labels.ts` (`NODE_ICONS`/`NODE_TONES`/`NODE_LABELS`/`NODE_HINTS`/`defaultConfig`), `hooks.ts` (`useUpdateWorkflow`), and `schemas.ts` (`NODE_TYPES`) unchanged.
- **Zero backend changes** — `Workflow.definition` is a Prisma `Json` column; `WorkflowEngine` does not read `position`. No migration, no API changes.
- Approved spec: `docs/superpowers/specs/2026-07-27-visual-workflow-builder-design.md`.

---

### Task 1: Add `position` to the shared `WorkflowNode` type

**Files:**
- Modify: `platform/packages/types/src/index.ts` (the `WorkflowNode` interface, currently at line 998)

**Interfaces:**
- Produces: `WorkflowNode.position?: { x: number; y: number }` — every later task relies on this field existing on `WorkflowNode`.

- [ ] **Step 1: Add the field**

In `platform/packages/types/src/index.ts`, change:

```ts
/** One node in a workflow graph. Templates use `{{a.b.c}}` context lookups. */
export interface WorkflowNode {
  id: string;
  type: NodeType;
  name?: string;
  config: Record<string, unknown>;
}
```

to:

```ts
/** One node in a workflow graph. Templates use `{{a.b.c}}` context lookups. */
export interface WorkflowNode {
  id: string;
  type: NodeType;
  name?: string;
  config: Record<string, unknown>;
  /** Canvas layout only — the engine never reads this. */
  position?: { x: number; y: number };
}
```

- [ ] **Step 2: Rebuild the shared types package**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/types build`
Expected: `tsc -p tsconfig.build.json` completes with no output (success).

- [ ] **Step 3: Typecheck both apps to confirm the additive change breaks nothing**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/api run typecheck && pnpm --filter @vaep/web run typecheck`
Expected: both complete with no errors (the field is optional, so no existing code that constructs a `WorkflowNode` needs to change).

- [ ] **Step 4: Commit**

```bash
cd "d:/Vertical AI/platform"
git add packages/types/src/index.ts
git commit -m "feat(types): add optional position field to WorkflowNode for canvas layout"
```

---

### Task 2: Install canvas dependencies

**Files:**
- Modify: `platform/apps/web/package.json`, `platform/pnpm-lock.yaml`

**Interfaces:**
- Produces: `@xyflow/react` and `dagre` importable from `apps/web` source; `@types/dagre` for TypeScript.

- [ ] **Step 1: Add the runtime dependencies**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/web add @xyflow/react dagre`

- [ ] **Step 2: Add the dagre type definitions (dev dependency)**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/web add -D @types/dagre`

- [ ] **Step 3: Verify the install resolved correctly**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/web run typecheck`
Expected: passes (nothing imports the new packages yet, this just confirms the install didn't corrupt anything).

Run: `grep -n "@xyflow/react\|dagre" "d:/Vertical AI/platform/apps/web/package.json"`
Expected: three lines showing `@xyflow/react` and `dagre` under `dependencies`, `@types/dagre` under `devDependencies`.

- [ ] **Step 4: Commit**

```bash
cd "d:/Vertical AI/platform"
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add @xyflow/react + dagre for the visual workflow builder"
```

---

### Task 3: Graph transform pure functions (TDD)

**Files:**
- Create: `platform/apps/web/src/features/workflows/canvas/graph-transform.ts`
- Create: `platform/apps/web/src/features/workflows/canvas/graph-transform.test.ts`

**Interfaces:**
- Consumes: `WorkflowNode`, `WorkflowEdge`, `NodeType` from `@vaep/types` (unchanged except Task 1's new `position` field); `WorkflowDto` from `@vaep/types` (existing).
- Produces (consumed by Tasks 4–6):
  - `interface WorkflowNodeData { nodeType: NodeType; name?: string }`
  - `type FlowNodeType = import('@xyflow/react').Node<WorkflowNodeData>`
  - `toFlowNodes(nodes: WorkflowNode[]): FlowNodeType[]`
  - `toFlowEdges(edges: WorkflowEdge[]): import('@xyflow/react').Edge[]`
  - `fromFlowEdges(flowEdges: import('@xyflow/react').Edge[]): WorkflowEdge[]`
  - `mergeFlowPositions(nodes: WorkflowNode[], flowNodes: FlowNodeType[]): WorkflowNode[]`
  - `layoutNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[]`
  - `hasMultiBranchOutgoing(nodeId: string, edges: WorkflowEdge[]): boolean`
  - `removeNodeWithBridging(nodeId: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] }`
  - `seedGraph(workflow: WorkflowDto): { nodes: WorkflowNode[]; edges: WorkflowEdge[] }` (internally uses a private, non-exported `seedNodes`/`seedEdges` — nothing outside this module needs them individually)

This task ports `NodeList.tsx`'s existing `seedNodes`/`seedEdges`/`removeNode`'s bridging logic verbatim into pure, independently testable functions — plus adds the new `toFlowNodes`/`toFlowEdges`/`fromFlowEdges`/`mergeFlowPositions`/`layoutNodes` needed for the canvas. While porting, this also fixes a latent bug in the original: `NodeList.tsx` called `seedNodes(workflow)` twice (once for its `nodes` state, once inside `seedEdges(workflow, seedNodes(workflow))` for its `edges` state) — since `seedNodes` calls a module-level `newId()` counter when it has to synthesize a node, the two calls can produce **different ids** for the synthesized node, so the bridge edge `seedEdges` builds can reference an id that doesn't match the actual seeded node. This only bites when a legacy workflow has no nodes or is missing its `TRIGGER`, but since this task's `layoutNodes` needs a *correct* edge graph to produce a sane auto-layout, it's fixed here by computing the seed once via `seedGraph` and reusing the result.

- [ ] **Step 1: Write the failing tests**

Create `platform/apps/web/src/features/workflows/canvas/graph-transform.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { WorkflowDto, WorkflowEdge, WorkflowNode } from '@vaep/types';
import {
  fromFlowEdges,
  hasMultiBranchOutgoing,
  layoutNodes,
  mergeFlowPositions,
  removeNodeWithBridging,
  seedGraph,
  toFlowEdges,
  toFlowNodes,
} from './graph-transform';

describe('toFlowNodes', () => {
  it('maps id/type/position, defaulting missing position to the origin, and marks TRIGGER non-deletable', () => {
    const nodes: WorkflowNode[] = [
      { id: 'n1', type: 'TRIGGER', config: {} },
      { id: 'n2', type: 'AI_STEP', name: 'Summarise', config: {}, position: { x: 10, y: 20 } },
    ];
    const result = toFlowNodes(nodes);
    expect(result).toEqual([
      { id: 'n1', type: 'workflowNode', position: { x: 0, y: 0 }, data: { nodeType: 'TRIGGER' }, deletable: false },
      { id: 'n2', type: 'workflowNode', position: { x: 10, y: 20 }, data: { nodeType: 'AI_STEP', name: 'Summarise' }, deletable: true },
    ]);
  });
});

describe('toFlowEdges / fromFlowEdges', () => {
  it('marks a true-branch edge with the "yes" handle and a Yes label', () => {
    const [result] = toFlowEdges([{ from: 'c1', to: 't1', branch: 'true' }]);
    expect(result.source).toBe('c1');
    expect(result.target).toBe('t1');
    expect(result.sourceHandle).toBe('yes');
    expect(result.label).toBe('Yes');
  });

  it('marks a false-branch edge with the "no" handle and a No label', () => {
    const [result] = toFlowEdges([{ from: 'c1', to: 'f1', branch: 'false' }]);
    expect(result.sourceHandle).toBe('no');
    expect(result.label).toBe('No');
  });

  it('leaves a plain edge with no sourceHandle or label', () => {
    const [result] = toFlowEdges([{ from: 'a', to: 'b' }]);
    expect(result.sourceHandle).toBeUndefined();
    expect(result.label).toBeUndefined();
  });

  it('round-trips branch info through toFlowEdges -> fromFlowEdges', () => {
    const original: WorkflowEdge[] = [
      { from: 'c1', to: 't1', branch: 'true' },
      { from: 'c1', to: 'f1', branch: 'false' },
      { from: 'a', to: 'b' },
    ];
    expect(fromFlowEdges(toFlowEdges(original))).toEqual(original);
  });
});

describe('mergeFlowPositions', () => {
  it('updates only position, leaving type/config/name untouched', () => {
    const nodes: WorkflowNode[] = [
      { id: 'n1', type: 'AI_STEP', name: 'Step', config: { prompt: 'hi' }, position: { x: 0, y: 0 } },
    ];
    const flowNodes = toFlowNodes(nodes).map((fn) => ({ ...fn, position: { x: 99, y: 88 } }));
    expect(mergeFlowPositions(nodes, flowNodes)).toEqual([
      { id: 'n1', type: 'AI_STEP', name: 'Step', config: { prompt: 'hi' }, position: { x: 99, y: 88 } },
    ]);
  });
});

describe('layoutNodes', () => {
  it('leaves positions untouched when every node already has one', () => {
    const nodes: WorkflowNode[] = [
      { id: 'n1', type: 'TRIGGER', config: {}, position: { x: 5, y: 5 } },
      { id: 'n2', type: 'NOTIFY', config: {}, position: { x: 5, y: 200 } },
    ];
    const edges: WorkflowEdge[] = [{ from: 'n1', to: 'n2' }];
    expect(layoutNodes(nodes, edges)).toEqual(nodes);
  });

  it('computes a top-to-bottom layout, placing the trigger above its successor, when positions are missing', () => {
    const nodes: WorkflowNode[] = [
      { id: 'n1', type: 'TRIGGER', config: {} },
      { id: 'n2', type: 'NOTIFY', config: {} },
    ];
    const edges: WorkflowEdge[] = [{ from: 'n1', to: 'n2' }];
    const result = layoutNodes(nodes, edges);
    const trigger = result.find((n) => n.id === 'n1')!;
    const notify = result.find((n) => n.id === 'n2')!;
    expect(trigger.position).toBeDefined();
    expect(notify.position).toBeDefined();
    expect(trigger.position!.y).toBeLessThan(notify.position!.y);
  });
});

describe('hasMultiBranchOutgoing', () => {
  it('is false when zero or one branch is wired', () => {
    expect(hasMultiBranchOutgoing('c1', [])).toBe(false);
    expect(hasMultiBranchOutgoing('c1', [{ from: 'c1', to: 't1', branch: 'true' }])).toBe(false);
  });

  it('is true when both Yes and No are wired', () => {
    const edges: WorkflowEdge[] = [
      { from: 'c1', to: 't1', branch: 'true' },
      { from: 'c1', to: 'f1', branch: 'false' },
    ];
    expect(hasMultiBranchOutgoing('c1', edges)).toBe(true);
  });
});

describe('removeNodeWithBridging', () => {
  it('bridges a single predecessor to a single successor when removing a middle node', () => {
    const nodes: WorkflowNode[] = [
      { id: 'a', type: 'TRIGGER', config: {} },
      { id: 'b', type: 'NOTIFY', config: {} },
      { id: 'c', type: 'NOTIFY', config: {} },
    ];
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    const result = removeNodeWithBridging('b', nodes, edges);
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(result.edges).toEqual([{ from: 'a', to: 'c' }]);
  });

  it('fans a single incoming edge out to both outgoing targets when removing a two-branch CONDITION node', () => {
    const nodes: WorkflowNode[] = [
      { id: 'a', type: 'TRIGGER', config: {} },
      { id: 'c', type: 'CONDITION', config: {} },
      { id: 'yes-target', type: 'NOTIFY', config: {} },
      { id: 'no-target', type: 'NOTIFY', config: {} },
    ];
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'c' },
      { from: 'c', to: 'yes-target', branch: 'true' },
      { from: 'c', to: 'no-target', branch: 'false' },
    ];
    const result = removeNodeWithBridging('c', nodes, edges);
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'yes-target', 'no-target']);
    expect(result.edges).toHaveLength(2);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        { from: 'a', to: 'yes-target' },
        { from: 'a', to: 'no-target' },
      ]),
    );
  });

  it('removes a leaf node along with its incoming edge and adds no bridge', () => {
    const nodes: WorkflowNode[] = [
      { id: 'a', type: 'TRIGGER', config: {} },
      { id: 'b', type: 'NOTIFY', config: {} },
    ];
    const edges: WorkflowEdge[] = [{ from: 'a', to: 'b' }];
    const result = removeNodeWithBridging('b', nodes, edges);
    expect(result.nodes.map((n) => n.id)).toEqual(['a']);
    expect(result.edges).toEqual([]);
  });
});

describe('seedGraph', () => {
  function workflowWith(definition: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }): WorkflowDto {
    return {
      id: 'w1',
      companyId: 'c1',
      name: 'Test',
      description: null,
      status: 'DRAFT',
      definition,
      triggerType: 'MANUAL',
      triggerConfig: null,
      webhookToken: null,
      activatedAt: null,
      warnings: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('synthesizes a single TRIGGER with no edges for a brand-new workflow', () => {
    const { nodes, edges } = seedGraph(workflowWith({ nodes: [], edges: [] }));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('TRIGGER');
    expect(edges).toEqual([]);
  });

  it('prepends a synthesized TRIGGER and bridges it to the previously-first node, using the SAME synthesized id in both nodes and edges', () => {
    const existingNode: WorkflowNode = { id: 'existing', type: 'NOTIFY', config: {} };
    const { nodes, edges } = seedGraph(workflowWith({ nodes: [existingNode], edges: [] }));
    expect(nodes).toHaveLength(2);
    expect(nodes[0].type).toBe('TRIGGER');
    expect(nodes[1].id).toBe('existing');
    expect(edges).toEqual([{ from: nodes[0].id, to: 'existing' }]);
  });

  it('passes through a workflow that already has a TRIGGER and edges unchanged', () => {
    const nodes: WorkflowNode[] = [
      { id: 'a', type: 'TRIGGER', config: {} },
      { id: 'b', type: 'NOTIFY', config: {} },
    ];
    const edges: WorkflowEdge[] = [{ from: 'a', to: 'b' }];
    const result = seedGraph(workflowWith({ nodes, edges }));
    expect(result.nodes).toEqual(nodes);
    expect(result.edges).toEqual(edges);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "d:/Vertical AI/platform/apps/web" && npx vitest run src/features/workflows/canvas/graph-transform.test.ts`
Expected: FAIL — `Cannot find module './graph-transform'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `platform/apps/web/src/features/workflows/canvas/graph-transform.ts`:

```ts
import dagre from 'dagre';
import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/react';
import type { NodeType, WorkflowDto, WorkflowEdge, WorkflowNode } from '@vaep/types';

/** Data carried by every React Flow node — just enough for WorkflowNodeCard to render. */
export interface WorkflowNodeData {
  nodeType: NodeType;
  name?: string;
}

export type FlowNodeType = FlowNode<WorkflowNodeData>;

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

let seq = 0;
/** Monotonic suffix so ids stay unique even within the same millisecond. */
function newId(): string {
  seq += 1;
  return `node_${Date.now()}_${seq}`;
}

// --- WorkflowNode[]/WorkflowEdge[] <-> React Flow Node[]/Edge[] ------------

/** WorkflowNode[] -> React Flow Node[]. TRIGGER is never deletable. */
export function toFlowNodes(nodes: WorkflowNode[]): FlowNodeType[] {
  return nodes.map((n) => ({
    id: n.id,
    type: 'workflowNode',
    position: n.position ?? { x: 0, y: 0 },
    data: { nodeType: n.type, ...(n.name ? { name: n.name } : {}) },
    deletable: n.type !== 'TRIGGER',
  }));
}

/** React Flow Node[] (post drag) merged onto the original WorkflowNode[] — only position changes. */
export function mergeFlowPositions(
  nodes: WorkflowNode[],
  flowNodes: FlowNodeType[],
): WorkflowNode[] {
  const positionById = new Map(flowNodes.map((fn) => [fn.id, fn.position]));
  return nodes.map((n) => ({
    ...n,
    position: positionById.get(n.id) ?? n.position,
  }));
}

/** WorkflowEdge[] -> React Flow Edge[]. A branch becomes a labeled, colored, handle-targeted edge. */
export function toFlowEdges(edges: WorkflowEdge[]): FlowEdge[] {
  return edges.map((e) => {
    const sourceHandle = e.branch === 'true' ? 'yes' : e.branch === 'false' ? 'no' : undefined;
    const label = e.branch === 'true' ? 'Yes' : e.branch === 'false' ? 'No' : undefined;
    return {
      id: `${e.from}->${e.to}:${e.branch ?? 'default'}`,
      source: e.from,
      target: e.to,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(label ? { label } : {}),
    };
  });
}

/** React Flow Edge[] -> WorkflowEdge[] — inverse of toFlowEdges. */
export function fromFlowEdges(flowEdges: FlowEdge[]): WorkflowEdge[] {
  return flowEdges.map((e) => ({
    from: e.source,
    to: e.target,
    ...(e.sourceHandle === 'yes'
      ? { branch: 'true' as const }
      : e.sourceHandle === 'no'
        ? { branch: 'false' as const }
        : {}),
  }));
}

// --- Auto-layout ------------------------------------------------------------

/**
 * Top-to-bottom dagre auto-layout. Only runs when AT LEAST ONE node has no
 * saved position — if every node already has one (a previously-saved
 * workflow), returns `nodes` unchanged so a user's manual arrangement is
 * never silently overwritten.
 */
export function layoutNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  if (nodes.every((n) => n.position)) {
    return nodes;
  }
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((e) => g.setEdge(e.from, e.to));
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id) as { x: number; y: number } | undefined;
    // dagre gives the node's CENTER; React Flow's `position` is top-left.
    return {
      ...n,
      position: pos
        ? { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 }
        : { x: 0, y: 0 },
    };
  });
}

// --- Delete-with-bridging (ported verbatim from the old NodeList.removeNode) -

/** True when `nodeId` has BOTH a Yes and a No branch wired as outgoing edges. */
export function hasMultiBranchOutgoing(nodeId: string, edges: WorkflowEdge[]): boolean {
  const branches = new Set(
    edges.filter((e) => e.from === nodeId && e.branch).map((e) => e.branch),
  );
  return branches.size > 1;
}

/**
 * Remove `nodeId`, bridging each predecessor to each successor (preserving
 * the predecessor's own branch tag) so removing a middle node never leaves a
 * dangling chain. Same semantics as the old NodeList.removeNode.
 */
export function removeNodeWithBridging(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const incoming = edges.filter((e) => e.to === nodeId);
  const outgoing = edges.filter((e) => e.from === nodeId);
  const remaining = edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  const bridged = incoming.flatMap((inc) =>
    outgoing.map((out) => ({ from: inc.from, to: out.to, ...(inc.branch ? { branch: inc.branch } : {}) })),
  );
  return {
    nodes: nodes.filter((n) => n.id !== nodeId),
    edges: [...remaining, ...bridged],
  };
}

// --- Seeding (ported verbatim from the old NodeList.seedNodes/seedEdges) ----

/** Seed nodes from the persisted definition, guaranteeing a TRIGGER leads. */
function seedNodes(workflow: WorkflowDto): WorkflowNode[] {
  const existing = workflow.definition?.nodes ?? [];
  if (existing.length === 0) {
    return [{ id: newId(), type: 'TRIGGER', config: {} }];
  }
  if (existing.some((n) => n.type === 'TRIGGER')) {
    return existing;
  }
  return [{ id: newId(), type: 'TRIGGER', config: {} }, ...existing];
}

function seedEdges(workflow: WorkflowDto, nodes: WorkflowNode[]): WorkflowEdge[] {
  const persisted = workflow.definition?.edges ?? [];
  const hadTrigger = (workflow.definition?.nodes ?? []).some((n) => n.type === 'TRIGGER');
  if (!hadTrigger && nodes.length > 1) {
    return [{ from: nodes[0].id, to: nodes[1].id }, ...persisted];
  }
  return persisted;
}

/**
 * Seed nodes AND edges from ONE `seedNodes` call (not two) so a synthesized
 * TRIGGER's id is guaranteed to match the bridge edge that references it —
 * the original NodeList.tsx called `seedNodes` separately for its `nodes`
 * state and again inside `seedEdges(workflow, seedNodes(workflow))` for its
 * `edges` state, which could synthesize two DIFFERENT ids for the same
 * conceptual node when a legacy workflow had no TRIGGER, leaving the bridge
 * edge pointing at a phantom id.
 */
export function seedGraph(workflow: WorkflowDto): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes = seedNodes(workflow);
  const edges = seedEdges(workflow, nodes);
  return { nodes, edges };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "d:/Vertical AI/platform/apps/web" && npx vitest run src/features/workflows/canvas/graph-transform.test.ts`
Expected: PASS — all suites green (`toFlowNodes`, `toFlowEdges / fromFlowEdges`, `mergeFlowPositions`, `layoutNodes`, `hasMultiBranchOutgoing`, `removeNodeWithBridging`, `seedGraph`).

- [ ] **Step 5: Typecheck**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/web run typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
cd "d:/Vertical AI/platform"
git add apps/web/src/features/workflows/canvas/graph-transform.ts apps/web/src/features/workflows/canvas/graph-transform.test.ts
git commit -m "feat(web): pure graph-transform functions for the visual workflow builder"
```

---

### Task 4: `WorkflowNodeCard` — the React Flow node component

**Files:**
- Create: `platform/apps/web/src/features/workflows/components/WorkflowNodeCard.tsx`

**Interfaces:**
- Consumes: `WorkflowNodeData` from `../canvas/graph-transform` (Task 3); `NODE_ICONS`/`NODE_LABELS`/`NODE_HINTS`/`NODE_TONES` from `../labels` (existing, unchanged); `Handle`, `Position` from `@xyflow/react`.
- Produces: `WorkflowNodeCard` component, registered as React Flow's `"workflowNode"` type in Task 6.

- [ ] **Step 1: Write the component**

Create `platform/apps/web/src/features/workflows/components/WorkflowNodeCard.tsx`:

```tsx
'use client';

import { Handle, Position } from '@xyflow/react';
import { NODE_HINTS, NODE_ICONS, NODE_LABELS, NODE_TONES } from '../labels';
import type { WorkflowNodeData } from '../canvas/graph-transform';

/**
 * The single React Flow node-type used for every WorkflowNode. Icon/color
 * come from the existing labels.ts (no new styling system). CONDITION gets
 * two labeled source handles (Yes/No); every other non-TRIGGER type gets one
 * of each; TRIGGER gets a source handle only (nothing connects into it).
 */
export function WorkflowNodeCard({
  data,
  selected,
}: {
  data: WorkflowNodeData;
  selected?: boolean;
}) {
  const Icon = NODE_ICONS[data.nodeType];
  const isCondition = data.nodeType === 'CONDITION';

  return (
    <div
      className={`w-56 rounded-xl border bg-[#0b0b12] p-3 shadow-lg transition-colors ${
        selected ? 'border-violet' : 'border-white/[0.1]'
      }`}
    >
      {data.nodeType !== 'TRIGGER' && (
        <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-zinc-500" />
      )}

      <div className="flex items-center gap-2">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${NODE_TONES[data.nodeType]}`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">
            {NODE_LABELS[data.nodeType]}
          </p>
          <p className="truncate text-xs text-zinc-500">
            {data.name || NODE_HINTS[data.nodeType]}
          </p>
        </div>
      </div>

      {isCondition ? (
        <>
          <div className="mt-2 flex justify-between text-[10px] font-medium text-zinc-500">
            <span>Yes</span>
            <span>No</span>
          </div>
          <Handle
            type="source"
            position={Position.Bottom}
            id="yes"
            style={{ left: '30%' }}
            className="!h-2 !w-2 !bg-emerald-400"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="no"
            style={{ left: '70%' }}
            className="!h-2 !w-2 !bg-red-400"
          />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-zinc-500" />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/web run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
cd "d:/Vertical AI/platform"
git add apps/web/src/features/workflows/components/WorkflowNodeCard.tsx
git commit -m "feat(web): WorkflowNodeCard — React Flow node renderer for the visual builder"
```

---

### Task 5: `NodeConfigPanel` — side panel wrapping the existing `NodeEditor`

**Files:**
- Create: `platform/apps/web/src/features/workflows/components/NodeConfigPanel.tsx`

**Interfaces:**
- Consumes: `NodeEditor` from `./NodeEditor` (existing, unmodified); `NODE_ICONS`/`NODE_LABELS` from `../labels`; `WorkflowNode` from `@vaep/types`.
- Produces: `NodeConfigPanel` component, mounted by `WorkflowCanvas` in Task 6.

- [ ] **Step 1: Write the component**

Create `platform/apps/web/src/features/workflows/components/NodeConfigPanel.tsx`:

```tsx
'use client';

import type { WorkflowNode } from '@vaep/types';
import { NODE_ICONS, NODE_LABELS } from '../labels';
import { NodeEditor } from './NodeEditor';

/**
 * Right-side panel opened when a canvas node is clicked. Wraps the existing
 * NodeEditor form unmodified — only its mounting location changed (out of
 * an inline list-item, into this panel). TRIGGER has no delete button (it's
 * pinned, same as the old inline list).
 */
export function NodeConfigPanel({
  node,
  onChange,
  onClose,
  onDelete,
}: {
  node: WorkflowNode;
  onChange: (next: WorkflowNode) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const Icon = NODE_ICONS[node.type];

  return (
    <aside className="absolute right-0 top-0 z-10 h-full w-96 overflow-y-auto border-l border-white/[0.08] bg-[#0b0b12] p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-semibold text-white">{NODE_LABELS[node.type]}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="rounded-lg p-1 text-zinc-500 transition-colors hover:text-white"
        >
          ✕
        </button>
      </div>

      <NodeEditor node={node} onChange={onChange} />

      {node.type !== 'TRIGGER' && (
        <button
          type="button"
          onClick={onDelete}
          className="mt-5 w-full rounded-lg border border-red-500/20 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10"
        >
          Delete step
        </button>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/web run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
cd "d:/Vertical AI/platform"
git add apps/web/src/features/workflows/components/NodeConfigPanel.tsx
git commit -m "feat(web): NodeConfigPanel — side panel reusing the existing NodeEditor form"
```

---

### Task 6: `WorkflowCanvas` assembly, swap into the page, delete `NodeList`

**Files:**
- Create: `platform/apps/web/src/features/workflows/components/WorkflowCanvas.tsx`
- Modify: `platform/apps/web/src/app/(app)/workflows/[id]/page.tsx` (lines 8, 80)
- Delete: `platform/apps/web/src/features/workflows/components/NodeList.tsx`

**Interfaces:**
- Consumes: everything from Tasks 3–5 (`graph-transform.ts` functions, `WorkflowNodeCard`, `NodeConfigPanel`); `useUpdateWorkflow` from `../hooks` (existing); `NODE_TYPES` from `../schemas` (existing); `NODE_LABELS`/`defaultConfig` from `../labels` (existing); `Button` from `@/components/ui/Button` (existing).
- Produces: `WorkflowCanvas` component — the drop-in replacement for `NodeList`, same `{ workflow: WorkflowDto }` prop shape.

- [ ] **Step 1: Write `WorkflowCanvas.tsx`**

Create `platform/apps/web/src/features/workflows/components/WorkflowCanvas.tsx`:

```tsx
'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeType, WorkflowDto, WorkflowNode } from '@vaep/types';
import { Button } from '@/components/ui/Button';
import { useUpdateWorkflow } from '../hooks';
import { NODE_TYPES } from '../schemas';
import { NODE_LABELS, defaultConfig } from '../labels';
import {
  fromFlowEdges,
  hasMultiBranchOutgoing,
  layoutNodes,
  mergeFlowPositions,
  removeNodeWithBridging,
  seedGraph,
  toFlowEdges,
  toFlowNodes,
} from '../canvas/graph-transform';
import { NodeConfigPanel } from './NodeConfigPanel';
import { WorkflowNodeCard } from './WorkflowNodeCard';

let seq = 0;
function newId(): string {
  seq += 1;
  return `node_${Date.now()}_${seq}`;
}

/** Step choices exclude TRIGGER (the fixed, always-first entry node). */
const STEP_TYPES: NodeType[] = NODE_TYPES.filter((t) => t !== 'TRIGGER');
const nodeTypes = { workflowNode: WorkflowNodeCard };
const BRANCH_DELETE_WARNING =
  'This step has both a Yes and a No path. Deleting it will only keep ' +
  "one of the two paths connected — the other path's steps will no " +
  'longer run in this workflow. Delete anyway?';

function CanvasInner({ workflow }: { workflow: WorkflowDto }) {
  // Computed once per mount — never call seedNodes/seedEdges separately, or
  // a synthesized TRIGGER's id can drift between the two (see Task 3).
  const seed = useMemo(() => seedGraph(workflow), [workflow]);
  const [graphNodes, setGraphNodes] = useState<WorkflowNode[]>(() =>
    layoutNodes(seed.nodes, seed.edges),
  );
  const [graphEdges, setGraphEdges] = useState(() => seed.edges);
  const [addType, setAddType] = useState<NodeType>('AI_STEP');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const update = useUpdateWorkflow();

  const flowNodes = useMemo(() => toFlowNodes(graphNodes), [graphNodes]);
  const flowEdges = useMemo(() => toFlowEdges(graphEdges), [graphEdges]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setGraphNodes((cur) => mergeFlowPositions(cur, applyNodeChanges(changes, toFlowNodes(cur))));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setGraphEdges((cur) => fromFlowEdges(applyEdgeChanges(changes, toFlowEdges(cur))));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const branch =
      connection.sourceHandle === 'yes' ? ('true' as const)
      : connection.sourceHandle === 'no' ? ('false' as const)
      : undefined;
    setGraphEdges((cur) => [
      // Dragging a NEW connection from the same (source, handle) re-targets it.
      ...cur.filter((e) => !(e.from === connection.source && (branch ? e.branch === branch : !e.branch))),
      { from: connection.source, to: connection.target, ...(branch ? { branch } : {}) },
    ]);
  }, []);

  const addStep = () => {
    const prev = graphNodes[graphNodes.length - 1];
    const node: WorkflowNode = {
      id: newId(),
      type: addType,
      name: '',
      config: defaultConfig(addType),
      position: prev.position
        ? { x: prev.position.x, y: prev.position.y + 160 }
        : { x: 250, y: graphNodes.length * 140 },
    };
    setGraphNodes((cur) => [...cur, node]);
    setGraphEdges((cur) =>
      cur.some((e) => e.from === prev.id) ? cur : [...cur, { from: prev.id, to: node.id }],
    );
  };

  const updateNode = (id: string, next: WorkflowNode) =>
    setGraphNodes((cur) => cur.map((n) => (n.id === id ? next : n)));

  const deleteNode = (id: string) => {
    if (
      hasMultiBranchOutgoing(id, graphEdges) &&
      typeof window !== 'undefined' &&
      !window.confirm(BRANCH_DELETE_WARNING)
    ) {
      return;
    }
    const result = removeNodeWithBridging(id, graphNodes, graphEdges);
    setGraphNodes(result.nodes);
    setGraphEdges(result.edges);
    setSelectedId(null);
  };

  const onSave = () => {
    update.mutate({
      id: workflow.id,
      data: {
        definition: { nodes: graphNodes, edges: graphEdges },
        expectedUpdatedAt: workflow.updatedAt,
      },
    });
  };

  const selectedNode = graphNodes.find((n) => n.id === selectedId) ?? null;

  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-zinc-400">Steps</h2>
        <div className="flex items-center gap-2">
          <div className="w-44">
            <select
              className="field-modern text-sm"
              value={addType}
              onChange={(e) => setAddType(e.target.value as NodeType)}
            >
              {STEP_TYPES.map((t) => (
                <option key={t} value={t}>
                  {NODE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={addStep}
            className="rounded-lg border border-white/[0.1] px-3.5 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-white/[0.2] hover:text-white"
          >
            + Add step
          </button>
          <Button variant="violet" onClick={onSave} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {update.isError && (
        <p className="mb-3 text-sm text-red-400">
          {update.error?.message ?? 'Could not save workflow'}
        </p>
      )}
      {update.isSuccess && !update.isPending && (
        <p className="mb-3 text-sm text-green-400">Saved.</p>
      )}
      {workflow.warnings.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-400">
          {workflow.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <div className="relative h-[560px] overflow-hidden rounded-xl border border-white/[0.07]">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          deleteKeyCode={null}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>

        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            onChange={(next) => updateNode(selectedNode.id, next)}
            onClose={() => setSelectedId(null)}
            onDelete={() => deleteNode(selectedNode.id)}
          />
        )}
      </div>
    </section>
  );
}

/** Drop-in replacement for the old NodeList — same props, same call site. */
export function WorkflowCanvas({ workflow }: { workflow: WorkflowDto }) {
  return (
    <ReactFlowProvider>
      <CanvasInner workflow={workflow} />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 2: Swap the import and usage in the workflow detail page**

In `platform/apps/web/src/app/(app)/workflows/[id]/page.tsx`, change line 8:

```tsx
import { NodeList } from '@/features/workflows/components/NodeList';
```

to:

```tsx
import { WorkflowCanvas } from '@/features/workflows/components/WorkflowCanvas';
```

And change line 80:

```tsx
          <NodeList workflow={workflow} />
```

to:

```tsx
          <WorkflowCanvas workflow={workflow} />
```

- [ ] **Step 3: Delete the old linear editor**

```bash
cd "d:/Vertical AI/platform"
rm "apps/web/src/features/workflows/components/NodeList.tsx"
```

- [ ] **Step 4: Typecheck**

Run: `cd "d:/Vertical AI/platform" && pnpm --filter @vaep/web run typecheck`
Expected: passes (confirms nothing else imports the deleted `NodeList`).

Run: `grep -rn "NodeList" "d:/Vertical AI/platform/apps/web/src"`
Expected: no output (nothing left referencing it).

- [ ] **Step 5: Run the full web test suite**

Run: `cd "d:/Vertical AI/platform/apps/web" && npx vitest run`
Expected: all suites pass (the pre-existing `auth/__tests__/hooks.test.tsx` plus Task 3's `graph-transform.test.ts`).

- [ ] **Step 6: Manual verification (dev server)**

Run: `cd "d:/Vertical AI/platform" && pnpm dev` (web on :3000, api on :4000 — needs local infra up per the root `CLAUDE.md`'s "Run locally" section)

In a browser at `http://localhost:3000`:
1. Open an existing workflow that has more than one step. Confirm it renders as a canvas with nodes auto-laid-out top-to-bottom and connected edges, not a list.
2. Drag a node to a new position, click **Save**, reload the page. Confirm the node stays where you dropped it (position persisted).
3. Click a node. Confirm the right-side panel opens showing the same fields `NodeEditor` always showed for that node type. Edit a field, close the panel, reopen it — confirm the edit stuck (in local state, before Save).
4. Add a `CONDITION` step via **+ Add step**. Drag a connection from its "Yes" handle to one existing node, and from its "No" handle to another. Save, reload. Confirm both branches persisted (`GET` the workflow via the Network tab and check `definition.edges` has two entries with `branch: 'true'`/`'false'`).
5. Click the CONDITION node, click **Delete step** in the panel. Confirm the browser's native confirm dialog appears (both branches wired) and cancelling leaves everything unchanged.
6. Confirm again, accepting this time — confirm the node disappears and its predecessor is now bridged to both former branch targets.
7. Click the TRIGGER node. Confirm the panel shows no **Delete step** button.
8. Click **Run** (existing `RunPanel`, untouched) on any workflow. Confirm the run completes exactly as it did before this change (proves the backend engine — which never reads `position` — is unaffected).

- [ ] **Step 7: Commit**

```bash
cd "d:/Vertical AI/platform"
git add apps/web/src/features/workflows/components/WorkflowCanvas.tsx \
        "apps/web/src/app/(app)/workflows/[id]/page.tsx"
git rm apps/web/src/features/workflows/components/NodeList.tsx
git commit -m "feat(web): replace the linear workflow step list with a visual React Flow canvas"
```
