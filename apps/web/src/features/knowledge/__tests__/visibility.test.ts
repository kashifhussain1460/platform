import { describe, expect, it } from 'vitest';
import {
  isUnchosen,
  isWidening,
  toCategory,
  visibilityHelp,
  UNCHOSEN,
} from '../visibility';

/**
 * Document visibility.
 *
 * The bug being guarded is silent: the API models "shared with everyone" as an
 * ABSENT category, so "I never touched the dropdown" and "publish this to the
 * whole company" collapse into the same value. An HR salary band uploaded on the
 * global page then became readable by the Sales and Marketing AI Employees, with
 * nothing anywhere saying so.
 */
describe('toCategory', () => {
  it('maps a role to itself', () => {
    expect(toCategory('HR')).toBe('HR');
  });

  it('maps SHARED to undefined — the API’s "everyone" value', () => {
    expect(toCategory('SHARED')).toBeUndefined();
  });

  it('maps UNCHOSEN to undefined too, which is exactly why uploads are blocked', () => {
    // Both collapse to the same wire value, so the UI must never let an
    // unchosen upload through — `isUnchosen` is the only thing separating them.
    expect(toCategory(UNCHOSEN)).toBeUndefined();
    expect(isUnchosen(UNCHOSEN)).toBe(true);
    expect(isUnchosen('SHARED')).toBe(false);
  });
});

describe('isWidening', () => {
  it('is true when moving from a role to Shared', () => {
    expect(isWidening('HR', 'SHARED')).toBe(true);
  });

  it('is FALSE when narrowing — that can never expose anything', () => {
    // Confirming both directions would train people to click through the
    // prompt that actually matters.
    expect(isWidening('SHARED', 'HR')).toBe(false);
  });

  it('is false between two roles', () => {
    expect(isWidening('HR', 'SALES')).toBe(false);
  });

  it('is false from unchosen — that is the first decision, not a widening', () => {
    expect(isWidening(UNCHOSEN, 'SHARED')).toBe(false);
  });
});

describe('visibilityHelp', () => {
  it('names who can read it, not the scope', () => {
    // "HR" tells an admin nothing about the risk.
    expect(visibilityHelp('HR')).toMatch(/only hr ai employees can read/i);
    expect(visibilityHelp('SHARED')).toMatch(/every ai employee/i);
  });

  it('asks for a decision when nothing is chosen', () => {
    expect(visibilityHelp(UNCHOSEN)).toMatch(/choose who can read/i);
  });
});
