import dagre from 'dagre';
import type { NodeCategory } from '@vaep/types';

/**
 * Canvas layout: run dagre **left-to-right** (n8n-style, per the approved dark
 * restyle) once per load — rank gap 90 (horizontal breathing room between wide
 * cards) / node gap 40 (vertical gap within a rank). Pure + deterministic (no
 * wall clock, no randomness), so the same graph always lays out identically and
 * the mapping is unit-testable.
 *
 * A persisted `node.position` wins; today most nodes carry none, so they are
 * dagre-seeded.
 */

const RANK_SEP = 90;
const NODE_SEP = 40;

/** Approximate on-screen size per category — only used to space dagre ranks. */
export function nodeSize(category: NodeCategory): { width: number; height: number } {
  switch (category) {
    case 'AI_EMPLOYEE':
      return { width: 240, height: 96 };
    case 'TRIGGER':
      return { width: 200, height: 64 };
    case 'LOGIC':
      return { width: 184, height: 72 };
    case 'VARIABLE':
    case 'DATABASE':
    case 'UTILITY':
      return { width: 184, height: 56 };
    default:
      return { width: 216, height: 80 };
  }
}

export interface LayoutInput {
  id: string;
  category: NodeCategory;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

/**
 * Position every node with dagre. Returns a map of id → top-left {x,y} (dagre
 * gives centre coordinates; we shift by half-size so React Flow's top-left
 * origin lines up).
 */
export function layoutGraph(
  nodes: LayoutInput[],
  edges: LayoutEdge[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: RANK_SEP, nodesep: NODE_SEP });
  g.setDefaultEdgeLabel(() => ({}));

  const sizes = new Map<string, { width: number; height: number }>();
  for (const n of nodes) {
    const size = nodeSize(n.category);
    sizes.set(n.id, size);
    g.setNode(n.id, size);
  }
  for (const e of edges) {
    // Only lay out edges whose endpoints both exist (defensive against dangling).
    if (sizes.has(e.source) && sizes.has(e.target)) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const point = g.node(n.id);
    const size = sizes.get(n.id)!;
    // dagre may return undefined for a node with no edges in some versions; fall
    // back to origin so it still renders rather than crashing.
    positions.set(n.id, {
      x: (point?.x ?? 0) - size.width / 2,
      y: (point?.y ?? 0) - size.height / 2,
    });
  }
  return positions;
}
