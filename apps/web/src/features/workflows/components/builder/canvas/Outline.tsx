'use client';

import { NODE_CATEGORY_META } from '../../../nodeMeta';
import type { WorkflowCanvasNode } from './definitionToFlow';

/**
 * Outline — the accessible, linear reading of the graph (doc 29 §1.1 a11y
 * fallback). The canvas is a `role="application"` spatial surface; screen-reader
 * and keyboard users get this ordered list of the same steps. Collapsed by
 * default so it never competes with the canvas visually, but always in the DOM.
 */
export function Outline({ nodes }: { nodes: WorkflowCanvasNode[] }) {
  return (
    <details className="mt-3 rounded-xl border border-wf-hairline bg-void-card">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-wf-ink-2 hover:text-wf-ink">
        Steps outline ({nodes.length})
      </summary>
      {nodes.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-wf-ink-3">This workflow has no steps yet.</p>
      ) : (
        <ol className="space-y-1 px-4 pb-3">
          {nodes.map((n, i) => (
            <li key={n.id} className="flex items-baseline gap-2 text-sm">
              <span className="text-wf-ink-3 tabular-nums">{i + 1}.</span>
              <span className="font-medium text-wf-ink">{n.data.title}</span>
              <span className="text-xs text-wf-ink-3">
                {NODE_CATEGORY_META[n.data.category].label}
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
