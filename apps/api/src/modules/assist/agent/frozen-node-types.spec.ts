import { NODE_TYPES } from '@vaep/types';
import {
  BANNED_WITH_REPLACEMENT,
  FROZEN_NODE_TYPES,
  isFrozenNodeType,
  rejectionFor,
} from './frozen-node-types';

describe('frozen node vocabulary (doc 26 §3 / G32)', () => {
  it('is exactly 17 types', () => {
    expect(FROZEN_NODE_TYPES).toHaveLength(17);
    expect(new Set(FROZEN_NODE_TYPES).size).toBe(17);
  });

  it('is a strict subset of the canonical NodeType union', () => {
    // Guards against a typo silently creating a type the engine cannot run.
    for (const type of FROZEN_NODE_TYPES) {
      expect(NODE_TYPES).toContain(type);
    }
  });

  it('excludes the two retired types the old generator still writes', () => {
    // The heart of G32: `/workflows/generate` prompts for AI_STEP and NOTIFY,
    // both outside the frozen set. The assist must never author them.
    expect(isFrozenNodeType('AI_STEP')).toBe(false);
    expect(isFrozenNodeType('NOTIFY')).toBe(false);
  });

  it('accepts the replacements for those two', () => {
    expect(isFrozenNodeType('AI_EMPLOYEE_STEP')).toBe(true);
    expect(isFrozenNodeType('TOOL_ACTION')).toBe(true);
  });

  it('excludes every other non-frozen canonical type', () => {
    for (const type of ['SUB_WORKFLOW', 'HTTP_REQUEST', 'DB_QUERY', 'AI_DECISION']) {
      expect(isFrozenNodeType(type)).toBe(false);
    }
  });

  it('tells the model what to use INSTEAD, not just what is banned', () => {
    // "Don't use X" alone leaves a model guessing; the replacement is the fix.
    expect(rejectionFor('AI_STEP')).toContain('AI_EMPLOYEE_STEP');
    expect(rejectionFor('NOTIFY')).toContain('TOOL_ACTION');
    // And the NOTIFY message must explain WHY, since it looks like it works.
    expect(BANNED_WITH_REPLACEMENT.NOTIFY).toMatch(/does NOT message anyone/i);
  });

  it('falls back to listing the allowed set for an unknown type', () => {
    const message = rejectionFor('TELEPORT');
    expect(message).toContain('TELEPORT');
    expect(message).toContain('AI_EMPLOYEE_STEP');
  });
});
