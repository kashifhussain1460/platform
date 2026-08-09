import type { NodeType } from '@vaep/types';

/**
 * The MVP node vocabulary the assist agent is allowed to author — the "frozen
 * 17" from `docs/architecture/workflow-system/26-mvp-node-contract-freeze.md` §3.
 *
 * ⚠️ Three different counts exist and get confused (doc 99 warns about this):
 *   • **26** — the canonical `NodeType` union in doc 00 §0.7.1
 *   • **19** — what the shipped `NODE_CATALOG` / `GET /workflows/node-definitions` covers
 *   • **17** — frozen for MVP authoring. **THIS is what the agent may use.**
 *
 * Why it matters (G32): the older `POST /workflows/generate` prompt lists only
 * the legacy 8 types, two of which — `AI_STEP` and `NOTIFY` — are OUTSIDE the
 * frozen 17. So the one feature that writes graphs FOR users writes them in the
 * deprecated dialect, and `NOTIFY` in particular is a trap: per doc 27 §0.4 it
 * only writes a log line, so a workflow built on it *looks* like it messages
 * people and silently doesn't. The assist must not repeat that.
 */
export const FROZEN_NODE_TYPES: readonly NodeType[] = [
  'TRIGGER',
  'AI_EMPLOYEE_STEP',
  'CONDITION',
  'SWITCH',
  'LOOP',
  'PARALLEL',
  'JOIN',
  'WAIT',
  'TERMINATE',
  'SET_VARIABLE',
  'TRANSFORM',
  'RETRIEVE',
  'MEMORY_READ',
  'MEMORY_WRITE',
  'APPROVAL',
  'TOOL_ACTION',
  'NOOP',
] as const;

const FROZEN = new Set<string>(FROZEN_NODE_TYPES);

export function isFrozenNodeType(type: string): type is NodeType {
  return FROZEN.has(type);
}

/**
 * The two substitutions a model gets wrong most often, stated as replacements
 * rather than bans — "don't use X" alone leaves it guessing what to use instead.
 */
export const BANNED_WITH_REPLACEMENT: Record<string, string> = {
  AI_STEP:
    'AI_EMPLOYEE_STEP (bound to a real hired employee) — AI_STEP is retired',
  NOTIFY:
    "TOOL_ACTION with a real messaging skill (gmail/slack) — NOTIFY only writes a log line, it does NOT message anyone",
};

/** Human-readable rejection message for a node the agent may not author. */
export function rejectionFor(type: string): string {
  const replacement = BANNED_WITH_REPLACEMENT[type];
  if (replacement) {
    return `Node type "${type}" is not available. Use ${replacement}.`;
  }
  return `Node type "${type}" is not available. Choose one of: ${FROZEN_NODE_TYPES.join(', ')}.`;
}
