import { createContext } from 'react';

/**
 * Per-node canvas actions, provided by the canvas (edit mode) via context so the
 * memoized node card can offer a hover toolbar + context menu without threading
 * handlers through `data` (which would break memoization on every render).
 *
 * ONE set of actions serves BOTH the manual builder and the AI Assist canvas —
 * doc 30 AD-30-10 ("one canvas, one node system, one CRUD set"). Adding an
 * action here makes it appear in both surfaces automatically; that is the point.
 */
export interface NodeActions {
  /** Select the node and focus the Inspector on it. */
  onOpen: (id: string) => void;
  /**
   * Begin inline rename. Held on the canvas (not in the card) so BOTH entry
   * points — the context menu and the Space shortcut — drive the same state.
   */
  onRename: (id: string) => void;
  renamingNodeId: string | null;
  /** Commit an inline rename; empty/unchanged input cancels. */
  onRenameCommit: (id: string, name: string) => void;
  /** Toggle `WorkflowNode.disabled` — the engine SKIPS a disabled node. */
  onToggleDisabled: (id: string) => void;
  /** Copy the node (and its config) to the internal clipboard. */
  onCopy: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  /** Re-run the dagre auto-layout over the whole graph and save. */
  onTidyUp: () => void;
}

export const NodeActionsContext = createContext<NodeActions | null>(null);
