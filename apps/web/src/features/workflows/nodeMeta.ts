import type { NodeCategory, NodeType } from '@vaep/types';

/**
 * The client visual language for node categories (doc 29 §1). Pairs the backend's
 * `NodeDefinitionDto.category` (from GET /workflows/node-definitions) with the
 * Tailwind `cat-*` tone tokens + a lucide icon name + a user-side palette label.
 *
 * Pure data — no React, no icon imports (the node card resolves the icon), so it
 * is the single source of truth the palette, node cards, and inspector all read.
 * Saturation encodes "how much a human should care": AI Employees + Approvals are
 * the warmest; machinery decays toward slate.
 */
export interface NodeCategoryMeta {
  /** User-side section name in the palette (never the enum). */
  label: string;
  /** The `cat-*` colour token (used as `text-{tone}` / `border-{tone}` / `bg-{tone}/…`). */
  tone: string;
  /** lucide-react icon name; resolved to a component by the node card. */
  icon: string;
}

export const NODE_CATEGORY_META: Record<NodeCategory, NodeCategoryMeta> = {
  AI_EMPLOYEE: { label: 'AI Employees', tone: 'cat-employee', icon: 'user-round' },
  TRIGGER: { label: 'Triggers', tone: 'cat-trigger', icon: 'zap' },
  APPROVAL: { label: 'Approvals', tone: 'cat-approval', icon: 'shield-check' },
  SKILL: { label: 'Skills', tone: 'cat-tool', icon: 'wrench' },
  COMMUNICATION: { label: 'Messaging', tone: 'cat-tool', icon: 'message-square' },
  KNOWLEDGE: { label: 'Knowledge', tone: 'cat-knowledge', icon: 'search' },
  MEMORY: { label: 'Memory', tone: 'cat-memory', icon: 'brain' },
  LOGIC: { label: 'Logic', tone: 'cat-logic', icon: 'git-branch' },
  VARIABLE: { label: 'Data', tone: 'cat-data', icon: 'variable' },
  DATABASE: { label: 'Data', tone: 'cat-data', icon: 'database' },
  EXTERNAL_API: { label: 'External', tone: 'cat-tool', icon: 'globe' },
  UTILITY: { label: 'Utility', tone: 'cat-util', icon: 'clock' },
};

/**
 * Palette section order — the two things a manager cares about (their AI Employees
 * and the human approval gates) lead; control-flow machinery trails.
 */
export const NODE_CATEGORY_ORDER: NodeCategory[] = [
  'AI_EMPLOYEE',
  'TRIGGER',
  'APPROVAL',
  'SKILL',
  'COMMUNICATION',
  'KNOWLEDGE',
  'MEMORY',
  'LOGIC',
  'VARIABLE',
  'DATABASE',
  'EXTERNAL_API',
  'UTILITY',
];

/**
 * The one node the whole builder is built around (doc 29): `AI_EMPLOYEE_STEP`
 * renders as a *person*, categorically unlike every other (quiet-instrument) node.
 */
export const SIGNATURE_NODE_TYPE: NodeType = 'AI_EMPLOYEE_STEP';
