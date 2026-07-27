# Visual (node-based) workflow builder — design

## Goal

Replace the current linear, list-based workflow step editor
(`apps/web/src/features/workflows/components/NodeList.tsx`) with a visual,
drag-and-drop, node-based canvas (n8n/Zapier-style), so branching logic and
overall flow shape are visible at a glance instead of buried in a vertical
list with text badges for branches.

**Hard constraints (from the user):**
- **Full replace** — no "switch between list/canvas view" toggle; the linear
  list goes away entirely.
- **Functionality must not change** — every existing capability (add step,
  reorder, delete with branch-loss warning, edit config, CONDITION
  true/false branching, save with optimistic-concurrency `expectedUpdatedAt`,
  warnings banner) must keep working exactly as it does today.
- **Minimize code changes** — reuse existing components/hooks wherever
  possible instead of rewriting them.

## Why this is (almost) a frontend-only change

`Workflow.definition` is stored as a Prisma `Json` column
(`apps/api/prisma/schema.prisma`) — schema-less at the DB level. The backend
`WorkflowEngine` only reads `node.type`/`node.config`/edge `from`/`to`/`branch`
to execute a run; it does not care about any other fields on a node. Adding
node layout data requires **zero database migration** — just one new optional
field on the shared TypeScript type.

## 1. Data model change

`packages/types/src/index.ts` — add one optional field to `WorkflowNode`:

```ts
export interface WorkflowNode {
  id: string;
  type: NodeType;
  name?: string;
  config: Record<string, unknown>;
  position?: { x: number; y: number };  // NEW — canvas layout only, engine ignores it
}
```

No other shared-type changes. No backend code changes at all — `WorkflowEngine`,
validation, and every existing e2e/unit test for workflows are unaffected.

## 2. Canvas architecture

- New dependencies in `apps/web`: `@xyflow/react` (React Flow — the library
  n8n itself is built on: pan/zoom/drag/connect handled out of the box) and
  `dagre` (small, standard auto-layout algorithm for positioning nodes that
  have no saved `position` yet).
- New component `apps/web/src/features/workflows/components/WorkflowCanvas.tsx`
  replaces `NodeList.tsx` as a **drop-in swap** — same props (`{ workflow:
  WorkflowDto }`), same call site in the parent workflow-detail page.
- A single reusable React Flow custom node type ("WorkflowNodeCard") renders
  every `NodeType` — icon/color continue to come from the existing
  `labels.ts` (`NODE_ICONS`, `NODE_TONES`, `NODE_LABELS`, `NODE_HINTS`); no
  new styling system.
- Handles: TRIGGER has an output only (it's the graph root, pinned, no
  delete button — same as today). CONDITION has two labeled output handles
  ("Yes" / "No"). Every other node type has one input + one output handle.
- Clicking a node opens a right-side panel containing the **existing
  `NodeEditor.tsx` form unchanged** — only its mounting location moves (out
  of an inline list-item, into the panel). No form-logic rewrite.

## 3. Editing & save flow (behavior parity)

- Canvas state lives in React Flow's own `useNodesState`/`useEdgesState`
  hooks — same shape of state management as today's `useState<WorkflowNode[]>`
  / `useState<WorkflowEdge[]>`, just via React Flow's wrapper.
- Save button is unchanged: same `useUpdateWorkflow` mutation, same
  `expectedUpdatedAt` concurrency check (409 on a conflicting concurrent
  edit) — the only difference is each node's payload now also carries
  `position`.
- "Add step": a toolbar `+` (same type-picker dropdown as today) drops a new
  node at the canvas center; the user can then drag it wherever they want.
- Branching: dragging a connection from a CONDITION node's "Yes"/"No" handle
  to a target node **replaces** the current "+ Add Yes/No path" button —
  same resulting edge shape (`{ from, to, branch: 'true' | 'false' }`), just
  authored via a drag gesture instead of a click, which was the actual UX
  goal.

## 4. Existing workflows & edge cases (functionality parity)

- **Auto-layout for legacy data**: any workflow opened that has nodes with no
  `position` gets a computed top-to-bottom `dagre` layout on load. Saving
  persists those computed positions, so the layout is stable on next open.
- **Delete node**: keeps today's exact bridging logic (predecessor(s) wired
  to successor(s) so removing a middle node doesn't leave a dangling chain)
  and the existing `window.confirm` warning when deleting a CONDITION node
  that has both Yes and No branches wired (deleting it would silently drop
  one branch's steps) — same safety net, now with the added benefit that the
  disconnection is also visible on the canvas before the user confirms.
- **TRIGGER node**: no delete button, always present, always the graph's
  root — same as today, additionally always placed at the top of the
  auto-layout.
- Warnings banner and Save success/error messaging render the same as today,
  above/around the canvas instead of above the list.

## 5. Testing plan

- No backend test changes — behavior is untouched, so all existing
  workflow e2e/unit suites keep passing unmodified.
- Frontend: port the existing `NodeList`/`NodeEditor`-level test cases (add
  step, delete-with-branch-warning, save payload shape) to exercise
  `WorkflowCanvas` instead.
- Manual verification: create a new workflow, drag/connect/save on the
  canvas, reload and confirm positions + edges persisted; open a pre-existing
  (position-less) workflow and confirm auto-layout renders sensibly; run a
  workflow end-to-end and confirm the backend executes identically to before
  (this is the most important check — proves "functionality unchanged").

## Explicitly out of scope (not requested)

- Visualizing a workflow *run* on the canvas (highlighting the currently
  executing/failed node) — today's separate run-log panel (`RunSteps.tsx`)
  is untouched; could be a natural follow-up but wasn't asked for here.
- Any change to `GenerateWorkflowChat.tsx` (AI-drafted workflows) beyond the
  fact that their resulting definition now also renders through the new
  canvas with auto-layout, same as any other position-less workflow.
